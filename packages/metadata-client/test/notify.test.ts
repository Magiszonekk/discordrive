import { afterEach, describe, expect, it } from "vitest";
import { ROOT_ID } from "@ddv4/sync-core";
import { EncryptedArbiter, MemoryTransport, MetadataClient, OpCodec } from "../src/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("websocket notifications (koncept §3.4 role 4)", () => {
  it("device B learns about A's op within moments and pulls it; other accounts hear nothing", async () => {
    const { srv, url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const stranger = await newAccount(url);
    const heads: number[] = [];
    const strangerHeads: number[] = [];
    const subB = b.api.subscribe((seq) => heads.push(seq));
    const subS = stranger.api.subscribe((seq) => strangerHeads.push(seq));
    try {
      await until(() => subB.connected && subS.connected);
      expect(srv.notify.count(a.accountId)).toBe(1);
      const t = new MemoryTransport();
      const hooks = [{ id: "1", url: "mem://" }];
      const ca = new MetadataClient({ device: { id: a.deviceId, name: "A" }, arbiter: new EncryptedArbiter(new OpCodec(a.key, a.accountId), a.api), transport: t, webhooks: hooks });
      const cb = new MetadataClient({ device: { id: b.deviceId, name: "B" }, arbiter: new EncryptedArbiter(new OpCodec(a.key, a.accountId), b.api), transport: t, webhooks: hooks });
      const t0 = Date.now();
      await ca.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "nowy" }, "mk");
      await until(() => heads.includes(1));
      const latency = Date.now() - t0;
      await cb.pull();
      expect(cb.store.getNode("fold-00001")?.name).toBe("nowy");
      expect(latency).toBeLessThan(2000);
      expect(heads[0]).toBe(-1); // initial "pull what you missed"
      expect(strangerHeads).toEqual([-1]);
    } finally {
      subB.close();
      subS.close();
    }
  });

  it("rejects a socket without a valid one-shot ticket and from a foreign browser origin", async () => {
    const { url } = await startServer({ corsOrigins: ["http://127.0.0.1:1"] });
    const a = await newAccount(url);
    const ws = (u: string, headers?: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const w = new WebSocket(u, headers ? ({ headers } as never) : undefined);
        w.onopen = () => (w.close(), resolve(101));
        w.onerror = () => resolve(0);
      });
    const base = url.replace("http:", "ws:") + "/v1/notify";
    expect(await ws(base + "?ticket=nope")).toBe(0);
    const r = await fetch(url + "/v1/notify-ticket", { method: "POST", headers: { authorization: "Bearer " + (await a.api.session()) } });
    const { ticket } = (await r.json()) as { ticket: string };
    expect(await ws(`${base}?ticket=${ticket}`)).toBe(101);
    expect(await ws(`${base}?ticket=${ticket}`)).toBe(0); // one-shot
  });

  it("reconnects after the server restarts and reports -1 so the client catches up", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const db = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-ws-")), "s.db");
    const first = await startServer({ dbPath: db });
    const a = await newAccount(first.url);
    const port = Number(new URL(first.url).port);
    const heads: number[] = [];
    const sub = a.api.subscribe((s) => heads.push(s), { maxBackoffMs: 300 });
    try {
      await until(() => sub.connected);
      await closeServers();
      await until(() => !sub.connected);
      const { DdnServer } = await import("../src/node/index.js");
      const again = new DdnServer({ dbPath: db });
      await again.listen(port);
      try {
        await until(() => heads.filter((h) => h === -1).length >= 2, 10_000);
        expect(sub.connected).toBe(true);
      } finally {
        sub.close();
        await again.close();
      }
    } finally {
      sub.close();
    }
  });
});
