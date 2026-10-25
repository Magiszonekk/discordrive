// The Windows side of ddn-cf (see main.rs). Callbacks of the Cloud Files API run on the system's threads;
// each asks the agent through one of a few pipe connections (the agent answers a connection in order).
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::io::{Read, Write};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use windows::core::{GUID, HSTRING, PCWSTR, PWSTR};
use windows::Storage::Provider::{
    StorageProviderHardlinkPolicy, StorageProviderHydrationPolicy, StorageProviderHydrationPolicyModifier, StorageProviderInSyncPolicy, StorageProviderPopulationPolicy,
    StorageProviderProtectionMode, StorageProviderSyncRootInfo, StorageProviderSyncRootManager,
};
use windows::Storage::StorageFolder;
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, NTSTATUS, STATUS_ACCESS_DENIED, STATUS_CLOUD_FILE_UNSUCCESSFUL, STATUS_SUCCESS};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::CloudFilters::*;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetCompressedFileSizeW, GetFileAttributesW, ReadDirectoryChangesW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_PINNED, FILE_ATTRIBUTE_UNPINNED,
    FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, REG_DWORD};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const PROVIDER_ID: GUID = GUID::from_u128(0x5f0c0a5e_6d1b_4c47_9a3e_d1c5d15c0d01);
/// A file attribute of placeholders (the cloud files reparse point): what the helper made and may remove.
const ATTR_REPARSE: u32 = 0x400;
/// The agent's reads: at most this much per request, and fetched ahead of what a program asked for.
const PIECE: u64 = 1 << 20;
const AHEAD: u64 = 4 << 20;

#[derive(Deserialize, Clone, Debug)]
struct Entry {
    id: String,
    name: String,
    kind: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    mtime: u64,
}

// ── the agent ──

struct Agent {
    pipe: std::fs::File,
}

impl Agent {
    fn connect(path: &str, token: &str) -> std::io::Result<Agent> {
        let mut last = None;
        // The agent's pipe may be busy creating its next instance: a few tries.
        for _ in 0..50 {
            match std::fs::OpenOptions::new().read(true).write(true).open(path) {
                Ok(f) => {
                    let mut a = Agent { pipe: f };
                    a.call(json!({ "op": "hello", "token": token })).map_err(|_| std::io::Error::other("refused"))?;
                    return Ok(a);
                }
                Err(e) => last = Some(e),
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(last.unwrap())
    }

    fn send(&mut self, q: &Value) -> std::io::Result<()> {
        let body = serde_json::to_vec(q)?;
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&body);
        self.pipe.write_all(&out)
    }

    fn frame(&mut self) -> std::io::Result<Vec<u8>> {
        let mut n = [0u8; 4];
        self.pipe.read_exact(&mut n)?;
        let mut b = vec![0u8; u32::from_le_bytes(n) as usize];
        self.pipe.read_exact(&mut b)?;
        Ok(b)
    }

    /// One request; Err(message) for an answer with an error. The agent gone: the helper ends.
    fn call(&mut self, q: Value) -> Result<(Value, Vec<u8>), String> {
        if self.send(&q).is_err() {
            gone();
        }
        let (j, d) = match (self.frame(), self.frame()) {
            (Ok(j), Ok(d)) => (j, d),
            _ => gone(),
        };
        let v: Value = serde_json::from_slice(&j).map_err(|e| e.to_string())?;
        if let Some(e) = v.get("err").and_then(|x| x.as_str()) {
            return Err(e.to_string());
        }
        Ok((v, d))
    }
}

fn gone() -> ! {
    eprintln!("ddn-cf: the agent closed the connection");
    if let Some(s) = STATE.get() {
        unsafe {
            let _ = CfDisconnectSyncRoot(CF_CONNECTION_KEY(*s.key.lock().unwrap()));
        }
    }
    std::process::exit(5);
}

struct State {
    root: PathBuf,
    pool: Vec<Mutex<Agent>>,
    key: Mutex<i64>,
    /// Folders filled so far: node ID → path (what a sync compares with the account).
    dirs: Mutex<HashMap<String, PathBuf>>,
    /// What each placeholder was made from: path → (node ID, size, mtime).
    made: Mutex<HashMap<PathBuf, (String, u64, u64)>>,
    /// Placeholders this helper is removing (its own deletes are not refused).
    removing: Mutex<HashSet<String>>,
    dirty: AtomicBool,
    /// Something was fetched: the cache limit is checked a moment later.
    dirty_cache: AtomicBool,
    /// When each file was last read (path → ms): the least recently read go first when over the limit.
    used: Mutex<HashMap<PathBuf, u64>>,
    /// Bytes of unpinned files kept on this computer at most (Settings, the disk's cache).
    limit: std::sync::atomic::AtomicU64,
}

static STATE: OnceLock<State> = OnceLock::new();

fn st() -> &'static State {
    STATE.get().expect("state")
}

