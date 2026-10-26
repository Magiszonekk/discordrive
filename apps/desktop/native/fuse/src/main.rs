// ddn-fuse: the desktop app's disk in the system on Linux. A FUSE file system mounted as the user (through
// the system's fusermount3, no libfuse, no root) whose every answer comes from the app's agent over a Unix
// socket: the tree from the agent's index, file bytes as ranges the agent reads (fragments from Discord,
// decrypted there, kept in its cache). This process sees no key and makes no network request.
//
//   ddn-fuse <mountpoint> <socket>
//
// Protocol (one connection, one request at a time): request = u32 LE length + JSON; answer = u32 LE length
// + JSON + u32 LE length + bytes (read data, else empty). JSON answers carry {"err":"ENOENT"|"EIO"|…} on
// failure. Requests: {"op":"list","id"}, {"op":"stat","id"}, {"op":"read","id","off","len"},
// {"op":"statfs"}. The root's id is "root". This first version is read-only.

use fuser::{FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(1);
const ROOT: u64 = 1;

#[derive(Deserialize, Clone)]
struct Entry {
    id: String,
    name: String,
    /// "file" | "folder"
    kind: String,
    #[serde(default)]
    size: u64,
    /// ms since the epoch (when the content was made, else written)
    #[serde(default)]
    mtime: u64,
}

struct Agent {
    s: UnixStream,
    mountpoint: String,
}

impl Agent {
    /// The agent is gone (its socket closed): nothing can be answered any more. Unmount (lazily: a file
    /// manager may hold the directory) and exit, so the next start of the app mounts afresh instead of
    /// finding a mount that answers EIO to everything.
    fn gone(&self) -> ! {
        eprintln!("ddn-fuse: the agent closed the connection: unmounting");
        let _ = std::process::Command::new("fusermount3").args(["-u", "-z", &self.mountpoint]).status();
        std::process::exit(5);
    }
}

impl Agent {
    fn call(&mut self, q: serde_json::Value) -> Result<(serde_json::Value, Vec<u8>), i32> {
        let body = serde_json::to_vec(&q).map_err(|_| libc::EIO)?;
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&body);
        if self.s.write_all(&out).is_err() {
            self.gone();
        }
        let mut n = [0u8; 4];
        if self.s.read_exact(&mut n).is_err() {
            self.gone();
        }
        let mut j = vec![0u8; u32::from_le_bytes(n) as usize];
        if self.s.read_exact(&mut j).is_err() || self.s.read_exact(&mut n).is_err() {
            self.gone();
        }
        let mut d = vec![0u8; u32::from_le_bytes(n) as usize];
        if self.s.read_exact(&mut d).is_err() {
            self.gone();
        }
        let v: serde_json::Value = serde_json::from_slice(&j).map_err(|_| libc::EIO)?;
        if let Some(e) = v.get("err").and_then(|x| x.as_str()) {
            return Err(match e {
                "ENOENT" => libc::ENOENT,
                "ENOTDIR" => libc::ENOTDIR,
                "EACCES" => libc::EACCES,
                "EAGAIN" => libc::EAGAIN,
                "EEXIST" => libc::EEXIST,
                "EINVAL" => libc::EINVAL,
                "EISDIR" => libc::EISDIR,
                "ENOTEMPTY" => libc::ENOTEMPTY,
                "ENOSPC" => libc::ENOSPC,
                _ => libc::EIO,
            });
        }
        Ok((v, d))
    }
}

struct Fs {
    agent: Agent,
    uid: u32,
    gid: u32,
    /// inode ↔ node ID, stable while mounted (inos shared with the invalidation thread).
    ids: HashMap<u64, String>,
    inos: std::sync::Arc<std::sync::Mutex<HashMap<String, u64>>>,
    next: u64,
    /// The last listing of each folder (lookup asks it again after TTL).
    lists: HashMap<u64, (Instant, Vec<Entry>)>,
    /// Set by the invalidation thread: listings older than this are asked again.
    stale_after: std::sync::Arc<std::sync::Mutex<Instant>>,
    /// What each inode was when last seen (getattr between listings).
    attrs: HashMap<u64, Entry>,
    /// The folder each inode was listed in (where a written file goes back to).
    parents: HashMap<u64, u64>,
    /// truncate(2) by path before an open (how the kernel sends O_TRUNC): the size the next open starts at.
    truncated: HashMap<u64, u64>,
    /// Files being written: handle → the local copy (in the agent's outbox), where it goes, whether written.
    open_w: HashMap<u64, Writing>,
    next_fh: u64,
    /// The outbox directory (local copies of files written into the disk until they are uploaded).
    outbox: Option<std::path::PathBuf>,
}

struct Writing {
    file: std::fs::File,
    path: std::path::PathBuf,
    ino: u64,
    parent: u64,
    name: String,
    dirty: bool,
    /// Unlinked while open, never uploaded: dropped at close.
    gone: bool,
}

