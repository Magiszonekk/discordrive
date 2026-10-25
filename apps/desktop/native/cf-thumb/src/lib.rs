// Explorer's thumbnails for the files of the discordrive disk on Windows (the sync root of ddn-cf), without
// fetching the files: an in-process COM thumbnail provider (IThumbnailProvider + IInitializeWithItem: the item's
// path only, never its content). Its picture is the account's encrypted preview, decrypted by the agent: asked
// through the agent's pipe (its name and secret in a file only this user can read, written by ddn-cf).
// Registered for this user (HKCU) by ddn-cf; the sync root's ThumbnailProvider value names its CLSID.
#![cfg(windows)]
#![allow(non_snake_case)]

use std::ffi::c_void;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, HINSTANCE, S_FALSE, S_OK};
use windows::Win32::Graphics::Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::UI::Shell::{IInitializeWithItem, IInitializeWithItem_Impl};
use windows::Win32::UI::Shell::{IShellItem, IThumbnailProvider, IThumbnailProvider_Impl, SIGDN_FILESYSPATH, WTSAT_ARGB, WTS_ALPHATYPE};

/// The provider's CLSID (registered by ddn-cf under HKCU\Software\Classes\CLSID).
pub const CLSID_THUMB: GUID = GUID::from_u128(0x7a3c9e51_2b84_4d1f_a6e0_9c8d2f41b305);
static LOCKS: AtomicU32 = AtomicU32::new(0);
static OBJECTS: AtomicU32 = AtomicU32::new(0);

/// DDN_CF_THUMB_LOG=<file>: each step appended there (tests; the user's own machine otherwise logs nothing).
fn log(m: &str) {
    let Ok(base) = std::env::var("LOCALAPPDATA") else { return };
    let f = format!("{base}\\discordrive\\cf-thumb.log");
    // Only when the log exists already (tests create it): nothing is written on a user's machine.
    if !std::path::Path::new(&f).exists() {
        return;
    }
    if let Ok(mut h) = std::fs::OpenOptions::new().append(true).open(f) {
        let _ = writeln!(h, "[{}] {m}", std::process::id());
    }
}

#[implement(IThumbnailProvider, IInitializeWithItem)]
struct Thumb {
    path: Mutex<Option<String>>,
}

impl IInitializeWithItem_Impl for Thumb_Impl {
    fn Initialize(&self, psi: windows_core::Ref<'_, IShellItem>, _mode: u32) -> windows::core::Result<()> {
        let item = psi.ok()?;
        let p = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH)? };
        let s = unsafe { p.to_string() }.unwrap_or_default();
        unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const c_void)) };
        log(&format!("initialize {s}"));
        *self.path.lock().unwrap() = Some(s);
        Ok(())
    }
}

impl IThumbnailProvider_Impl for Thumb_Impl {
    fn GetThumbnail(&self, cx: u32, phbmp: *mut HBITMAP, pdwalpha: *mut WTS_ALPHATYPE) -> windows::core::Result<()> {
        if phbmp.is_null() {
            return Err(E_POINTER.into());
        }
        let path = self.path.lock().unwrap().clone().ok_or(windows::core::Error::from(E_FAIL))?;
        // No stored picture: a failure; Explorer shows the file type's icon (it does not fetch the file: the
        // sync root's provider is the one asked for its files).
        let got = preview(&path);
        log(&format!("thumbnail {cx} {path}: {:?}", got.as_ref().map(|x| x.len())));
        let img = got.ok_or(windows::core::Error::from(E_FAIL))?;
        let img = image::load_from_memory(&img).map_err(|_| windows::core::Error::from(E_FAIL))?;
        let img = if img.width().max(img.height()) > cx { img.thumbnail(cx, cx) } else { img };
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width() as i32, rgba.height() as i32);
        let bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let hb = unsafe { CreateDIBSection(None, &bi, DIB_RGB_COLORS, &mut bits, None, 0)? };
        // BGRA, premultiplied (what Explorer draws).
        let px = unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, (w * h * 4) as usize) };
        for (d, s) in px.chunks_exact_mut(4).zip(rgba.as_raw().chunks_exact(4)) {
            let a = s[3] as u32;
            d[0] = (s[2] as u32 * a / 255) as u8;
            d[1] = (s[1] as u32 * a / 255) as u8;
            d[2] = (s[0] as u32 * a / 255) as u8;
            d[3] = s[3];
        }
        unsafe {
            *phbmp = hb;
            if !pdwalpha.is_null() {
                *pdwalpha = WTSAT_ARGB;
            }
        }
        Ok(())
    }
}

/// The stored preview of the file at `path` (the agent finds its node by the path), or None.
fn preview(path: &str) -> Option<Vec<u8>> {
    let conf = std::env::var("LOCALAPPDATA").ok()? + "\\discordrive\\cf-thumb.json";
    log(&format!("config {conf}: {}", std::path::Path::new(&conf).exists()));
    let c: serde_json::Value = serde_json::from_slice(&std::fs::read(conf).ok()?).ok()?;
    let (pipe, token) = (c.get("pipe")?.as_str()?, c.get("token")?.as_str()?);
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(pipe).ok()?;
    let call = |f: &mut std::fs::File, q: serde_json::Value| -> Option<(serde_json::Value, Vec<u8>)> {
        let body = serde_json::to_vec(&q).ok()?;
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&body);
        f.write_all(&out).ok()?;
        let mut frame = || -> Option<Vec<u8>> {
            let mut n = [0u8; 4];
            f.read_exact(&mut n).ok()?;
            let mut b = vec![0u8; u32::from_le_bytes(n) as usize];
            f.read_exact(&mut b).ok()?;
            Some(b)
        };
        let j: serde_json::Value = serde_json::from_slice(&frame()?).ok()?;
        let d = frame()?;
        if j.get("err").is_some() {
            return None;
        }
        Some((j, d))
    };
    call(&mut f, serde_json::json!({ "op": "hello", "token": token }))?;
    let (_, d) = call(&mut f, serde_json::json!({ "op": "preview", "path": path }))?;
    if d.is_empty() {
        None
    } else {
        Some(d)
    }
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: windows_core::Ref<'_, windows_core::IUnknown>, riid: *const GUID, ppv: *mut *mut c_void) -> windows::core::Result<()> {
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let t: IThumbnailProvider = Thumb { path: Mutex::new(None) }.into();
        OBJECTS.fetch_add(1, Ordering::SeqCst);
        unsafe { t.query(riid, ppv).ok() }
    }
    fn LockServer(&self, lock: windows_core::BOOL) -> windows::core::Result<()> {
        if lock.as_bool() {
            LOCKS.fetch_add(1, Ordering::SeqCst);
        } else {
            LOCKS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    if ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    log(&format!("class object {:?}", *rclsid));
    if *rclsid != CLSID_THUMB {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let f: IClassFactory = Factory.into();
    f.query(riid, ppv)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    // Objects are not counted down on release (the shell's surrogate process ends with them): stay loaded.
    if LOCKS.load(Ordering::SeqCst) == 0 && OBJECTS.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

#[no_mangle]
pub extern "system" fn DllMain(_h: HINSTANCE, reason: u32, _r: *mut c_void) -> windows_core::BOOL {
    if reason == 1 {
        log(&format!("loaded into {}", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()));
    }
    true.into()
}

// Kept for the linker (the PCWSTR import is used by the windows crate's macros on some versions).
#[allow(dead_code)]
const _UNUSED: Option<PCWSTR> = None;