/// A free connection to the agent (else the first one, waiting for it).
fn agent<T>(f: impl FnOnce(&mut Agent) -> T) -> T {
    let s = st();
    for m in &s.pool {
        if let Ok(mut a) = m.try_lock() {
            return f(&mut a);
        }
    }
    let mut a = s.pool[0].lock().unwrap();
    f(&mut a)
}

fn list(id: &str) -> Result<Vec<Entry>, String> {
    let (v, _) = agent(|a| a.call(json!({ "op": "list", "id": id })))?;
    serde_json::from_value(v.get("entries").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())
}

// ── names and times ──

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(p: &Path) -> Vec<u16> {
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// The name a file of the account shows under on Windows: the characters Windows does not allow in a name
/// shown as their full-width look-alikes; a name Windows cannot have at all (a device name, a trailing dot
/// or space) is not shown (None).
fn win_name(n: &str) -> Option<String> {
    let m: String = n
        .chars()
        .map(|c| match c {
            '\\' => '＼',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '＂',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            c if (c as u32) < 32 => '�',
            c => c,
        })
        .collect();
    if m.ends_with('.') || m.ends_with(' ') {
        return None;
    }
    let stem = m.split('.').next().unwrap_or("").to_ascii_uppercase();
    const DEV: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if DEV.contains(&stem.as_str()) {
        return None;
    }
    Some(m)
}

/// ms since 1970 → 100 ns since 1601.
fn filetime(ms: u64) -> i64 {
    ((ms as i64) + 11_644_473_600_000) * 10_000
}

fn meta(e: &Entry) -> CF_FS_METADATA {
    let t = filetime(e.mtime);
    CF_FS_METADATA {
        BasicInfo: FILE_BASIC_INFO {
            CreationTime: t,
            LastAccessTime: t,
            LastWriteTime: t,
            ChangeTime: t,
            FileAttributes: if e.kind == "folder" { FILE_ATTRIBUTE_DIRECTORY.0 } else { FILE_ATTRIBUTE_NORMAL.0 },
        },
        FileSize: if e.kind == "folder" { 0 } else { e.size as i64 },
    }
}

/// Placeholders for entries of a folder: the infos plus the buffers they point into (kept alive by the caller).
struct Batch {
    infos: Vec<CF_PLACEHOLDER_CREATE_INFO>,
    _names: Vec<Vec<u16>>,
    _ids: Vec<Vec<u8>>,
    shown: Vec<(String, Entry)>,
}

fn batch(entries: &[Entry]) -> Batch {
    let mut names = Vec::new();
    let mut ids = Vec::new();
    let mut shown = Vec::new();
    for e in entries {
        let Some(n) = win_name(&e.name) else { continue };
        if e.id.len() > 4000 {
            continue;
        }
        names.push(wide(&n));
        ids.push(e.id.as_bytes().to_vec());
        shown.push((n, e.clone()));
    }
    let infos = shown
        .iter()
        .enumerate()
        .map(|(k, (_, e))| CF_PLACEHOLDER_CREATE_INFO {
            RelativeFileName: PCWSTR(names[k].as_ptr()),
            FsMetadata: meta(e),
            FileIdentity: ids[k].as_ptr() as *const c_void,
            FileIdentityLength: ids[k].len() as u32,
            Flags: CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
            Result: windows::core::HRESULT(0),
            CreateUsn: 0,
        })
        .collect();
    Batch { infos, _names: names, _ids: ids, shown }
}

/// Where the helper keeps the list of what it made (for unregister): next to the root, not inside it.
fn made_file(root: &Path) -> PathBuf {
    let mut n = root.as_os_str().to_owned();
    n.push(".ddn-made.json");
    PathBuf::from(n)
}

/// Write the list of what the helper made (paths relative to the root, file sizes; folders 0).
fn save_made() {
    let s = st();
    let list: Vec<(String, u64)> = s
        .made
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(p, (_, size, _))| p.strip_prefix(&s.root).ok().map(|r| (r.to_string_lossy().into_owned(), *size)))
        .collect();
    let _ = std::fs::write(made_file(&s.root), serde_json::to_vec(&list).unwrap_or_default());
}

/// Remember what a folder's placeholders were made from (folders: their path for later fills and syncs).
fn remember(dir: &Path, shown: &[(String, Entry)]) {
    {
    let mut made = st().made.lock().unwrap();
    for (n, e) in shown {
        let p = dir.join(n);
        if e.kind == "folder" {
            // Its own placeholders come when it is opened; until then it is not a filled folder.
            made.insert(p, (e.id.clone(), 0, e.mtime));
        } else {
            made.insert(p, (e.id.clone(), e.size, e.mtime));
        }
    }
    }
    save_made();
}

// ── callbacks ──

unsafe fn identity(info: *const CF_CALLBACK_INFO) -> String {
    let i = &*info;
    if i.FileIdentity.is_null() || i.FileIdentityLength == 0 {
        return "root".into();
    }
    let b = std::slice::from_raw_parts(i.FileIdentity as *const u8, i.FileIdentityLength as usize);
    String::from_utf8_lossy(b).into_owned()
}