impl Fs {
    /// A local copy for a file opened for writing: empty (new file, O_TRUNC) or the current content.
    fn start_write(&mut self, ino: u64, parent: u64, name: &str, from: Option<&str>, size: u64) -> Result<u64, i32> {
        let dir = self.outbox.clone().ok_or(libc::EROFS)?;
        let fh = self.next_fh;
        self.next_fh += 1;
        let path = dir.join(format!("w-{}-{fh}", std::process::id()));
        let mut f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path).map_err(|_| libc::EIO)?;
        if let Some(id) = from {
            // The current content first (an editor writing a part of the file keeps the rest).
            let mut off = 0u64;
            while off < size {
                let len = (size - off).min(8 << 20);
                let (_, d) = self.agent.call(json!({ "op": "read", "id": id, "off": off, "len": len }))?;
                if d.is_empty() {
                    break;
                }
                f.write_all(&d).map_err(|_| libc::EIO)?;
                off += d.len() as u64;
            }
        }
        self.open_w.insert(fh, Writing { file: f, path, ino, parent, name: name.to_string(), dirty: from.is_none(), gone: false });
        Ok(fh)
    }

    /// Upload a written file's local copy (when it changed since the last upload); the copy is kept until
    /// the handle is released (a program may write again after a flush).
    fn upload(&mut self, fh: u64) -> Result<(), i32> {
        let Some(w) = self.open_w.get_mut(&fh) else { return Ok(()) };
        if !w.dirty || w.gone {
            return Ok(());
        }
        let _ = w.file.sync_all();
        let (path, parent, name, ino) = (w.path.clone(), w.parent, w.name.clone(), w.ino);
        // What the file shows from now on: the local copy's mtime (kept by the queue and the upload).
        let copy_mtime = w.file.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
        if let (Some(mt), Some(e)) = (copy_mtime, self.attrs.get_mut(&ino)) {
            e.mtime = mt;
        }
        // The agent removes the copy it uploaded: hand it a hard link (this one stays for later writes).
        let sent = path.with_extension("up");
        std::fs::hard_link(&path, &sent).map_err(|_| libc::EIO)?;
        let dir = self.id(parent).ok_or(libc::ENOENT)?;
        let r = self.agent.call(json!({ "op": "upload", "dir": dir, "name": name, "path": sent.to_string_lossy() }));
        let _ = std::fs::remove_file(&sent);
        let (v, _) = r?;
        if let Some(w) = self.open_w.get_mut(&fh) {
            w.dirty = false;
        }
        // The node the upload made (or the existing one with a new version) for this inode.
        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            self.ids.insert(ino, id.to_string());
            self.inos.lock().unwrap().insert(id.to_string(), ino);
            if let Some(e) = self.attrs.get_mut(&ino) {
                e.id = id.to_string();
            }
        }
        self.forget_lists();
        Ok(())
    }

    /// A file open for writing under `name` in `parent` (it exists for the kernel before it is uploaded:
    /// editors rename their temporary file over the original before closing it).
    fn writer(&self, parent: u64, name: &str) -> Option<(u64, u64)> {
        self.open_w.iter().find(|(_, w)| !w.gone && w.parent == parent && w.name == name).map(|(h, w)| (*h, w.ino))
    }

    /// Not in the account or the upload queue yet (created here and never closed).
    fn local_only(&self, ino: u64) -> bool {
        self.attrs.get(&ino).map(|e| e.id.starts_with("new:")).unwrap_or(false)
    }

    fn forget_lists(&mut self) {
        self.lists.clear();
    }

    fn ino(&mut self, id: &str) -> u64 {
        if id == "root" {
            return ROOT;
        }
        let mut inos = self.inos.lock().unwrap();
        if let Some(i) = inos.get(id).copied() {
            // (An uploaded file takes over the inode of its queued copy: the inode's node ID follows.)
            if self.ids.get(&i).map(|x| x != id).unwrap_or(true) {
                self.ids.insert(i, id.to_string());
            }
            return i;
        }
        let i = self.next;
        self.next += 1;
        self.ids.insert(i, id.to_string());
        inos.insert(id.to_string(), i);
        i
    }

    fn id(&self, ino: u64) -> Option<String> {
        if ino == ROOT {
            Some("root".into())
        } else {
            self.ids.get(&ino).cloned()
        }
    }

    fn attr(&self, ino: u64, e: &Entry) -> FileAttr {
        let dir = e.kind == "folder";
        let t = UNIX_EPOCH + Duration::from_millis(e.mtime);
        FileAttr {
            ino,
            size: if dir { 0 } else { e.size },
            blocks: if dir { 0 } else { e.size.div_ceil(512) },
            atime: t,
            mtime: t,
            ctime: t,
            crtime: t,
            kind: if dir { FileType::Directory } else { FileType::RegularFile },
            perm: match (dir, self.outbox.is_some()) {
                (true, true) => 0o755,
                (true, false) => 0o555,
                (false, true) => 0o644,
                (false, false) => 0o444,
            },
            nlink: if dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            flags: 0,
            blksize: 1 << 20,
        }
    }

    fn root_entry() -> Entry {
        Entry { id: "root".into(), name: String::new(), kind: "folder".into(), size: 0, mtime: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }
    }

    fn list(&mut self, ino: u64) -> Result<Vec<Entry>, i32> {
        if let Some((at, l)) = self.lists.get(&ino) {
            if at.elapsed() < TTL && *at > *self.stale_after.lock().unwrap() {
                return Ok(l.clone());
            }
        }
        let id = self.id(ino).ok_or(libc::ENOENT)?;
        let (v, _) = self.agent.call(json!({ "op": "list", "id": id }))?;
        let l: Vec<Entry> = serde_json::from_value(v.get("entries").cloned().unwrap_or(json!([]))).map_err(|_| libc::EIO)?;
        for e in &l {
            let i = self.ino(&e.id);
            self.attrs.insert(i, e.clone());
            self.parents.insert(i, ino);
        }
        self.lists.insert(ino, (Instant::now(), l.clone()));
        Ok(l)
    }
}

