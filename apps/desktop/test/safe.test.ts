// The Safe through the app core on Node (what the web app and the desktop window call), against a real
// instance server and a fake Discord: create, the wrong password, folders and files, close on demand and after
// being idle, moving in and out (the account loses / gets the file), and names only while it is open.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { ROOT_ID } from "@ddv4/sync-core";
import { AppCore, SAFE_IDLE_MS } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";
import { CORE_METHODS } from "../src/agent/methods.js";

const fake = new FakeDiscord();
const servers: DdnServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});
const PW = "correct horse battery staple";

describe("the Safe in the app", () => {
  it("create, wrong password, folders, files, move in/out, close; nothing readable while closed", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-safe-app-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "safe test");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000601").url);

    expect(await core.safeState()).toEqual({ exists: false });
    await expect(core.safeCreate("short")).rejects.toThrow(/safe_password_short/);
    const st = await core.safeCreate(PW);
    expect(st).toMatchObject({ exists: true, open: true });

    const docs = await core.safeMkdir("Dokumenty");
    expect(core.safeList()).toEqual([{ id: docs, name: "Dokumenty", kind: "folder", size: null }]);
    const up = await core.safeUpload(new Blob([new Uint8Array(70_000).fill(7)]), "paszport.pdf", docs);
    expect(core.safeList(docs).map((r) => [r.name, r.size])).toEqual([["paszport.pdf", 70_000]]);
    expect(core.safePath(docs)).toEqual([{ id: docs, name: "Dokumenty" }]);
    expect((await core.safeDownload(up.nodeId)).size).toBe(70_000);
    // The Drive does not see it.
    expect(core.list(ROOT_ID).rows).toEqual([]);

    // Desktop: a file from disk.
    const p = join(base, "skan.jpg");
    writeFileSync(p, new Uint8Array(1234));
    await core.safeUploadPath(p, docs);
    expect(core.safeList(docs).map((r) => r.name)).toEqual(["paszport.pdf", "skan.jpg"]);

    // Into the Safe from the Drive: the size to send again is known before; the Drive loses the file.
    const umowa = (await core.upload(new Blob([new Uint8Array(5000)]), "umowa.pdf")).nodeId;
    expect(core.safeMoveSize([umowa], true)).toBe(5000);
    expect(await core.safeMoveIn([umowa], docs)).toEqual({ files: 1, bytes: 5000 });
    expect(core.list(ROOT_ID).rows).toEqual([]);
    expect(core.safeList(docs).map((r) => r.name)).toEqual(["paszport.pdf", "skan.jpg", "umowa.pdf"]);
    // Out again into the Drive.
    const back = core.safeList(docs).find((r) => r.name === "skan.jpg")!.id;
    expect(await core.safeMoveOut([back], ROOT_ID)).toEqual({ files: 1, bytes: 1234 });
    expect(core.list(ROOT_ID).rows.map((r) => r.name)).toEqual(["skan.jpg"]);
    await core.safeRename(docs, "Papiery");
    await core.safeDelete([core.safeList(docs).find((r) => r.name === "umowa.pdf")!.id]);
    expect(core.safeList(docs).map((r) => r.name)).toEqual(["paszport.pdf"]);

    // Closed: no names, no reads.
    core.safeClose();
    expect(await core.safeState()).toEqual({ exists: true, open: false });
    expect(() => core.safeList()).toThrow(/safe_closed/);
    await expect(core.safeDownload(up.nodeId)).rejects.toThrow(/safe_closed/);
    await expect(core.safeUnlock("wrong password here")).rejects.toThrow(/safe_bad_password/);
    await core.safeUnlock(PW);
    expect(core.safeList().map((r) => r.name)).toEqual(["Papiery"]);

    // The desktop agent lets the window call these (and checks their arguments).
    for (const m of ["safeState", "safeCreate", "safeUnlock", "safeClose", "safeList", "safePath", "safeMkdir", "safeRename", "safeDelete", "safeUploadPath", "safeDownload", "safeMoveSize", "safeMoveIn", "safeMoveOut"]) {
      expect(CORE_METHODS[m], m).toBeDefined();
      expect(typeof (core as unknown as Record<string, unknown>)[m], m).toBe("function");
    }
    core.safeClose();
    core.close();
  }, 120_000);

  it("closes by itself after being idle; any use keeps it open", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-safe-idle-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "safe idle");
    await core.open();
    await core.safeCreate(PW);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.advanceTimersByTime(SAFE_IDLE_MS - 1000);
      core.safeList(); // a use: 5 minutes again
      vi.advanceTimersByTime(SAFE_IDLE_MS - 1000);
      expect((await core.safeState()).exists && (await core.safeState() as { open: boolean }).open).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(await core.safeState()).toEqual({ exists: true, open: false });
    } finally {
      vi.useRealTimers();
    }
    core.close();
  }, 60_000);
});
