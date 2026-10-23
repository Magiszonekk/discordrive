// The keyring on Linux (QA B1, B2): keys sealed by a keyring that is locked (or whose unlock was cancelled)
// give the window a reason to show ("The keyring is locked", retry, rescue kit), not an exception and an
// empty window; a refused keyring is remembered (no "create a keyring" window at every start).
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileKeyStore, nodePlatform, type Sealer } from "../src/agent/node-platform.js";
import { hasDefaultKeyring, keyringPlan, keysProtection } from "../src/shell/keyring.js";
import { AppCore } from "../../web-mo/src/app-core.js";
import { loadSettings, saveSettings, DEFAULTS } from "../src/shell/settings.js";

const osSealer = (fail = false): Sealer => ({
  kind: "os",
  seal: async (b) => new Uint8Array([7, ...b]),
  open: async (b) => {
    if (fail) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    return b.subarray(1);
  },
});

describe("keyring plan", () => {
  it("asks the keyring for sealed keys, explains first without a default keyring, keeps a refusal", () => {
    expect(keyringPlan({ platform: "win32", choice: "file", keys: null, defaultKeyring: null })).toBe("check");
    expect(keyringPlan({ platform: "linux", choice: "file", keys: "S", defaultKeyring: false })).toBe("check");
    expect(keyringPlan({ platform: "linux", choice: "file", keys: null, defaultKeyring: true })).toBe("file");
    expect(keyringPlan({ platform: "linux", choice: "ask", keys: null, defaultKeyring: false })).toBe("explain");
    expect(keyringPlan({ platform: "linux", choice: "ask", keys: "P", defaultKeyring: true })).toBe("check");
    expect(keyringPlan({ platform: "linux", choice: "ask", keys: null, defaultKeyring: null })).toBe("check");
  });
  it("reads the default keyring alias from D-Bus", async () => {
    expect(await hasDefaultKeyring(async () => "(objectpath '/org/freedesktop/secrets/collection/login',)\n")).toBe(true);
    expect(await hasDefaultKeyring(async () => "(objectpath '/',)\n")).toBe(false);
    expect(await hasDefaultKeyring(async () => { throw new Error("no gdbus"); })).toBeNull();
  });
  it("the refusal survives a restart (settings)", () => {
    const d = mkdtempSync(join(tmpdir(), "ddn-kr-"));
    expect(loadSettings(d).keyring).toBe("ask");
    saveSettings(d, { ...DEFAULTS, servers: [], keyring: "file" });
    expect(loadSettings(d).keyring).toBe("file");
  });
});

describe("keys sealed by a keyring that does not open them", () => {
  it("keysProtection reads S / P / none", () => {
    const d = mkdtempSync(join(tmpdir(), "ddn-kr-"));
    expect(keysProtection(join(d, "keys.bin"))).toBeNull();
    writeFileSync(join(d, "keys.bin"), Buffer.from("DDNKS..."));
    expect(keysProtection(join(d, "keys.bin"))).toBe("S");
    writeFileSync(join(d, "keys.bin"), Buffer.from("DDNKP{}"));
    expect(keysProtection(join(d, "keys.bin"))).toBe("P");
  });

  it("load() throws keystore_locked (keyring gone, or its unlock cancelled); status() reports it instead of throwing", async () => {
    const d = mkdtempSync(join(tmpdir(), "ddn-kr-"));
    mkdirSync(d, { recursive: true });
    // Sealed keys on disk (as after a start with the keyring open).
    writeFileSync(join(d, "keys.bin"), Buffer.concat([Buffer.from("DDNKS"), Buffer.from([7, 1, 2, 3])]));
    // The keyring is not there now (the app chose the file store).
    await expect(fileKeyStore(d, { kind: "file", seal: async (b) => b, open: async (b) => b }).load()).rejects.toMatchObject({ code: "keystore_locked" });
    // The keyring is there but refuses (Cancel in "Unlock Keyring").
    await expect(fileKeyStore(d, osSealer(true)).load()).rejects.toMatchObject({ code: "keystore_locked" });
    // What the window asks first: a status with the reason, not an exception.
    const core = new AppCore({}, nodePlatform({ dataDir: d, sealer: osSealer(true) }));
    const st = await core.status();
    expect(st.hasAccount).toBe(false);
    expect(st.signedIn).toBe(false);
    expect(st.keysLocked).toMatch(/key store did not open the keys/);
    // Any other broken file still throws (not hidden as "locked").
    writeFileSync(join(d, "keys.bin"), Buffer.from("XXXX"));
    await expect(new AppCore({}, nodePlatform({ dataDir: d, sealer: osSealer() })).status()).rejects.toThrow(/unknown format/);
  });
});