impl Filesystem for Fs {
    fn lookup(&mut self, _r: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let n = name.to_string_lossy();
        if let Some(e) = self.writer(parent, &n).and_then(|(_, ino)| self.attrs.get(&ino).cloned().map(|e| (ino, e))) {
            let a = self.attr(e.0, &e.1);
            return reply.entry(&TTL, &a, 0);
        }
        match self.list(parent) {
            Ok(l) => match l.iter().find(|e| e.name == n) {
                Some(e) => {
                    let i = self.ino(&e.id);
                    let a = self.attr(i, e);
                    reply.entry(&TTL, &a, 0)
                }
                None => reply.error(libc::ENOENT),
            },
            Err(e) => reply.error(e),
        }
    }

    fn getattr(&mut self, _r: &Request, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        if ino == ROOT {
            // The root's mtime from the agent (when something in it changed), else now.
            let e = self.agent.call(json!({ "op": "stat", "id": "root" })).ok().and_then(|(v, _)| serde_json::from_value::<Entry>(v.get("entry").cloned().unwrap_or(json!(null))).ok()).unwrap_or_else(Fs::root_entry);
            let a = self.attr(ROOT, &e);
            return reply.attr(&TTL, &a);
        }
        if let Some(e) = self.attrs.get(&ino).cloned().filter(|e| e.kind != "folder") {
            let a = self.attr(ino, &e);
            return reply.attr(&TTL, &a);
        }
        let Some(id) = self.id(ino) else { return reply.error(libc::ENOENT) };
        match self.agent.call(json!({ "op": "stat", "id": id })) {
            Ok((v, _)) => match serde_json::from_value::<Entry>(v.get("entry").cloned().unwrap_or(json!(null))) {
                Ok(e) => {
                    self.attrs.insert(ino, e.clone());
                    let a = self.attr(ino, &e);
                    reply.attr(&TTL, &a)
                }
                Err(_) => reply.error(libc::EIO),
            },
            Err(e) => reply.error(e),
        }
    }

    fn open(&mut self, r: &Request, ino: u64, flags: i32, reply: ReplyOpen) {
        if flags & libc::O_ACCMODE != libc::O_RDONLY {
            if self.outbox.is_none() {
                return reply.error(libc::EROFS);
            }
            let Some(e) = self.attrs.get(&ino).cloned() else { return reply.error(libc::ENOENT) };
            let parent = self.parents.get(&ino).copied().unwrap_or(ROOT);
            let size = if flags & libc::O_TRUNC != 0 { 0 } else { self.truncated.remove(&ino).unwrap_or(e.size).min(e.size) };
            return match self.start_write(ino, parent, &e.name, if size == 0 { None } else { Some(&e.id) }, size) {
                Ok(fh) => reply.opened(fh, fuser::consts::FOPEN_DIRECT_IO),
                Err(err) => reply.error(err),
            };
        }
        // The desktop's thumbnailers would download whole files to make what the agent already wrote from
        // the stored previews (or marked as "none"): refused, so a folder opened in the file manager costs
        // no download. Anything else (the user opening a file) reads as usual.
        if is_thumbnailer(r.pid()) {
            return reply.error(libc::EACCES);
        }
        if self.id(ino).is_none() {
            return reply.error(libc::ENOENT);
        }
        // The page cache keeps what was read while the file is unchanged (the next open asks getattr).
        reply.opened(0, fuser::consts::FOPEN_KEEP_CACHE)
    }

    fn read(&mut self, _r: &Request, ino: u64, fh: u64, offset: i64, size: u32, _f: i32, _l: Option<u64>, reply: ReplyData) {
        // A file being written reads its local copy.
        if let Some(w) = self.open_w.get_mut(&fh) {
            use std::io::{Seek, SeekFrom};
            let mut b = vec![0u8; size as usize];
            let n = w.file.seek(SeekFrom::Start(offset.max(0) as u64)).and_then(|_| w.file.read(&mut b)).unwrap_or(0);
            return reply.data(&b[..n]);
        }
        let Some(id) = self.id(ino) else { return reply.error(libc::ENOENT) };
        let total = self.attrs.get(&ino).map(|e| e.size).unwrap_or(u64::MAX);
        let off = offset.max(0) as u64;
        if off >= total {
            return reply.data(&[]);
        }
        let len = (size as u64).min(total - off);
        match self.agent.call(json!({ "op": "read", "id": id, "off": off, "len": len })) {
            Ok((_, d)) => reply.data(&d),
            Err(e) => reply.error(e),
        }
    }

