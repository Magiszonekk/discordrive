import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalState, ROOT_ID } from "@ddv4/sync-core";
import {
  EncryptedArbiter,
  HttpApi,
  MemoryTransport,
  MetadataClient,
  OpCodec,
  ServerError,
  WebhookVault,
  createAccountHttp,
  memorySource,
  newAccountKey,
  type ByteSink,
} from "../src/index.js";
import { DdnServer } from "../src/node/index.js";

const servers: DdnServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

async function start(dbPath?: string) {
  const srv = new DdnServer({ dbPath });
  servers.push(srv);
  const { url } = await srv.listen(0);
  return { srv, url };
}

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: async (d) => void parts.push(new Uint8Array(d)),
    data: () => {
      const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) (out.set(p, o), (o += p.byteLength));
      return out;
    },
  };
}

const HOOK = { id: "444444444444444444", url: "mem://hook/4" };

describe("metadata-only server over HTTP (127.0.0.1)", () => {
  it("two devices: vault + upload through HTTP, converge, download; server holds only ciphertext", async () => {
    const { srv, url } = await start();
    const key = newAccountKey();
    const acct = await createAccountHttp(url);
    const apiA = new HttpApi({ baseUrl: url, token: acct.token });
    const devB = await apiA.addDevice();
    const apiB = new HttpApi({ baseUrl: url, token: devB.token });

    const vaultA = new WebhookVault(apiA, key, acct.accountId);
    await vaultA.addWebhook({ id: HOOK.id, url: `https://discord.com/api/webhooks/${HOOK.id}/${"V".repeat(68)}`, channelId: "c1", guildId: null, label: "x", addedAt: 1 });
    const vB = await new WebhookVault(apiB, key, acct.accountId).load();
    expect(vB.webhooks.map((w) => w.id)).toEqual([HOOK.id]);

    const transport = new MemoryTransport();
    const mk = (deviceId: string, api: HttpApi) =>
      new MetadataClient({ device: { id: deviceId, name: deviceId }, arbiter: new EncryptedArbiter(new OpCodec(key, acct.accountId), api), transport, webhooks: [HOOK], chunkSize: 400 });
    const a = mk(acct.deviceId, apiA);
    const b = mk(devB.deviceId, apiB);
    const data = crypto.getRandomValues(new Uint8Array(1500));
    const up = await a.upload(memorySource(data), "Wakacje 2026.mp4");
    await b.commitOp({ type: "create", kind: "folder", nodeId: "fold-B00001", parentId: ROOT_ID, name: "Od B" }, "mkdir");
    await a.pull();
    expect(canonicalState(a.store)).toBe(canonicalState(b.store));
    const s = sink();
    await b.download(up.nodeId, s);
    expect(s.data()).toEqual(data);

    const dump = JSON.stringify(srv.db.prepare("SELECT * FROM log").all()) + JSON.stringify(srv.db.prepare("SELECT * FROM vault").all());
    for (const secret of ["Wakacje", "Od B", "V".repeat(68), HOOK.id, up.nodeId, "fold-B00001", "create"]) expect(dump).not.toContain(secret);
  });

  it("rejects bad auth, extra envelope fields, oversized bodies; leases are per device session", async () => {
    const { url } = await start();
    const acct = await createAccountHttp(url);
    const api = new HttpApi({ baseUrl: url, token: acct.token });
    await expect(new HttpApi({ baseUrl: url, token: "ddt_" + "x".repeat(40) }).read(0)).rejects.toMatchObject({ status: 401 });
    const env = { opId: "op-00000001", rulesVersion: 2, baseSeq: 0, payload: "AAAA" };
    await expect(api.submit({ ...env, device: { id: "leak" } } as never)).rejects.toMatchObject({ status: 400, code: "bad_envelope_fields" });
    await expect(api.submit({ ...env, payload: "A".repeat(3 * 1024 * 1024) })).rejects.toMatchObject({ status: 413 });
    expect((await api.submit(env)).status).toBe("accepted");
    expect((await api.submit(env)).status).toBe("duplicate");
    expect((await api.submit({ ...env, opId: "op-00000002", rulesVersion: 1 })).status).toBe("rules_version_rejected");

    const other = await api.addDevice();
    const apiO = new HttpApi({ baseUrl: url, token: other.token });
    expect(await api.renewLease("upload-0001")).toBe(true);
    expect(await apiO.renewLease("upload-0001")).toBe(false);
    const r = await apiO.submit({ opId: "op-00000003", rulesVersion: 2, baseSeq: 1, leaseGuard: ["upload-0001"], payload: "AAAA" });
    expect(r).toEqual({ status: "lease_rejected", uploadId: "upload-0001" });

    await api.revokeDevice(other.deviceId);
    await expect(apiO.read(0)).rejects.toBeInstanceOf(ServerError);
  });

  it("accounts are isolated", async () => {
    const { url } = await start();
    const a1 = new HttpApi({ baseUrl: url, token: (await createAccountHttp(url)).token });
    const a2 = new HttpApi({ baseUrl: url, token: (await createAccountHttp(url)).token });
    await a1.submit({ opId: "op-00000001", rulesVersion: 2, baseSeq: 0, payload: "AAAA" });
    expect(await a2.read(0)).toEqual([]);
    expect(await a2.get()).toBeNull();
  });

  it("long-poll wakes up on a new entry; log and vault survive a restart", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-srv-"));
    const db = join(dir, "server.db");
    const { srv, url } = await start(db);
    const acct = await createAccountHttp(url);
    const api = new HttpApi({ baseUrl: url, token: acct.token });
    const t0 = Date.now();
    const waiting = api.waitFor(0, 10);
    await new Promise((r) => setTimeout(r, 150));
    await api.submit({ opId: "op-00000001", rulesVersion: 2, baseSeq: 0, payload: "AAAA" });
    const got = await waiting;
    expect(got.map((e) => e.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(5000);
    await api.put(acct.accountId, 0, { revision: 1, blob: new Uint8Array([1, 2, 3]) });
    await srv.close();
    servers.length = 0;

    const again = await start(db);
    const api2 = new HttpApi({ baseUrl: again.url, token: acct.token });
    expect((await api2.read(0)).map((e) => e.opId)).toEqual(["op-00000001"]);
    expect((await api2.submit({ opId: "op-00000001", rulesVersion: 2, baseSeq: 0, payload: "AAAA" })).status).toBe("duplicate");
    expect((await api2.submit({ opId: "op-00000002", rulesVersion: 2, baseSeq: 1, payload: "AAAA" })).status).toBe("accepted");
    expect((await api2.get())?.revision).toBe(1);
  });
});
