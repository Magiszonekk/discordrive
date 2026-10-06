import { afterEach, describe, expect, it } from "vitest";
import { canonicalState, ROOT_ID } from "@ddv4/sync-core";
import {
  EncryptedArbiter,
  HttpApi,
  HttpPairingMailbox,
  MemoryPairingMailbox,
  MemoryTransport,
  MetadataClient,
  OpCodec,
  WebhookVault,
  acceptPairing,
  createAccountHttp,
  newAccountKey,
  startPairing,
  type PairingMailbox,
} from "../src/index.js";
import { DdnServer } from "../src/node/index.js";

const servers: DdnServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

const bundle = (key = newAccountKey()) => ({ accountId: "acct-1", accountKey: key.rawB64, deviceCredential: { deviceId: "dev-new", token: "ddt_x" }, fromDevice: "laptop" });

describe("device pairing (koncept §3.8)", () => {
  it("new device gets the account key; both show the same 6-digit code; slot is one-shot", async () => {
    const mb = new MemoryPairingMailbox();
    const n = await startPairing();
    expect(await n.complete(mb)).toBeNull(); // nothing yet
    const key = newAccountKey();
    const { sas } = await acceptPairing(n.offer, bundle(key), mb);
    const got = await n.complete(mb);
    expect(got!.sas).toBe(sas);
    expect(sas).toMatch(/^\d{6}$/);
    expect(got!.key.rawB64).toBe(key.rawB64);
    expect(await n.complete(mb)).toBeNull();
    // the relayed message holds no plaintext key
    expect(JSON.stringify([...mb.box.values()])).not.toContain(key.rawB64);
  });

  it("a server swapping in its own key pair is caught by the SAS and never sees the account key", async () => {
    const real = new MemoryPairingMailbox();
    const n = await startPairing();
    const key = newAccountKey();
    let relayed: { pub: string; sealed: string } | null = null;
    const evil: PairingMailbox = {
      put: async (_id, msg) => void (relayed = msg),
      take: (id) => real.take(id),
    };
    const { sas: sasE } = await acceptPairing(n.offer, bundle(key), evil);
    expect(JSON.stringify(relayed)).not.toContain(key.rawB64);
    // The server cannot decrypt the relayed message (sealed to pubN); it can only send its own bundle.
    const { sas: sasFake } = await acceptPairing(n.offer, bundle(newAccountKey()), real);
    const got = await n.complete(real);
    expect(got!.sas).toBe(sasFake);
    expect(got!.sas).not.toBe(sasE); // user sees different codes -> aborts
  });

  it("rejects a tampered message and malformed offers", async () => {
    const mb = new MemoryPairingMailbox();
    const n = await startPairing();
    await acceptPairing(n.offer, bundle(), mb);
    const m = mb.box.get(n.pairingId)!;
    m.msg = { ...m.msg, sealed: m.msg.sealed.slice(0, -4) + (m.msg.sealed.endsWith("AAAA") ? "BBBB" : "AAAA") };
    await expect(n.complete(mb)).rejects.toThrow(/does not decrypt/);
    await expect(acceptPairing("ddn-pair1:short.x", bundle(), mb)).rejects.toThrow(/bad pairing code/);
    await expect(acceptPairing("hello", bundle(), mb)).rejects.toThrow(/not a pairing code/);
  });

  it("end to end over HTTP: device B is paired by A, reads the vault and the encrypted log", async () => {
    const srv = new DdnServer();
    servers.push(srv);
    const { url } = await srv.listen(0);
    const key = newAccountKey();
    const acct = await createAccountHttp(url);
    const apiA = new HttpApi({ baseUrl: url, token: acct.token });
    await new WebhookVault(apiA, key, acct.accountId).addWebhook({ id: "555555555555555555", url: "https://discord.com/api/webhooks/555555555555555555/" + "W".repeat(68), channelId: "c", guildId: null, label: "w", addedAt: 1 });
    const transport = new MemoryTransport();
    const a = new MetadataClient({ device: { id: acct.deviceId, name: "A" }, arbiter: new EncryptedArbiter(new OpCodec(key, acct.accountId), apiA), transport, webhooks: [{ id: "555555555555555555", url: "mem://" }] });
    await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "Wspólne" }, "mkdir");

    // B: no credentials at all, shows a QR code.
    const pending = await startPairing();
    // A scans it, registers B's device on the server and hands over key + credential.
    const cred = await apiA.addDevice();
    const { sas } = await acceptPairing(pending.offer, { accountId: acct.accountId, accountKey: key.rawB64, deviceCredential: cred, fromDevice: "A" }, new HttpPairingMailbox(url, acct.token));
    const got = await pending.complete(new HttpPairingMailbox(url, null));
    expect(got!.sas).toBe(sas);

    const apiB = new HttpApi({ baseUrl: url, token: got!.bundle.deviceCredential.token });
    const vault = await new WebhookVault(apiB, got!.key, got!.bundle.accountId).load();
    expect(vault.webhooks).toHaveLength(1);
    const b = new MetadataClient({ device: { id: cred.deviceId, name: "B" }, arbiter: new EncryptedArbiter(new OpCodec(got!.key, got!.bundle.accountId), apiB), transport, webhooks: [{ id: "555555555555555555", url: "mem://" }] });
    await b.pull();
    expect(canonicalState(b.store)).toBe(canonicalState(a.store));
    expect(b.store.getNode("fold-00001")!.name).toBe("Wspólne");
    // the slot is gone, the server never had anything readable
    expect(await new HttpPairingMailbox(url, null).take(pending.pairingId)).toBeNull();
    expect(JSON.stringify(srv.db.prepare("SELECT * FROM pairing").all())).not.toContain(key.rawB64);
  });
});