unsafe fn op_info(info: *const CF_CALLBACK_INFO, t: CF_OPERATION_TYPE) -> CF_OPERATION_INFO {
    let i = &*info;
    CF_OPERATION_INFO {
        StructSize: size_of::<CF_OPERATION_INFO>() as u32,
        Type: t,
        ConnectionKey: i.ConnectionKey,
        TransferKey: i.TransferKey,
        CorrelationVector: std::ptr::null(),
        SyncStatus: std::ptr::null(),
        RequestKey: i.RequestKey,
    }
}

fn params<T>(u: CF_OPERATION_PARAMETERS_0) -> CF_OPERATION_PARAMETERS {
    CF_OPERATION_PARAMETERS { ParamSize: (offset_of!(CF_OPERATION_PARAMETERS, Anonymous) + size_of::<T>()) as u32, Anonymous: u }
}

/// A folder opened for the first time: its children as placeholders, the folder marked as filled.
unsafe extern "system" fn on_fetch_placeholders(info: *const CF_CALLBACK_INFO, _p: *const CF_CALLBACK_PARAMETERS) {
    let id = identity(info);
    let dir = if id == "root" { Some(st().root.clone()) } else { st().made.lock().unwrap().iter().find(|(_, v)| v.0 == id).map(|(k, _)| k.clone()) };
    let (status, entries) = match (dir.as_ref(), list(&id)) {
        (Some(_), Ok(l)) => (STATUS_SUCCESS, l),
        (_, Err(e)) => {
            eprintln!("ddn-cf: list {id}: {e}");
            (STATUS_CLOUD_FILE_UNSUCCESSFUL, vec![])
        }
        (None, _) => (STATUS_CLOUD_FILE_UNSUCCESSFUL, vec![]),
    };
    let mut b = batch(&entries);
    let n = b.infos.len();
    let oi = op_info(info, CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS);
    let mut op = params::<CF_OPERATION_PARAMETERS_0_4>(CF_OPERATION_PARAMETERS_0 {
        TransferPlaceholders: CF_OPERATION_PARAMETERS_0_4 {
            Flags: CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION,
            CompletionStatus: status,
            PlaceholderTotalCount: n as i64,
            PlaceholderArray: if n > 0 { b.infos.as_mut_ptr() } else { std::ptr::null_mut() },
            PlaceholderCount: n as u32,
            EntriesProcessed: 0,
        },
    });
    if let Err(e) = CfExecute(&oi, &mut op) {
        eprintln!("ddn-cf: transfer placeholders of {id}: {e}");
        return;
    }
    if let (Some(d), true) = (dir, status == STATUS_SUCCESS) {
        remember(&d, &b.shown);
        st().dirs.lock().unwrap().insert(id, d);
    }
}

unsafe fn transfer(info: *const CF_CALLBACK_INFO, status: NTSTATUS, off: i64, data: &[u8], len: i64) -> windows::core::Result<()> {
    let oi = op_info(info, CF_OPERATION_TYPE_TRANSFER_DATA);
    let mut op = params::<CF_OPERATION_PARAMETERS_0_0>(CF_OPERATION_PARAMETERS_0 {
        TransferData: CF_OPERATION_PARAMETERS_0_0 {
            Flags: CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
            CompletionStatus: status,
            Buffer: if data.is_empty() { std::ptr::null() } else { data.as_ptr() as *const c_void },
            Offset: off,
            Length: len,
        },
    });
    CfExecute(&oi, &mut op)
}

/// A program reads a part of a file not here yet: that part (and a little ahead), in pieces, from the agent.
unsafe extern "system" fn on_fetch_data(info: *const CF_CALLBACK_INFO, p: *const CF_CALLBACK_PARAMETERS) {
    let id = identity(info);
    if let Some(path) = full_path(info) {
        st().used.lock().unwrap().insert(path, now_ms());
        st().dirty_cache.store(true, Ordering::SeqCst);
    }
    let f = (*p).Anonymous.FetchData;
    let size = (*info).FileSize.max(0) as u64;
    let off = f.RequiredFileOffset.max(0) as u64;
    let req_end = off + f.RequiredLength.max(0) as u64;
    let opt_end = (f.OptionalFileOffset.max(0) + f.OptionalLength.max(0)) as u64;
    // A little more than asked (a player reads on): up to AHEAD, on 4 KiB boundaries, never past the end.
    let want = req_end.max(opt_end.min(off + AHEAD));
    let end = ((want + 4095) / 4096 * 4096).min(size).max(req_end.min(size));
    let mut o = off;
    while o < end {
        let n = PIECE.min(end - o);
        let r = agent(|a| a.call(json!({ "op": "read", "id": id, "off": o, "len": n })));
        match r {
            Ok((_, d)) if d.len() as u64 == n || (o + d.len() as u64 == size && !d.is_empty()) => {
                if let Err(e) = transfer(info, STATUS_SUCCESS, o as i64, &d, d.len() as i64) {
                    eprintln!("ddn-cf: transfer {id} @{o}: {e}");
                    return;
                }
                o += d.len() as u64;
            }
            other => {
                eprintln!("ddn-cf: read {id} @{o}+{n}: {:?}", other.err());
                // Only the part still owed of what was required (the rest was optional).
                if o < req_end {
                    let _ = transfer(info, STATUS_CLOUD_FILE_UNSUCCESSFUL, o as i64, &[], (req_end - o) as i64);
                }
                return;
            }
        }
    }
}