    fn readdir(&mut self, _r: &Request, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        let l = match self.list(ino) {
            Ok(l) => l,
            Err(e) => return reply.error(e),
        };
        let mut all: Vec<(u64, FileType, String)> = vec![(ino, FileType::Directory, ".".into()), (ROOT, FileType::Directory, "..".into())];
        for e in &l {
            let i = self.ino(&e.id);
            all.push((i, if e.kind == "folder" { FileType::Directory } else { FileType::RegularFile }, e.name.clone()));
        }
        // Files being written here that the account does not have yet.
        let mut extra: Vec<(u64, String)> = self.open_w.values().filter(|w| !w.gone && w.parent == ino && !l.iter().any(|e| e.name == w.name)).map(|w| (w.ino, w.name.clone())).collect();
        extra.sort();
        extra.dedup_by(|a, b| a.1 == b.1);
        all.extend(extra.into_iter().map(|(i, n)| (i, FileType::RegularFile, n)));
        for (k, (i, t, n)) in all.iter().enumerate().skip(offset as usize) {
            if reply.add(*i, (k + 1) as i64, *t, n) {
                break;
            }
        }
        reply.ok()
    }

    fn create(&mut self, _r: &Request, parent: u64, name: &OsStr, _mode: u32, _umask: u32, _flags: i32, reply: ReplyCreate) {
        let Some(n) = name.to_str().map(str::to_string) else { return reply.error(libc::EINVAL) };
        // A placeholder entry until the upload ends (the agent gives the node ID then).
        let ino = self.next;
        self.next += 1;
        match self.start_write(ino, parent, &n, None, 0) {
            Ok(fh) => {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                let e = Entry { id: format!("new:{fh}"), name: n, kind: "file".into(), size: 0, mtime: now };
                self.ids.insert(ino, e.id.clone());
                self.attrs.insert(ino, e.clone());
                self.parents.insert(ino, parent);
                let mut a = self.attr(ino, &e);
                a.perm = 0o644;
                reply.created(&TTL, &a, 0, fh, fuser::consts::FOPEN_DIRECT_IO)
            }
            Err(e) => reply.error(e),
        }
    }

    fn write(&mut self, _r: &Request, ino: u64, fh: u64, offset: i64, data: &[u8], _wf: u32, _f: i32, _l: Option<u64>, reply: ReplyWrite) {
        use std::io::{Seek, SeekFrom};
        let Some(w) = self.open_w.get_mut(&fh) else { return reply.error(libc::EBADF) };
        if w.file.seek(SeekFrom::Start(offset.max(0) as u64)).and_then(|_| w.file.write_all(data)).is_err() {
            return reply.error(libc::ENOSPC);
        }
        w.dirty = true;
        let len = w.file.metadata().map(|m| m.len()).unwrap_or(0);
        if let Some(e) = self.attrs.get_mut(&ino) {
            e.size = len;
        }
        reply.written(data.len() as u32)
    }

    fn setattr(&mut self, _r: &Request, ino: u64, _mode: Option<u32>, _uid: Option<u32>, _gid: Option<u32>, size: Option<u64>, _a: Option<TimeOrNow>, m: Option<TimeOrNow>, _c: Option<SystemTime>, fh: Option<u64>, _cr: Option<SystemTime>, _ch: Option<SystemTime>, _bk: Option<SystemTime>, _fl: Option<u32>, reply: ReplyAttr) {
        // truncate(2) on an open file (an editor saving): its local copy.
        // (The kernel may send it without the handle: the open copy of that inode then.)
        let h = fh.filter(|h| self.open_w.contains_key(h)).or_else(|| self.open_w.iter().find(|(_, w)| w.ino == ino).map(|(h, _)| *h));
        if let (Some(sz), Some(w)) = (size, h.and_then(|h| self.open_w.get_mut(&h))) {
            if w.file.set_len(sz).is_err() {
                return reply.error(libc::EIO);
            }
            w.dirty = true;
            if let Some(e) = self.attrs.get_mut(&ino) {
                e.size = sz;
            }
        } else if let Some(sz) = size {
            if self.outbox.is_none() {
                return reply.error(libc::EROFS);
            }
            self.truncated.insert(ino, sz);
            if let Some(e) = self.attrs.get_mut(&ino) {
                e.size = e.size.min(sz);
            }
        }
        // The modification time (cp -p, rsync -t, touch -d): the file's content date. Kept for a file being
        // written (its local copy) or waiting in the upload queue (the queued copy): the upload stores it. A file
        // already in the account keeps its date (a version's date is part of the version).
        // ("Now", as a write or a plain touch sets it, changes nothing: the file shows when it was written.)
        if let Some(TimeOrNow::SpecificTime(t)) = m {
            let ms = t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let h = fh.filter(|h| self.open_w.contains_key(h)).or_else(|| self.open_w.iter().find(|(_, w)| w.ino == ino).map(|(h, _)| *h));
            // The open local copy (a later upload reads it) and, once closed, the copy in the queue (the handle
            // may outlive the close: its release comes later). Only a copy that is uploaded keeps it: one written
            // here, or a file not in the account yet. A file of the account opened without a write (touch opens
            // it for writing) keeps its date: a version's date is part of the version, and a new version just
            // for a date would upload the whole file again.
            let in_account = self.attrs.get(&ino).map(|e| !e.id.starts_with("new:") && !e.id.starts_with("out:")).unwrap_or(false);
            let mut kept = h.and_then(|h| self.open_w.get_mut(&h)).filter(|w| w.dirty || !in_account).map(|w| w.file.set_modified(t).is_ok()).unwrap_or(false);
            if let Some(id) = self.attrs.get(&ino).map(|e| e.id.clone()).filter(|id| id.starts_with("out:")) {
                kept |= self.agent.call(json!({ "op": "touch", "id": id, "mtime": ms })).is_ok();
            }
            if kept {
                if let Some(e) = self.attrs.get_mut(&ino) {
                    e.mtime = ms;
                }
                self.forget_lists();
            }
        }
        // Modes are not kept; answer what the file is.
        match self.attrs.get(&ino).cloned() {
            Some(e) => {
                let a = self.attr(ino, &e);
                reply.attr(&TTL, &a)
            }
            None if ino == ROOT => {
                let a = self.attr(ROOT, &Fs::root_entry());
                reply.attr(&TTL, &a)
            }
            None => reply.error(libc::ENOENT),
        }
    }

