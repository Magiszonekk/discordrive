// Unit tests of the shell's pure parts: the agent's call checks (what the window may ask), app:// path
// mapping (nothing outside the app's folders), the server address rules of "Connect to a server", the
// autostart entry (written and removed for real on Linux; Windows/macOS through Electron's login items,
// faked here, checked live in the e2e on CI), and the tray text.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCall, CORE_METHODS } from "../src/agent/methods.js";
import { normaliseServerUrl, isPrivateHost, loadSettings, saveSettings, DEFAULTS } from "../src/shell/settings.js";
import { autostartOn, setAutostart, xdgEntry, xdgFile, type AutostartEnv } from "../src/shell/autostart.js";
import { safeFileName, freeName } from "../src/agent/node-platform.js";
import { isAppUrl, staticPath } from "../src/shell/paths.js";

describe("agent call checks", () => {
  it("refuses unknown and internal methods", () => {
    for (const m of ["constructor", "__proto__", "attachPort", "attachLane", "onEvent", "close", "c", "disk", "platform", "toString", "hasOwnProperty"]) expect(checkCall(m, [])).toMatch(/no method/);
    expect(checkCall(42, [])).toMatch(/no method/);
  });
  it("checks argument types and counts", () => {
    expect(checkCall("status", [])).toBeNull();
    expect(checkCall("status", [1])).toMatch(/too many/);
    expect(checkCall("rename", ["a", "b"])).toBeNull();
    expect(checkCall("rename", ["a", 5])).toMatch(/wrong type/);
    expect(checkCall("rename", ["a"])).toMatch(/missing/);
    expect(checkCall("uploadPaths", [["/a", "/b"]])).toBeNull();
    expect(checkCall("uploadPaths", [["/a", 3]])).toMatch(/wrong type/);
    expect(checkCall("uploadPaths", ["/a"])).toMatch(/wrong type/);
    expect(checkCall("downloadToDisk", ["id", undefined, "tok"])).toBeNull();
    expect(checkCall("list", [undefined, undefined, 200, { by: "name", desc: false }])).toBeNull();
    expect(checkCall("rename", "ab")).toMatch(/bad arguments/);
  });
  it("lists only methods the core has", async () => {
    const src = readFileSync(join(__dirname, "..", "..", "web-mo", "src", "app-core.ts"), "utf8");
    for (const m of Object.keys(CORE_METHODS)) expect(new RegExp(`\\n  (async )?${m}\\(`).test(src), m).toBe(true);
  });
});

describe("app:// paths", () => {
  const root = join(tmpdir(), "ddn-root");
  it("maps the start page and the web app, never outside", () => {
    expect(staticPath("app://ddn/start/start.html", root, "metadata-only")).toBe(join(root, "static", "start.html"));
    expect(staticPath("app://ddn/ui.js", root, "metadata-only")).toBe(join(root, "web", "metadata-only", "ui.js"));
    expect(staticPath("app://ddn/folder/abc", root, "e2ee")).toBe(join(root, "web", "e2ee", "index.html"));
    expect(staticPath("app://ddn/../../etc/passwd", root, "metadata-only")).toBe(join(root, "web", "metadata-only", "index.html"));
    // The URL parser resolves %2e%2e itself: it stays inside the web app's folder.
    expect(staticPath("app://ddn/%2e%2e/%2e%2e/main.cjs", root, "metadata-only")).toBe(join(root, "web", "metadata-only", "main.cjs"));
    expect(staticPath("app://ddn/start/..%2f..%2fmain.cjs", root, "metadata-only")).toBeNull();
    expect(staticPath("app://other/ui.js", root, "metadata-only")).toBeNull();
    for (const u of ["app://ddn/x.js", "app://ddn/start/a.css"]) expect(staticPath(u, root, "plain")!.startsWith(root + sep)).toBe(true);
    expect(staticPath("app://ddn/%E0%A4%A", root, "plain")).toBeNull();
  });
  it("app URLs", () => {
    expect(isAppUrl("app://ddn/folder/x")).toBe(true);
    for (const u of ["https://ddn/", "app://evil/", "file:///", "javascript:1", undefined, ""]) expect(isAppUrl(u)).toBe(false);
  });
});