unsafe extern "system" fn on_cancel(_info: *const CF_CALLBACK_INFO, _p: *const CF_CALLBACK_PARAMETERS) {}

/// Read-only disk: a delete or rename by a program is refused (the helper's own, after a sync, is not).
unsafe extern "system" fn on_delete(info: *const CF_CALLBACK_INFO, _p: *const CF_CALLBACK_PARAMETERS) {
    let id = identity(info);
    let ok = st().removing.lock().unwrap().remove(&id);
    let oi = op_info(info, CF_OPERATION_TYPE_ACK_DELETE);
    let mut op = params::<CF_OPERATION_PARAMETERS_0_7>(CF_OPERATION_PARAMETERS_0 {
        AckDelete: CF_OPERATION_PARAMETERS_0_7 { Flags: CF_OPERATION_ACK_DELETE_FLAG_NONE, CompletionStatus: if ok { STATUS_SUCCESS } else { STATUS_ACCESS_DENIED } },
    });
    let _ = CfExecute(&oi, &mut op);
}

unsafe extern "system" fn on_rename(info: *const CF_CALLBACK_INFO, _p: *const CF_CALLBACK_PARAMETERS) {
    let oi = op_info(info, CF_OPERATION_TYPE_ACK_RENAME);
    let mut op = params::<CF_OPERATION_PARAMETERS_0_6>(CF_OPERATION_PARAMETERS_0 {
        AckRename: CF_OPERATION_PARAMETERS_0_6 { Flags: CF_OPERATION_ACK_RENAME_FLAG_NONE, CompletionStatus: STATUS_ACCESS_DENIED },
    });
    let _ = CfExecute(&oi, &mut op);
}

// ── changes from other devices ──

/// Every filled folder compared with the account: new names get placeholders, gone ones are removed, a
/// file with a new version is emptied (fetched again when read) and gets its new size and date.
fn reconcile() {
    let dirs: Vec<(String, PathBuf)> = st().dirs.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, path) in dirs {
        let Ok(entries) = list(&id) else { continue };
        let b = batch(&entries);
        let want: HashMap<&str, &Entry> = b.shown.iter().map(|(n, e)| (n.as_str(), e)).collect();
        let have: Vec<String> = std::fs::read_dir(&path).map(|r| r.flatten().map(|d| d.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        // Gone: only placeholders this helper made (a file the user put here stays).
        for n in have.iter().filter(|n| !want.contains_key(n.as_str())) {
            let p = path.join(n);
            let Some((nid, _, _)) = st().made.lock().unwrap().get(&p).cloned() else { continue };
            let Ok(m) = std::fs::symlink_metadata(&p) else { continue };
            if m.file_attributes() & ATTR_REPARSE == 0 {
                continue;
            }
            st().removing.lock().unwrap().insert(nid.clone());
            let r = if m.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
            if let Err(e) = r {
                eprintln!("ddn-cf: remove {}: {e}", p.display());
            }
            st().removing.lock().unwrap().remove(&nid);
            st().made.lock().unwrap().retain(|q, _| !q.starts_with(&p));
            st().dirs.lock().unwrap().retain(|_, d| !d.starts_with(&p));
            save_made();
        }
        // New: placeholders now.
        let new: Vec<Entry> = b.shown.iter().filter(|(n, _)| !have.contains(n)).map(|(_, e)| e.clone()).collect();
        if !new.is_empty() {
            let mut nb = batch(&new);
            let w = wide_path(&path);
            match unsafe { CfCreatePlaceholders(PCWSTR(w.as_ptr()), &mut nb.infos, CF_CREATE_FLAG_NONE, None) } {
                Ok(()) => remember(&path, &nb.shown),
                Err(e) => eprintln!("ddn-cf: new placeholders in {}: {e}", path.display()),
            }
        }
        // Changed: a new version (other size or date), or another node under the same name.
        for (n, e) in &b.shown {
            if e.kind == "folder" || !have.contains(n) {
                continue;
            }
            let p = path.join(n);
            let was = st().made.lock().unwrap().get(&p).cloned();
            if was.as_ref().map(|(i, s, m)| (i.as_str(), *s, *m)) == Some((e.id.as_str(), e.size, e.mtime)) || was.is_none() {
                continue;
            }
            if update(&p, e).is_ok() {
                st().made.lock().unwrap().insert(p, (e.id.clone(), e.size, e.mtime));
            }
        }
    }
}

fn update(p: &Path, e: &Entry) -> windows::core::Result<()> {
    let w = wide_path(p);
    unsafe {
        // WRITE_DAC | FILE_READ_ATTRIBUTES: enough for CfUpdatePlaceholder, opens without fetching the data.
        let h: HANDLE = CreateFileW(PCWSTR(w.as_ptr()), 0x0004_0000 | 0x80, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, None)?;
        let m = meta(e);
        let id = e.id.as_bytes();
        let r = CfUpdatePlaceholder(h, Some(&m), Some(id.as_ptr() as *const c_void), id.len() as u32, None, CF_UPDATE_FLAG_DEHYDRATE | CF_UPDATE_FLAG_MARK_IN_SYNC, None, None);
        let _ = CloseHandle(h);
        if let Err(ref x) = r {
            eprintln!("ddn-cf: update {}: {x}", p.display());
        }
        r
    }
}

// ── pin, "Free up space", the limit ──

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The file's full path from a callback (the volume's DOS name + the normalized path).
unsafe fn full_path(info: *const CF_CALLBACK_INFO) -> Option<PathBuf> {
    let i = &*info;
    if i.VolumeDosName.is_null() || i.NormalizedPath.is_null() {
        return None;
    }
    Some(PathBuf::from(format!("{}{}", i.VolumeDosName.to_string().ok()?, i.NormalizedPath.to_string().ok()?)))
}

