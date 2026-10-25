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

use fuser::{FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry, ReplyOpen, ReplyStatfs, Request};
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
    /// inode ↔ node ID, stable while mounted.
    ids: HashMap<u64, String>,
    inos: HashMap<String, u64>,
    next: u64,
    /// The last listing of each folder (lookup asks it again after TTL).
    lists: HashMap<u64, (Instant, Vec<Entry>)>,
    /// What each inode was when last seen (getattr between listings).
    attrs: HashMap<u64, Entry>,
}

impl Fs {
    fn ino(&mut self, id: &str) -> u64 {
        if id == "root" {
            return ROOT;
        }
        if let Some(i) = self.inos.get(id) {
            return *i;
        }
        let i = self.next;
        self.next += 1;
        self.ids.insert(i, id.to_string());
        self.inos.insert(id.to_string(), i);
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
            perm: if dir { 0o555 } else { 0o444 },
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
            if at.elapsed() < TTL {
                return Ok(l.clone());
            }
        }
        let id = self.id(ino).ok_or(libc::ENOENT)?;
        let (v, _) = self.agent.call(json!({ "op": "list", "id": id }))?;
        let l: Vec<Entry> = serde_json::from_value(v.get("entries").cloned().unwrap_or(json!([]))).map_err(|_| libc::EIO)?;
        for e in &l {
            let i = self.ino(&e.id);
            self.attrs.insert(i, e.clone());
        }
        self.lists.insert(ino, (Instant::now(), l.clone()));
        Ok(l)
    }
}

impl Filesystem for Fs {
    fn lookup(&mut self, _r: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let n = name.to_string_lossy();
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
            let a = self.attr(ROOT, &Fs::root_entry());
            return reply.attr(&TTL, &a);
        }
        if let Some(e) = self.attrs.get(&ino).cloned() {
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

    fn open(&mut self, _r: &Request, ino: u64, flags: i32, reply: ReplyOpen) {
        if flags & libc::O_ACCMODE != libc::O_RDONLY {
            return reply.error(libc::EROFS);
        }
        if self.id(ino).is_none() {
            return reply.error(libc::ENOENT);
        }
        // The page cache keeps what was read while the file is unchanged (the next open asks getattr).
        reply.opened(0, fuser::consts::FOPEN_KEEP_CACHE)
    }

    fn read(&mut self, _r: &Request, ino: u64, _fh: u64, offset: i64, size: u32, _f: i32, _l: Option<u64>, reply: ReplyData) {
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
        for (k, (i, t, n)) in all.iter().enumerate().skip(offset as usize) {
            if reply.add(*i, (k + 1) as i64, *t, n) {
                break;
            }
        }
        reply.ok()
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

static MOUNTPOINT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

extern "C" fn on_term(_: libc::c_int) {
    if let Some(mp) = MOUNTPOINT.get() {
        let _ = std::process::Command::new("fusermount3").args(["-u", "-z", mp]).status();
    }
    std::process::exit(0);
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
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
        libc::signal(libc::SIGTERM, on_term as usize);
    }
    MOUNTPOINT.set(a[1].clone()).ok();
    // A second connection that carries nothing: when the agent dies the socket closes and the read below
    // returns, even while no request is in flight (the kernel answers from its caches meanwhile).
    match UnixStream::connect(&a[2]) {
        Ok(mut watch) => {
            let mp = a[1].clone();
            std::thread::spawn(move || {
                let mut b = [0u8; 1];
                loop {
                    match watch.read(&mut b) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => continue,
                    }
                }
                eprintln!("ddn-fuse: the agent is gone: unmounting");
                let _ = std::process::Command::new("fusermount3").args(["-u", "-z", &mp]).status();
                std::process::exit(5);
            });
        }
        Err(e) => eprintln!("ddn-fuse: no watch connection: {e}"),
    }
    let fs = Fs {
        agent: Agent { s, mountpoint: a[1].clone() },
        uid: unsafe { libc::getuid() },
        gid: unsafe { libc::getgid() },
        ids: HashMap::new(),
        inos: HashMap::new(),
        next: 2,
        lists: HashMap::new(),
        attrs: HashMap::new(),
    };
    let opts = [MountOption::RO, MountOption::FSName("discordrive".into()), MountOption::Subtype("discordrive".into()), MountOption::DefaultPermissions, MountOption::NoExec, MountOption::NoAtime];
    if let Err(e) = fuser::mount2(fs, &a[1], &opts) {
        eprintln!("ddn-fuse: mount failed: {e}");
        std::process::exit(4);
    }
}