describe("server address", () => {
  it("normalises and refuses unsafe addresses", () => {
    expect(normaliseServerUrl("drive.example.com")).toBe("https://drive.example.com");
    expect(normaliseServerUrl(" https://drive.example.com/some/path?x#y ")).toBe("https://drive.example.com");
    expect(normaliseServerUrl("http://192.168.77.20:3020")).toBe("http://192.168.77.20:3020");
    expect(normaliseServerUrl("http://localhost:3020")).toBe("http://localhost:3020");
    expect(() => normaliseServerUrl("http://drive.example.com")).toThrow(/https/);
    expect(() => normaliseServerUrl("https://user:pw@drive.example.com")).toThrow();
    expect(() => normaliseServerUrl("file:///etc/passwd")).toThrow();
    expect(() => normaliseServerUrl("javascript:alert(1)")).toThrow();
    expect(() => normaliseServerUrl("")).toThrow();
  });
  it("private hosts", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.77.21", "localhost", "nas.local", "[::1]"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["8.8.8.8", "172.32.0.1", "drive.example.com", "192.0.2.1"]) expect(isPrivateHost(h), h).toBe(false);
  });
  it("settings survive a round trip, broken files fall back to defaults", () => {
    const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-set-"));
    expect(loadSettings(d)).toEqual(DEFAULTS);
    const s = { ...DEFAULTS, servers: [{ kind: "remote" as const, url: "https://drive.example.com", mode: "e2ee", addedAt: 1 }], active: 0, autostart: false };
    saveSettings(d, s);
    expect(loadSettings(d)).toEqual(s);
  });
});

describe("autostart", () => {
  it("Linux: an XDG autostart entry that starts the app hidden, removed again", () => {
    const configHome = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-xdg-"));
    const env: AutostartEnv = { platform: "linux", exec: "/opt/my apps/discordrive.AppImage", configHome, appId: "discordrive", appName: "discordrive" };
    expect(autostartOn(env)).toBe(false);
    setAutostart(env, true);
    expect(existsSync(xdgFile(env))).toBe(true);
    const text = readFileSync(xdgFile(env), "utf8");
    expect(text).toContain('Exec="/opt/my apps/discordrive.AppImage" --hidden');
    expect(text).toBe(xdgEntry(env));
    expect(autostartOn(env)).toBe(true);
    setAutostart(env, false);
    expect(existsSync(xdgFile(env))).toBe(false);
    expect(autostartOn(env)).toBe(false);
  });
  it("Windows / macOS: Electron's login item with --hidden", () => {
    let state = { openAtLogin: false, args: [] as string[] };
    const login = { setLoginItemSettings: (s: { openAtLogin: boolean; args?: string[] }) => void (state = { openAtLogin: s.openAtLogin, args: s.args ?? [] }), getLoginItemSettings: () => ({ openAtLogin: state.openAtLogin }) };
    const env: AutostartEnv = { platform: "win32", exec: "C:\\\\Program Files\\\\discordrive\\\\discordrive.exe", appId: "discordrive", appName: "discordrive", login };
    setAutostart(env, true);
    expect(state).toEqual({ openAtLogin: true, args: ["--hidden"] });
    expect(autostartOn(env)).toBe(true);
    setAutostart(env, false);
    expect(autostartOn(env)).toBe(false);
  });
});

describe("file names on disk", () => {
  it("safe names and free names", () => {
    expect(safeFileName('a<b>c:"d/e\\\\f|g?h*')).toBe("a_b_c__d_e__f_g_h_");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("name. ")).toBe("name");
    expect(safeFileName("")).toBe("file");
    const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-free-"));
    expect(freeName(d, "a.txt")).toBe(join(d, "a.txt"));
  });
});