fn attrs(p: &Path) -> u32 {
    let w = wide_path(p);
    unsafe { GetFileAttributesW(PCWSTR(w.as_ptr())) }
}

/// Bytes of the file on this computer (a placeholder not fetched: 0; partly fetched: what was fetched).
fn on_disk(p: &Path) -> u64 {
    let w = wide_path(p);
    let mut hi = 0u32;
    let lo = unsafe { GetCompressedFileSizeW(PCWSTR(w.as_ptr()), Some(&mut hi)) };
    if lo == u32::MAX {
        return 0;
    }
    ((hi as u64) << 32) | lo as u64
}

fn open_for_cf(p: &Path) -> windows::core::Result<HANDLE> {
    let w = wide_path(p);
    // FILE_READ_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES: what hydrating and dehydrating need.
    unsafe { CreateFileW(PCWSTR(w.as_ptr()), 0x1 | 0x100 | 0x80, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None) }
}

/// "Always keep on this device": the whole file fetched now. "Free up space": its content dropped (it stays
/// listed and is fetched again when opened).
fn pin_changed(p: &Path) {
    let a = attrs(p);
    if a == u32::MAX || a & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        return;
    }
    let h = match open_for_cf(p) {
        Ok(h) => h,
        Err(_) => return,
    };
    unsafe {
        if a & FILE_ATTRIBUTE_PINNED.0 != 0 {
            if let Err(e) = CfHydratePlaceholder(h, 0, -1, CF_HYDRATE_FLAG_NONE, None) {
                eprintln!("ddn-cf: keep {}: {e}", p.display());
            }
        } else if a & FILE_ATTRIBUTE_UNPINNED.0 != 0 {
            match CfDehydratePlaceholder(h, 0, -1, CF_DEHYDRATE_FLAG_NONE, None) {
                // Done: back to "no preference", so the limit treats it like any other file.
                Ok(()) => {
                    let _ = CfSetPinState(h, CF_PIN_STATE_UNSPECIFIED, CF_SET_PIN_FLAG_NONE, None);
                    st().used.lock().unwrap().remove(p);
                }
                Err(e) => eprintln!("ddn-cf: free up {}: {e}", p.display()),
            }
        }
        let _ = CloseHandle(h);
    }
}

