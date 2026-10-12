// Background start: the files each backend writes (Task Scheduler XML, LaunchAgent plist, XDG
// autostart entry), argument quoting, backend choice and the supervise back-off. Pure functions:
// these run on every OS in CI; registering with schtasks/launchctl is covered by the CI job on
// that OS (windows-latest / macos-latest).
import { describe, expect, it } from "vitest";
import {
  command,
  desktopExecArg,
  detectBackend,
  launchdPlist,
  utf16,
  windowsTaskXml,
  winQuote,
  xdgDesktopEntry,
  xmlEscape,
} from "../src/autostart.js";
import { backoffMs } from "../src/supervise.js";

describe("backend choice", () => {
  it("per system; systemd missing on Linux → XDG autostart; env switches", () => {
    expect(detectBackend("win32", {}, () => false)).toBe("windows-task");
    expect(detectBackend("darwin", {}, () => false)).toBe("launchd");
    expect(detectBackend("linux", {}, () => true)).toBe("systemd");
    expect(detectBackend("linux", {}, () => false)).toBe("xdg");
    expect(detectBackend("freebsd", {}, () => false)).toBe("none");
    expect(detectBackend("linux", { DISCORDRIVE_NO_AUTOSTART: "1" }, () => true)).toBe("none");
    expect(detectBackend("linux", { DISCORDRIVE_NO_SYSTEMD: "1" }, () => true)).toBe("none");
    expect(detectBackend("linux", { DISCORDRIVE_NO_AUTOSTART: "0" }, () => true)).toBe("systemd");
    expect(detectBackend("linux", { DISCORDRIVE_AUTOSTART_BACKEND: "xdg" }, () => true)).toBe("xdg");
  });
});

describe("Windows: Task Scheduler XML", () => {
  const xml = windowsTaskXml({
    user: "DESKTOP-1\\Zażółć & Co",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    dataDir: "C:\\Users\\Zażółć\\AppData\\Local\\discordrive-next",
    repoDir: "C:\\Users\\Zażółć\\discordrive",
    script: "C:\\Users\\Zażółć\\discordrive\\apps\\ddn-server\\bin\\discordrive.mjs",
    systemRoot: "C:\\Windows",
  });
  it("at log on of this user, no stored password, no admin rights, no time limit, restart on failure, one instance", () => {
    expect(xml).toMatch(/<LogonTrigger>[\s\S]*<UserId>DESKTOP-1\\Zażółć &amp; Co<\/UserId>[\s\S]*<\/LogonTrigger>/);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toContain("HighestAvailable");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
  });
  it("no console window: conhost --headless runs node … supervise; paths with spaces quoted", () => {
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toContain(
      '<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; C:\\Users\\Zażółć\\discordrive\\apps\\ddn-server\\bin\\discordrive.mjs supervise --data-dir C:\\Users\\Zażółć\\AppData\\Local\\discordrive-next</Arguments>',
    );
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\Zażółć\\discordrive</WorkingDirectory>");
  });
  it("well-formed: one root, every opened tag closed, entities only &amp; &lt; &gt; &quot; &apos;", () => {
    const tags = [...xml.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)].filter((m) => !m[0].startsWith("<?"));
    const stack: string[] = [];
    for (const [, close, name, self] of tags) {
      if (self) continue;
      if (close) expect(stack.pop()).toBe(name);
      else stack.push(name!);
    }
    expect(stack).toEqual([]);
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, "")).not.toContain("&");
  });
  it("encoded as UTF-16 LE with a BOM and CRLF (what schtasks /XML expects)", () => {
    const b = utf16("<a>\nż</a>");
    expect([...b.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(b.subarray(2).toString("utf16le")).toBe("<a>\r\nż</a>");
  });
  it("Windows argument quoting (CommandLineToArgvW)", () => {
    expect(winQuote("C:\\x\\node.exe")).toBe("C:\\x\\node.exe");
    expect(winQuote("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(winQuote('a "b"')).toBe('"a \\"b\\""');
    expect(winQuote("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(winQuote("")).toBe('""');
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("macOS: LaunchAgent plist", () => {
  const plist = launchdPlist({ nodePath: "/opt/homebrew/bin/node", dataDir: "/Users/ana/Library/Application Support/discordrive-next", repoDir: "/Users/ana/discordrive", script: "/Users/ana/discordrive/apps/ddn-server/bin/discordrive.mjs" });
  it("starts at log in, restarted when it crashes (not after a clean exit), log in the data directory", () => {
    expect(plist).toMatch(/<key>Label<\/key>\s*<string>discordrive-next<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/ana\/discordrive\/apps\/ddn-server\/bin\/discordrive.mjs<\/string>\s*<string>serve<\/string>\s*<string>--data-dir<\/string>\s*<string>\/Users\/ana\/Library\/Application Support\/discordrive-next<\/string>\s*<\/array>/);
    expect(plist).toContain("<string>/Users/ana/Library/Application Support/discordrive-next/discordrive.log</string>");
    expect(plist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/); // 0o077
  });
});

describe("Linux without systemd: XDG autostart entry", () => {
  it("runs supervise after the desktop login; Exec arguments quoted per the Desktop Entry spec", () => {
    const e = xdgDesktopEntry({ nodePath: "/usr/bin/node", dataDir: "/home/ana/my data/ddn", script: "/home/ana/discordrive/apps/ddn-server/bin/discordrive.mjs" });
    expect(e).toContain("[Desktop Entry]\nType=Application\n");
    expect(e).toContain('Exec=/usr/bin/node /home/ana/discordrive/apps/ddn-server/bin/discordrive.mjs supervise --data-dir "/home/ana/my data/ddn"');
    expect(e).toContain("Terminal=false");
    expect(desktopExecArg('a"b$c')).toBe('"a\\"b\\$c"');
    expect(desktopExecArg("50%")).toBe("50%%");
  });
});

describe("supervise", () => {
  it("command: this node, this script, serve|supervise, the data directory", () => {
    const [node, script, sub, flag, dir] = command("/d", "supervise", "/n/node");
    expect([node, sub, flag, dir]).toEqual(["/n/node", "supervise", "--data-dir", "/d"]);
    expect(script).toMatch(/[\\/]bin[\\/]discordrive\.mjs$/);
  });
  it("back-off after crashes: 2 s doubling up to 60 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
});
