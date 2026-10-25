// ddn-cf: the disk in the system on Windows. A sync root of the Cloud Files API (like OneDrive) at
// %USERPROFILE%\discordrive, served by the discordrive agent: the helper knows no account key and talks to no
// network. Folders are filled when Explorer first opens them (placeholders with the real size and date), file
// contents are fetched in ranges when a program reads them (a video plays while the rest arrives).
//
//   ddn-cf serve <root> <pipe> <icon> <version>   register, connect, serve until the agent goes
//   ddn-cf unregister <root>                      take the sync root down (option off, uninstall)
//
// The agent's protocol is the one of the Linux helper (ddn-fuse): a request is u32 LE length + JSON, an answer
// u32 LE length + JSON, then u32 LE length + bytes. A second connection {"op":"watch"} brings what changed
// after a sync ({names:[{dir, added, removed}], inval}).
#[cfg(not(windows))]
fn main() {
    eprintln!("ddn-cf: Windows only");
    std::process::exit(2);
}

#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    win::main()
}