/// Over the limit: the content of the least recently read unpinned files is dropped until under it (a file
/// open in a program cannot be: it is left).
fn trim() {
    let limit = st().limit.load(Ordering::SeqCst);
    let files: Vec<PathBuf> = st().made.lock().unwrap().iter().filter(|(_, v)| v.1 > 0).map(|(k, _)| k.clone()).collect();
    let mut held: Vec<(u64, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    let used = st().used.lock().unwrap().clone();
    for p in files {
        let a = attrs(&p);
        if a == u32::MAX || a & FILE_ATTRIBUTE_PINNED.0 != 0 {
            continue;
        }
        let n = on_disk(&p);
        if n == 0 {
            continue;
        }
        total += n;
        held.push((used.get(&p).copied().unwrap_or(0), n, p));
    }
    if total <= limit {
        return;
    }
    held.sort();
    for (_, n, p) in held {
        if total <= limit {
            break;
        }
        let Ok(h) = open_for_cf(&p) else { continue };
        if unsafe { CfDehydratePlaceholder(h, 0, -1, CF_DEHYDRATE_FLAG_NONE, None) }.is_ok() {
            total = total.saturating_sub(n);
            st().used.lock().unwrap().remove(&p);
        }
        unsafe {
            let _ = CloseHandle(h);
        }
    }
}

/// Explorer's pin commands change the files' attributes: watched under the root.
fn watch_pins(root: PathBuf) {
    let w = wide_path(&root);
    let h = match unsafe { CreateFileW(PCWSTR(w.as_ptr()), 0x1, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None) } {
        Ok(h) => h,
        Err(e) => return eprintln!("ddn-cf: cannot watch {}: {e}", root.display()),
    };
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let mut got = 0u32;
        if unsafe { ReadDirectoryChangesW(h, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, true, FILE_NOTIFY_CHANGE_ATTRIBUTES, Some(&mut got), None, None) }.is_err() {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        let mut off = 0usize;
        let mut seen = HashSet::new();
        while got > 0 && off + size_of::<FILE_NOTIFY_INFORMATION>() <= got as usize {
            let fi = unsafe { &*(buf.as_ptr().add(off) as *const FILE_NOTIFY_INFORMATION) };
            let name = unsafe { std::slice::from_raw_parts(fi.FileName.as_ptr(), fi.FileNameLength as usize / 2) };
            seen.insert(root.join(String::from_utf16_lossy(name)));
            if fi.NextEntryOffset == 0 {
                break;
            }
            off += fi.NextEntryOffset as usize;
        }
        for p in seen {
            pin_changed(&p);
        }
    }
}

/// `ddn-cf state <path>`: what a file is on this computer (tests, support): attributes, bytes here, size.
fn print_state(p: &Path) -> i32 {
    let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let a = attrs(p);
    println!("{}", json!({ "attrs": a, "pinned": a != u32::MAX && a & FILE_ATTRIBUTE_PINNED.0 != 0, "onDisk": on_disk(p), "size": size }));
    0
}

// ── the thumbnail provider (ddn-cf-thumb.dll) ──

/// Its CLSID (the same in native/cf-thumb).
const CLSID_THUMB: &str = "{7A3C9E51-2B84-4D1F-A6E0-9C8D2F41B305}";

fn reg_set(root: HKEY, key: &str, name: Option<&str>, value: RegVal) -> Result<(), String> {
    let k = wide(key);
    let mut h = HKEY::default();
    let r = unsafe { RegCreateKeyExW(root, PCWSTR(k.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut h, None) };
    if r.is_err() {
        return Err(format!("{key}: {r:?}"));
    }
    let n = name.map(wide);
    let np = n.as_ref().map(|x| PCWSTR(x.as_ptr())).unwrap_or(PCWSTR::null());
    let r = match value {
        RegVal::Str(v) => {
            let w = wide(&v);
            let bytes = unsafe { std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2) };
            unsafe { RegSetValueExW(h, np, None, REG_SZ, Some(bytes)) }
        }
        RegVal::Dword(v) => unsafe { RegSetValueExW(h, np, None, REG_DWORD, Some(&v.to_le_bytes())) },
    };
    unsafe {
        let _ = RegCloseKey(h);
    }
    if r.is_err() {
        return Err(format!("{key}: {r:?}"));
    }
    Ok(())
}
enum RegVal {
    Str(String),
    Dword(u32),
}

/// The DLL registered as an in-process server for this user (HKCU: no admin rights), named as the sync root's
/// thumbnail provider. The sync root's key is the shell's (HKLM ...\SyncRootManager): written by Register;
/// the ThumbnailProvider value there only where this user may (else the CLSID still serves the files
/// through the per-user association below).
fn register_thumbs(dll: &Path) {
    let clsid = format!("Software\\Classes\\CLSID\\{CLSID_THUMB}");
    let ok = reg_set(HKEY_CURRENT_USER, &clsid, None, RegVal::Str("discordrive thumbnails".into()))
        .and_then(|_| reg_set(HKEY_CURRENT_USER, &format!("{clsid}\\InprocServer32"), None, RegVal::Str(dll.to_string_lossy().into_owned())))
        .and_then(|_| reg_set(HKEY_CURRENT_USER, &format!("{clsid}\\InprocServer32"), Some("ThreadingModel"), RegVal::Str("Apartment".into())))
        // IInitializeWithItem needs the provider outside the shell's isolation.
        .and_then(|_| reg_set(HKEY_CURRENT_USER, &clsid, Some("DisableProcessIsolation"), RegVal::Dword(1)));
    if let Err(e) = ok {
        return eprintln!("ddn-cf: thumbnail provider not registered: {e}");
    }
    let key = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\{}", root_id());
    for hive in [windows::Win32::System::Registry::HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        match reg_set(hive, &key, Some("ThumbnailProvider"), RegVal::Str(CLSID_THUMB.into())) {
            Ok(()) => break,
            Err(e) => eprintln!("ddn-cf: ThumbnailProvider: {e}"),
        }
    }
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}

fn unregister_thumbs() {
    let k = wide(&format!("Software\\Classes\\CLSID\\{CLSID_THUMB}"));
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()));
    }
}

// ── registration ──

fn user_sid() -> String {
    unsafe {
        let mut tok = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok).is_err() {
            return "user".into();
        }
        let mut len = 0u32;
        let _ = GetTokenInformation(tok, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(tok, TokenUser, Some(buf.as_mut_ptr() as *mut c_void), len, &mut len).is_ok();
        let _ = CloseHandle(tok);
        if !ok {
            return "user".into();
        }
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s = PWSTR::null();
        if ConvertSidToStringSidW(tu.User.Sid, &mut s).is_err() {
            return "user".into();
        }
        let out = s.to_string().unwrap_or_else(|_| "user".into());
        let _ = LocalFree(Some(HLOCAL(s.0 as *mut c_void)));
        out
    }
}