    /// close(2) of a written file: the agent uploads its local copy now (a new file, or a new version), so
    /// `cp` ends when the file is in the account and a failure is the close's error. (release comes after
    /// close returned: too late for either.)
    /// fsync: the data is in the local copy (uploaded at close); editors check that it succeeds.
    fn fsync(&mut self, _r: &Request, _ino: u64, fh: u64, _ds: bool, reply: ReplyEmpty) {
        if let Some(w) = self.open_w.get_mut(&fh) {
            let _ = w.file.sync_data();
        }
        reply.ok()
    }

    fn flush(&mut self, _r: &Request, _ino: u64, fh: u64, _lo: u64, reply: ReplyEmpty) {
        match self.upload(fh) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn release(&mut self, _r: &Request, _ino: u64, fh: u64, _f: i32, _lo: Option<u64>, _fl: bool, reply: ReplyEmpty) {
        let _ = self.upload(fh);
        if let Some(w) = self.open_w.remove(&fh) {
            let _ = std::fs::remove_file(&w.path);
        }
        reply.ok()
    }

    fn mkdir(&mut self, _r: &Request, parent: u64, name: &OsStr, _mode: u32, _umask: u32, reply: ReplyEntry) {
        if self.outbox.is_none() {
            return reply.error(libc::EROFS);
        }
        let Some(dir) = self.id(parent) else { return reply.error(libc::ENOENT) };
        // The desktop's trash folder at the top of the disk (gio trash, "Move to Trash") is refused: the file
        // manager then offers to delete, which puts the file into the account's trash. A .Trash-1000 folder
        // would be synced to every device as a normal folder.
        if parent == ROOT && name.to_string_lossy().starts_with(".Trash") {
            return reply.error(libc::EPERM);
        }
        // Names that are not UTF-8 are refused (the account's names are Unicode; a lossy one would differ).
        let Some(n) = name.to_str().map(str::to_string) else { return reply.error(libc::EINVAL) };
        match self.agent.call(json!({ "op": "mkdir", "dir": dir, "name": n })) {
            Ok((v, _)) => {
                let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                let e = Entry { id: id.clone(), name: n, kind: "folder".into(), size: 0, mtime: now };
                let i = self.ino(&id);
                self.attrs.insert(i, e.clone());
                self.forget_lists();
                let a = self.attr(i, &e);
                reply.entry(&TTL, &a, 0)
            }
            Err(e) => reply.error(e),
        }
    }

    fn unlink(&mut self, _r: &Request, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        self.remove(parent, name, false, reply)
    }

    fn rmdir(&mut self, _r: &Request, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        self.remove(parent, name, true, reply)
    }

    fn rename(&mut self, _r: &Request, parent: u64, name: &OsStr, newparent: u64, newname: &OsStr, _flags: u32, reply: ReplyEmpty) {
        if self.outbox.is_none() {
            return reply.error(libc::EROFS);
        }
        let (Some(dir), Some(to)) = (self.id(parent), self.id(newparent)) else { return reply.error(libc::ENOENT) };
        let (Some(src), Some(dst)) = (name.to_str(), newname.to_str()) else { return reply.error(libc::EINVAL) };
        if newparent == ROOT && dst.starts_with(".Trash") {
            return reply.error(libc::EPERM);
        }
        // A file still open for writing goes to its new name at close (an editor's save: the temporary file
        // renamed over the original, then closed = a new version of the original). When it is only here
        // (never closed), nothing to tell the agent.
        let hits: Vec<(u64, u64)> = self.open_w.iter().filter(|(_, w)| !w.gone && w.parent == parent && w.name == src).map(|(h, w)| (*h, w.ino)).collect();
        let only_here = !hits.is_empty() && hits.iter().all(|(_, ino)| self.local_only(*ino));
        for (h, ino) in &hits {
            if let Some(w) = self.open_w.get_mut(h) {
                w.parent = newparent;
                w.name = dst.to_string();
            }
            if let Some(e) = self.attrs.get_mut(ino) {
                e.name = dst.to_string();
            }
            self.parents.insert(*ino, newparent);
        }
        if only_here {
            // Another open writer of the target name (rare) is left as it is; the newer close wins.
            self.forget_lists();
            return reply.ok();
        }
        match self.agent.call(json!({ "op": "rename", "dir": dir, "name": name.to_string_lossy(), "toDir": to, "toName": newname.to_string_lossy() })) {
            Ok(_) => {
                self.forget_lists();
                reply.ok()
            }
            Err(e) => reply.error(e),
        }
    }

    fn statfs(&mut self, _r: &Request, _ino: u64, reply: ReplyStatfs) {
        // Free = what the agent's cache may still take (a file manager shows something sensible).
        let (blocks, free) = match self.agent.call(json!({ "op": "statfs" })) {
            Ok((v, _)) => (v.get("total").and_then(|x| x.as_u64()).unwrap_or(0) / 4096, v.get("free").and_then(|x| x.as_u64()).unwrap_or(0) / 4096),
            Err(_) => (0, 0),
        };
        reply.statfs(blocks, free, free, 0, 0, 4096, 255, 4096)
    }
}

impl Fs {
    fn remove(&mut self, parent: u64, name: &OsStr, folder: bool, reply: ReplyEmpty) {
        if self.outbox.is_none() {
            return reply.error(libc::EROFS);
        }
        let Some(dir) = self.id(parent) else { return reply.error(libc::ENOENT) };
        let n = name.to_string_lossy().to_string();
        if !folder {
            // Open for writing and never closed: dropped at close (nothing uploaded).
            if let Some((h, ino)) = self.writer(parent, &n) {
                if self.local_only(ino) {
                    if let Some(w) = self.open_w.get_mut(&h) {
                        w.gone = true;
                    }
                    self.forget_lists();
                    return reply.ok();
                }
            }
        } else {
            // A folder with a file being written in it is not empty.
            let child = self.list(parent).ok().and_then(|l| l.into_iter().find(|e| e.name == n));
            if let Some(c) = child {
                let ci = self.ino(&c.id);
                if self.open_w.values().any(|w| !w.gone && w.parent == ci) {
                    return reply.error(libc::ENOTEMPTY);
                }
            }
        }
        match self.agent.call(json!({ "op": "remove", "dir": dir, "name": name.to_string_lossy(), "folder": folder })) {
            Ok(_) => {
                self.forget_lists();
                reply.ok()
            }
            Err(e) => reply.error(e),
        }
    }
}

static MOUNTPOINT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Programs the desktop runs to make thumbnails: the freedesktop thumbnailers registered on this system
/// (/usr/share/thumbnailers/*.thumbnailer, Exec=), and the usual ones.
fn thumbnailers() -> &'static std::collections::HashSet<String> {
    static T: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut t: std::collections::HashSet<String> = ["gnome-thumbnail-factory", "tumblerd", "ffmpegthumbnailer", "totem-video-thumbnailer", "gdk-pixbuf-thumbnailer", "evince-thumbnailer"].iter().map(|s| s.to_string()).collect();
        for dir in ["/usr/share/thumbnailers", "/usr/local/share/thumbnailers"] {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                for line in std::fs::read_to_string(e.path()).unwrap_or_default().lines() {
                    if let Some(x) = line.strip_prefix("Exec=") {
                        if let Some(cmd) = x.split_whitespace().next() {
                            t.insert(cmd.rsplit('/').next().unwrap_or(cmd).to_string());
                        }
                    }
                }
            }
        }
        t
    })
}

