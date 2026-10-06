import { describe, expect, it } from "vitest";
import { canonicalState, checkInvariants, replay, ROOT_ID } from "@ddv4/sync-core";
import {
  EncryptedArbiter,
  InProcessLogServer,
  MemoryTransport,
  MetadataClient,
  OpCodec,
  memorySource,
  newAccountKey,
  type ByteSink,
  type EncryptedEntry,
  type WebhookRef,
} from "../src/index.js";

const HOOKS: WebhookRef[] = [{ id: "111111111111111111", url: "mem://hook/1" }];

function clock(start = Date.UTC(2026, 9, 6)) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
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

function device(server: InProcessLogServer, codec: OpCodec, transport: MemoryTransport, id: string, c = clock()) {
  return new MetadataClient({
    device: { id, name: id },
    arbiter: new EncryptedArbiter(codec, server.session(id)),
    transport,
    webhooks: HOOKS,
    chunkSize: 700,
    ...c,
  });
}

describe("encrypted operation log (koncept §3.3)", () => {
  it("the server sees only opId/rulesVersion/baseSeq/leaseGuard; two devices converge and download", async () => {
    const key = newAccountKey();
    const c = clock();
    const server = new InProcessLogServer({ now: c.now });
    const transport = new MemoryTransport();
    const a = device(server, new OpCodec(key, "acct-1"), transport, "dev-A", c);
    const b = device(server, new OpCodec(key, "acct-1"), transport, "dev-B", c);

    const data = crypto.getRandomValues(new Uint8Array(3000));
    const up = await a.upload(memorySource(data), "Tajny raport.pdf");

    const raw = server.log.read(0);
    expect(raw.map((e) => Object.keys(e).sort())).toEqual(
      raw.map((e) => ["baseSeq", "opId", "payload", "rulesVersion", "seq", "serverTime", ...(e.leaseGuard ? ["leaseGuard"] : [])].sort()),
    );
    const dump = JSON.stringify(raw);
    for (const secret of ["Tajny", "raport", "dev-A", "upload_begin", "create", up.nodeId, up.version.manifestRef.slice(5, 30), up.version.plaintextSha256!]) {
      expect(dump).not.toContain(secret);
    }
    expect(raw[1]!.leaseGuard).toEqual([up.uploadId]); // plaintext by design (Q8)

    await b.pull();
    expect(canonicalState(b.store)).toBe(canonicalState(a.store));
    expect(checkInvariants(b.store)).toEqual([]);
    const s = sink();
    await b.download(up.nodeId, s);
    expect(s.data()).toEqual(data);
  });

  it("leases are checked against the session device, not the (encrypted) payload", async () => {
    const key = newAccountKey();
    const server = new InProcessLogServer();
    const codec = new OpCodec(key, "acct-1");
    const intruder = new EncryptedArbiter(codec, server.session("dev-B"));
    expect(await server.session("dev-A").renewLease("upload-0001")).toBe(true);
    const r = await intruder.submit({
      opId: "op-000000001",
      rulesVersion: 2,
      baseSeq: 0,
      device: { id: "dev-A", name: "spoofed" },
      createdAt: 0,
      leaseGuard: ["upload-0001"],
      op: { type: "upload_begin", uploadId: "upload-0001" },
    });
    expect(r.status).toBe("lease_rejected");
  });

  it("a tampered, relabelled or foreign entry becomes the same invalid_op on every replica", async () => {
    const key = newAccountKey();
    const server = new InProcessLogServer();
    const transport = new MemoryTransport();
    const a = device(server, new OpCodec(key, "acct-1"), transport, "dev-A");
    await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "x" }, "mkdir");
    await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-00002", parentId: ROOT_ID, name: "y" }, "mkdir");
    const good = server.log.read(0);

    const tampered: EncryptedEntry[] = [
      { ...good[0]!, baseSeq: 0 }, // untouched
      { ...good[1]!, opId: "op-forged001" }, // relabelled opId -> AAD mismatch
    ];
    const foreign = await new OpCodec(newAccountKey(), "acct-1").encrypt({
      opId: "op-foreign01",
      rulesVersion: 2,
      baseSeq: 0,
      device: { id: "dev-X", name: "x" },
      createdAt: 0,
      op: { type: "create", kind: "folder", nodeId: "fold-00003", parentId: ROOT_ID, name: "z" },
    });
    tampered.push({ ...foreign, seq: 3, serverTime: 0 });

    const codec = new OpCodec(key, "acct-1");
    const r1 = replay(await Promise.all(tampered.map((e) => codec.decrypt(e))));
    const r2 = replay(await Promise.all(tampered.map((e) => new OpCodec(key, "acct-1").decrypt(e))));
    expect(r1.results.map((r) => r.outcome)).toEqual(["applied", "rejected", "rejected"]);
    expect(r1.results[1]!.notices[0]!.code).toBe("invalid_op");
    expect(canonicalState(r1.store)).toBe(canonicalState(r2.store));
    expect(r1.store.getNode("fold-00002")).toBeUndefined();
    expect(r1.store.getNode("fold-00003")).toBeUndefined();
  });

  it("another account's key cannot read the log", async () => {
    const key = newAccountKey();
    const server = new InProcessLogServer();
    const a = device(server, new OpCodec(key, "acct-1"), new MemoryTransport(), "dev-A");
    await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "x" }, "mkdir");
    const other = new OpCodec(key, "acct-2"); // same key, other account ID (AAD)
    const e = await other.decrypt(server.log.read(0)[0]!);
    expect(e.device.id).toBe("undecryptable");
  });
});