fn root_id() -> String {
    format!("discordrive!{}!disk", user_sid())
}

/// The sync root registered for this user (the folder in Explorer's navigation pane). Through the shell's
/// registration (StorageProviderSyncRootManager); where that is not there (a server without the shell
/// parts), the Cloud Files registration alone.
fn register(root: &Path, icon: &str, version: &str) -> Result<&'static str, String> {
    let shell = || -> windows::core::Result<()> {
        let info = StorageProviderSyncRootInfo::new()?;
        info.SetId(&HSTRING::from(root_id()))?;
        let folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(root.as_os_str()))?.get()?;
        info.SetPath(&folder)?;
        info.SetDisplayNameResource(&HSTRING::from("discordrive"))?;
        info.SetIconResource(&HSTRING::from(format!("{icon},0")))?;
        info.SetVersion(&HSTRING::from(version))?;
        info.SetHydrationPolicy(StorageProviderHydrationPolicy::Progressive)?;
        info.SetHydrationPolicyModifier(StorageProviderHydrationPolicyModifier::StreamingAllowed)?;
        info.SetPopulationPolicy(StorageProviderPopulationPolicy::Full)?;
        info.SetInSyncPolicy(StorageProviderInSyncPolicy::Default)?;
        info.SetHardlinkPolicy(StorageProviderHardlinkPolicy::None)?;
        info.SetProtectionMode(StorageProviderProtectionMode::Personal)?;
        info.SetAllowPinning(true)?;
        info.SetProviderId(PROVIDER_ID)?;
        StorageProviderSyncRootManager::Register(&info)
    };
    match shell() {
        Ok(()) => return Ok("shell"),
        Err(e) => eprintln!("ddn-cf: shell registration: {e}; the Cloud Files registration instead"),
    }
    let name = wide("discordrive");
    let ver = wide(version);
    let rid = root_id();
    let fid = b"root";
    let reg = CF_SYNC_REGISTRATION {
        StructSize: size_of::<CF_SYNC_REGISTRATION>() as u32,
        ProviderName: PCWSTR(name.as_ptr()),
        ProviderVersion: PCWSTR(ver.as_ptr()),
        SyncRootIdentity: rid.as_ptr() as *const c_void,
        SyncRootIdentityLength: rid.len() as u32,
        FileIdentity: fid.as_ptr() as *const c_void,
        FileIdentityLength: fid.len() as u32,
        ProviderId: PROVIDER_ID,
    };
    let pol = CF_SYNC_POLICIES {
        StructSize: size_of::<CF_SYNC_POLICIES>() as u32,
        Hydration: CF_HYDRATION_POLICY { Primary: CF_HYDRATION_POLICY_PROGRESSIVE, Modifier: CF_HYDRATION_POLICY_MODIFIER_STREAMING_ALLOWED },
        Population: CF_POPULATION_POLICY { Primary: CF_POPULATION_POLICY_FULL, Modifier: CF_POPULATION_POLICY_MODIFIER_NONE },
        InSync: CF_INSYNC_POLICY_NONE,
        HardLink: CF_HARDLINK_POLICY_NONE,
        PlaceholderManagement: CF_PLACEHOLDER_MANAGEMENT_POLICY_DEFAULT,
    };
    let w = wide_path(root);
    unsafe { CfRegisterSyncRoot(PCWSTR(w.as_ptr()), &reg, &pol, CF_REGISTER_FLAG_UPDATE) }.map_err(|e| e.to_string())?;
    Ok("cloud-files")
}

/// Take the sync root down; the placeholders it made go too (files the user put in the folder stay).
fn unregister(root: &Path) -> i32 {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    // What the helper made (written while serving): removed after the registration is gone, when
    // unchanged since (a file the user changed or put there stays).
    let made: Vec<(PathBuf, u64)> = std::fs::read_to_string(made_file(root))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<(String, u64)>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|(p, n)| (root.join(p), n))
        .collect();
    // Placeholders first, while they still are (the cloud reparse point goes with the registration).
    fn sweep(p: &Path) {
        let Ok(rd) = std::fs::read_dir(p) else { return };
        for d in rd.flatten() {
            let q = d.path();
            let Ok(m) = std::fs::symlink_metadata(&q) else { continue };
            if m.is_dir() {
                sweep(&q);
                if m.file_attributes() & ATTR_REPARSE != 0 {
                    let _ = std::fs::remove_dir(&q);
                }
            } else if m.file_attributes() & ATTR_REPARSE != 0 {
                let _ = std::fs::remove_file(&q);
            }
        }
    }
    sweep(root);
    let a = StorageProviderSyncRootManager::Unregister(&HSTRING::from(root_id()));
    let w = wide_path(root);
    let b = unsafe { CfUnregisterSyncRoot(PCWSTR(w.as_ptr())) };
    eprintln!("ddn-cf: unregister: shell {:?}, cloud files {:?}", a.err().map(|e| e.code()), b.err().map(|e| e.code()));
    // Then the helper's own files and folders still there (deepest first; a folder only when empty).
    let mut left: Vec<&(PathBuf, u64)> = made.iter().collect();
    left.sort_by_key(|(p, _)| std::cmp::Reverse(p.components().count()));
    for (p, size) in left {
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => {
                let _ = std::fs::remove_dir(p);
            }
            Ok(m) if m.len() == *size => {
                let _ = std::fs::remove_file(p);
            }
            _ => {}
        }
    }
    let _ = std::fs::remove_file(made_file(root));
    unregister_thumbs();
    // The folder itself when nothing of the user's is left in it.
    let _ = std::fs::remove_dir(root);
    0
}