/// A process that makes thumbnails for the desktop (GNOME / KDE / XFCE), or one started by such a process
/// (GNOME runs its thumbnailers under bwrap from gnome-thumbnail-factory).
fn is_thumbnailer(pid: u32) -> bool {
    let exe = |p: u32| std::fs::read_link(format!("/proc/{p}/exe")).ok().and_then(|x| x.file_name().map(|n| n.to_string_lossy().trim_end_matches(" (deleted)").to_string())).unwrap_or_default();
    let argv0 = |p: u32| std::fs::read(format!("/proc/{p}/cmdline")).ok().and_then(|c| c.split(|b| *b == 0).next().map(|a| String::from_utf8_lossy(a).rsplit('/').next().unwrap_or("").to_string())).unwrap_or_default();
    let parent = |p: u32| -> u32 {
        std::fs::read_to_string(format!("/proc/{p}/stat"))
            .ok()
            .and_then(|s| s.rsplit_once(')').map(|(_, r)| r.to_string()))
            .and_then(|r| r.split_whitespace().nth(1).and_then(|x| x.parse().ok()))
            .unwrap_or(0)
    };
    let known = thumbnailers();
    let mut p = pid;
    for _ in 0..5 {
        if p <= 1 {
            return false;
        }
        let (e, a) = (exe(p), argv0(p));
        if known.contains(&e) || known.contains(&a) || (a == "kioworker" || e == "kioworker") && is_kio_thumb(p) {
            return true;
        }
        p = parent(p);
    }
    false
}

/// KDE's thumbnail worker (kioworker thumbnail ...).
fn is_kio_thumb(pid: u32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).map(|c| String::from_utf8_lossy(&c).contains("thumbnail")).unwrap_or(false)
}

extern "C" fn on_term(_: libc::c_int) {
    if let Some(mp) = MOUNTPOINT.get() {
        let _ = std::process::Command::new("fusermount3").args(["-u", "-z", mp]).status();
    }
    std::process::exit(0);
}

/// `ddn-fuse thumb <max>`: an image on stdin (WebP, JPEG or PNG) to a PNG on stdout whose longer side is
/// at most <max> pixels (never enlarged). The agent adds the freedesktop tEXt chunks.
fn thumb(max: u32) -> ! {
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        std::process::exit(2);
    }
    let img = match image::load_from_memory(&input) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("ddn-fuse thumb: {e}");
            std::process::exit(3);
        }
    };
    let (w, h) = (img.width(), img.height());
    let img = if w.max(h) > max { img.resize(max, max, image::imageops::FilterType::Triangle) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    if img.to_rgba8().write_to(&mut out, image::ImageFormat::Png).is_err() {
        std::process::exit(4);
    }
    let _ = std::io::stdout().write_all(out.get_ref());
    std::process::exit(0);
}

/// `ddn-fuse preview`: a picture on stdin (JPEG, PNG, WebP; a video frame the agent got from ffmpeg) to the
/// account's thumbnail and preview, both JPEG, turned as its EXIF says: on stdout, for each,
/// u32 LE width, height, length, bytes. Sizes as the web client: thumbnail with the shorter side 320 px
/// (the longer at most 640), preview with the longer side 1280 px, never enlarged, within their byte limits.
fn preview() -> ! {
    use image::ImageDecoder;
    let mut input = Vec::new();
    if std::io::stdin().take(80 << 20).read_to_end(&mut input).is_err() {
        std::process::exit(2);
    }
    let fail = |c: i32, e: &dyn std::fmt::Display| -> ! {
        eprintln!("ddn-fuse preview: {e}");
        std::process::exit(c)
    };
    let rd = image::ImageReader::new(std::io::Cursor::new(&input)).with_guessed_format().unwrap_or_else(|e| fail(3, &e));
    let mut dec = rd.into_decoder().unwrap_or_else(|e| fail(3, &e));
    let (w0, h0) = dec.dimensions();
    // Larger ones are not decoded (a 100 MP scan would need ~400 MB of pixels), as the web client.
    if (w0 as u64) * (h0 as u64) > 80_000_000 {
        fail(5, &"too many pixels");
    }
    let o = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(dec).unwrap_or_else(|e| fail(3, &e));
    img.apply_orientation(o);
    let (w, h) = (img.width(), img.height());
    let mut out = std::io::stdout();
    for (kind, max_bytes) in [("t", 48 * 1024usize), ("p", 400 * 1024usize)] {
        let s = if kind == "t" {
            let s = 320.0 / w.min(h) as f64;
            if w.max(h) as f64 * s > 640.0 { 640.0 / w.max(h) as f64 } else { s }
        } else {
            1280.0 / w.max(h) as f64
        }
        .min(1.0);
        let (mut tw, mut th) = (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1));
        let mut done = None;
        'fit: for _ in 0..4 {
            let r = img.resize_exact(tw, th, image::imageops::FilterType::CatmullRom).to_rgb8();
            for q in [80u8, 65, 50] {
                let mut b = Vec::new();
                if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut b, q).encode_image(&r).is_ok() && b.len() <= max_bytes {
                    done = Some((tw, th, b));
                    break 'fit;
                }
            }
            tw = ((tw as f64 * 0.75).round() as u32).max(1);
            th = ((th as f64 * 0.75).round() as u32).max(1);
        }
        let (tw, th, b) = done.unwrap_or((0, 0, Vec::new()));
        for x in [tw, th, b.len() as u32] {
            let _ = out.write_all(&x.to_le_bytes());
        }
        let _ = out.write_all(&b);
    }
    std::process::exit(0);
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() == 3 && a[1] == "thumb" {
        thumb(a[2].parse().unwrap_or(256));
    }
    if a.len() == 2 && a[1] == "preview" {
        preview();
    }
    if a.len() != 3 {
        eprintln!("usage: ddn-fuse <mountpoint> <socket>");
        std::process::exit(2);
    }
    let s = match UnixStream::connect(&a[2]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ddn-fuse: cannot reach the agent at {}: {e}", a[2]);
            std::process::exit(3);
        }
    };
    // SIGTERM (the app stopping a helper it did not start itself): unmount like a gone agent.
    unsafe {
        libc::signal(libc::SIGTERM, on_term as *const () as usize);
    }
    MOUNTPOINT.set(a[1].clone()).ok();
    let inos = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
    let stale_after = std::sync::Arc::new(std::sync::Mutex::new(Instant::now()));
    // A second connection, from the agent to here: invalidations after a sync (u32 LE length + JSON
    // {"inval":"all"} or {"inval":[node IDs]}), and when the agent dies the socket closes and the read
    // returns, even while no request is in flight (the kernel answers from its caches meanwhile).
    let watch = match UnixStream::connect(&a[2]) {
        Ok(mut w) => {
            // Tell the agent which connection this is.
            let hello = br#"{"op":"watch"}"#;
            let mut m = (hello.len() as u32).to_le_bytes().to_vec();
            m.extend_from_slice(hello);
            let _ = w.write_all(&m);
            Some(w)
        }
        Err(e) => {
            eprintln!("ddn-fuse: no watch connection: {e}");
            None
        }
    };
    let fs = Fs {
        agent: Agent { s, mountpoint: a[1].clone() },
        uid: unsafe { libc::getuid() },
        gid: unsafe { libc::getgid() },
        ids: HashMap::new(),
        inos: inos.clone(),
        next: 2,
        lists: HashMap::new(),
        stale_after: stale_after.clone(),
        attrs: HashMap::new(),
        open_w: HashMap::new(),
        parents: HashMap::new(),
        truncated: HashMap::new(),
        next_fh: 1,
        // Writable when the agent gives an outbox (DDN_FUSE_OUTBOX); read-only otherwise.
        outbox: std::env::var_os("DDN_FUSE_OUTBOX").map(std::path::PathBuf::from).filter(|p| p.is_dir()),
    };
    let writable = std::env::var_os("DDN_FUSE_OUTBOX").is_some();
    let mut opts = vec![MountOption::FSName("discordrive".into()), MountOption::Subtype(std::env::var("DDN_FUSE_SUBTYPE").unwrap_or_else(|_| "discordrive".into())), MountOption::DefaultPermissions, MountOption::NoExec, MountOption::NoAtime];
    if !writable {
        opts.push(MountOption::RO);
    }
    let mut session = match fuser::Session::new(fs, &a[1], &opts) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ddn-fuse: mount failed: {e}");
            std::process::exit(4);
        }
    };
    let notifier = session.notifier();
    if let Some(mut w) = watch {
        let mp = a[1].clone();
        std::thread::spawn(move || {
            loop {
                let mut n = [0u8; 4];
                if w.read_exact(&mut n).is_err() {
                    break;
                }
                let mut j = vec![0u8; u32::from_le_bytes(n) as usize];
                if w.read_exact(&mut j).is_err() {
                    break;
                }
                let Ok(v) = serde_json::from_slice::<serde_json::Value>(&j) else { continue };
                // The kernel drops what it cached for these inodes (attributes, directory pages, file pages):
                // a file changed on another device is read afresh, a folder lists its new children.
                *stale_after.lock().unwrap() = Instant::now();
                // A queued copy uploaded: the account's node keeps the copy's inode (editors compare it).
                if let Some(serde_json::Value::Array(pairs)) = v.get("alias") {
                    let mut map = inos.lock().unwrap();
                    for p in pairs {
                        let (Some(from), Some(to)) = (p.get(0).and_then(|x| x.as_str()), p.get(1).and_then(|x| x.as_str())) else { continue };
                        if let Some(i) = map.get(from).copied() {
                            map.insert(to.to_string(), i);
                        }
                    }
                }
                let ino_of = |id: &str| -> Option<u64> { if id == "root" { Some(ROOT) } else { inos.lock().unwrap().get(id).copied() } };
                // Names that changed in a folder: the kernel forgets the entries (a new name is looked up
                // again; a removed one reports a deletion to inotify watchers, a file manager refreshes).
                if let Some(serde_json::Value::Array(dirs)) = v.get("names") {
                    for d in dirs {
                        let Some(parent) = d.get("dir").and_then(|x| x.as_str()).and_then(ino_of) else { continue };
                        for n in d.get("added").and_then(|x| x.as_array()).into_iter().flatten().filter_map(|x| x.as_str()) {
                            let _ = notifier.inval_entry(parent, OsStr::new(n));
                        }
                        for r in d.get("removed").and_then(|x| x.as_array()).into_iter().flatten() {
                            let (Some(n), Some(child)) = (r.get("name").and_then(|x| x.as_str()), r.get("id").and_then(|x| x.as_str()).and_then(ino_of)) else { continue };
                            if notifier.delete(parent, child, OsStr::new(n)).is_err() {
                                let _ = notifier.inval_entry(parent, OsStr::new(n));
                            }
                        }
                        let _ = notifier.inval_inode(parent, 0, 0);
                    }
                }
                let targets: Vec<u64> = {
                    let map = inos.lock().unwrap();
                    match v.get("inval") {
                        Some(serde_json::Value::String(s)) if s == "all" => map.values().copied().chain(std::iter::once(ROOT)).collect(),
                        Some(serde_json::Value::Array(ids)) => ids.iter().filter_map(|x| x.as_str()).filter_map(|id| if id == "root" { Some(ROOT) } else { map.get(id).copied() }).collect(),
                        _ => vec![],
                    }
                };
                for ino in targets {
                    let _ = notifier.inval_inode(ino, 0, 0);
                }
            }
            eprintln!("ddn-fuse: the agent is gone: unmounting");
            let _ = std::process::Command::new("fusermount3").args(["-u", "-z", &mp]).status();
            std::process::exit(5);
        });
    }
    if let Err(e) = session.run() {
        eprintln!("ddn-fuse: {e}");
        std::process::exit(6);
    }
}