pub fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("unregister") if a.len() == 3 => std::process::exit(unregister(Path::new(&a[2]))),
        Some("state") if a.len() == 3 => std::process::exit(print_state(Path::new(&a[2]))),
        Some("serve") if a.len() == 6 || a.len() == 7 => {}
        _ => {
            eprintln!("usage: ddn-cf serve <root> <pipe> <icon> <version> | ddn-cf unregister <root>");
            std::process::exit(2);
        }
    }
    let (root, pipe, icon, version) = (PathBuf::from(&a[2]), a[3].clone(), a[4].clone(), a[5].clone());
    let token = std::env::var("DDN_CF_TOKEN").unwrap_or_default();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    if let Err(e) = std::fs::create_dir_all(&root) {
        eprintln!("ddn-cf: {}: {e}", root.display());
        std::process::exit(3);
    }
    let pool: Vec<Mutex<Agent>> = (0..4)
        .map(|_| match Agent::connect(&pipe, &token) {
            Ok(a) => Mutex::new(a),
            Err(e) => {
                eprintln!("ddn-cf: cannot reach the agent: {e}");
                std::process::exit(3);
            }
        })
        .collect();
    let how = match register(&root, &icon, &version) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("ddn-cf: cannot register the sync root: {e}");
            std::process::exit(4);
        }
    };
    let _ = STATE.set(State {
        root: root.clone(),
        pool,
        key: Mutex::new(0),
        dirs: Mutex::new(HashMap::new()),
        made: Mutex::new(HashMap::new()),
        removing: Mutex::new(HashSet::new()),
        dirty: AtomicBool::new(false),
        dirty_cache: AtomicBool::new(false),
        used: Mutex::new(HashMap::new()),
        limit: std::sync::atomic::AtomicU64::new(std::env::var("DDN_CF_LIMIT").ok().and_then(|x| x.parse().ok()).unwrap_or(10 << 30)),
    });
    let table: &'static [CF_CALLBACK_REGISTRATION] = Box::leak(Box::new([
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS, Callback: Some(on_fetch_placeholders) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_DATA, Callback: Some(on_fetch_data) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_CANCEL_FETCH_DATA, Callback: Some(on_cancel) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_DELETE, Callback: Some(on_delete) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_RENAME, Callback: Some(on_rename) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NONE, Callback: None },
    ]));
    let w = wide_path(&root);
    let key = match unsafe { CfConnectSyncRoot(PCWSTR(w.as_ptr()), table.as_ptr(), None, CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH) } {
        Ok(k) => k,
        Err(e) => {
            eprintln!("ddn-cf: cannot connect the sync root: {e}");
            std::process::exit(4);
        }
    };
    *st().key.lock().unwrap() = key.0;
    // Explorer's thumbnails from the stored previews (the DLL next to this helper, given by the agent).
    if let Some(dll) = a.get(6) {
        register_thumbs(Path::new(dll));
    }
    // What changed after a sync: a watch connection; the folders are compared a moment later (bursts merge).
    let mut watch = match Agent::connect(&pipe, &token) {
        Ok(a) => a,
        Err(_) => gone(),
    };
    if watch.send(&json!({ "op": "watch" })).is_err() {
        gone();
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(300));
        if st().dirty.swap(false, Ordering::SeqCst) {
            reconcile();
        }
    });
    // The limit: after reads (a moment later, bursts merge) and every minute.
    std::thread::spawn(|| {
        let mut last = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let t = now_ms();
            if st().dirty_cache.swap(false, Ordering::SeqCst) || t - last > 60_000 {
                last = t;
                trim();
            }
        }
    });
    {
        let r = root.clone();
        std::thread::spawn(move || watch_pins(r));
    }
    eprintln!("ddn-cf: serving {} ({how})", root.display());
    println!("ready");
    let _ = std::io::stdout().flush();
    loop {
        match watch.frame() {
            Ok(f) => {
                // {"limit": bytes}: the cache limit changed in Settings; else a sync: compare the folders.
                let v: Value = serde_json::from_slice(&f).unwrap_or(json!({}));
                if let Some(l) = v.get("limit").and_then(|x| x.as_u64()) {
                    st().limit.store(l, Ordering::SeqCst);
                    st().dirty_cache.store(true, Ordering::SeqCst);
                } else {
                    st().dirty.store(true, Ordering::SeqCst);
                }
            }
            Err(_) => gone(),
        }
    }
}
