import { afterEach, describe, expect, it } from "vitest";
import { closeServers, newAccount, startServer } from "./http-helpers.js";
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
  generateDeviceKey,
  newAccountKey,
  startPairing,
  type PairingMailbox,
} from "../src/index.js";

afterEach(closeServers);

const bundle = (key = newAccountKey()) => ({ accountId: "acct-1", accountKey: key.rawB64, fromDevice: "laptop" });
const fakeRegister = async () => ({ deviceId: "dev-new" });
const devPub = async () => (await generateDeviceKey()).publicKey;

describe("device pairing", () => {
  it("new device gets the account key; both show the same 6-digit code; slot is one-shot", async () => {
    const mb = new MemoryPairingMailbox();
    const n = await startPairing(await devPub());
    expect(await n.complete(mb)).toBeNull(); // nothing yet
    const key = newAccountKey();
    const { sas } = await acceptPairing(n.offer, bundle(key), fakeRegister, mb);
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
    const n = await startPairing(await devPub());
    const key = newAccountKey();
    let relayed: { pub: string; sealed: string } | null = null;
    const evil: PairingMailbox = {
      put: async (_id, msg) => void (relayed = msg),
      take: (id) => real.take(id),
    };
    const { sas: sasE } = await acceptPairing(n.offer, bundle(key), fakeRegister, evil);
    expect(JSON.stringify(relayed)).not.toContain(key.rawB64);
    // The server cannot decrypt the relayed message (sealed to pubN); it can only send its own bundle.
    const { sas: sasFake } = await acceptPairing(n.offer, bundle(newAccountKey()), fakeRegister, real);
    const got = await n.complete(real);
    expect(got!.sas).toBe(sasFake);
    expect(got!.sas).not.toBe(sasE); // user sees different codes -> aborts
  });

  it("rejects a tampered message and malformed offers", async () => {
    const mb = new MemoryPairingMailbox();
    const n = await startPairing(await devPub());
    await acceptPairing(n.offer, bundle(), fakeRegister, mb);
    const m = mb.box.get(n.pairingId)!;
    m.msg = { ...m.msg, sealed: m.msg.sealed.slice(0, -4) + (m.msg.sealed.endsWith("AAAA") ? "BBBB" : "AAAA") };
    await expect(n.complete(mb)).rejects.toThrow(/does not decrypt/);
    await expect(acceptPairing("ddn-pair1:short.x", bundle(), fakeRegister, mb)).rejects.toThrow(/bad pairing code/);
    await expect(acceptPairing("hello", bundle(), fakeRegister, mb)).rejects.toThrow(/not a pairing code/);
  });

  it("end to end over HTTP: A registers B's public key by signing, B signs in itself, reads vault and log", async () => {
    const { srv, url } = await startServer();
    const acct = await newAccount(url);
    const key = acct.key;
    const apiA = acct.api;
    await new WebhookVault(apiA, key, acct.accountId).addWebhook({ id: "555555555555555555", url: "https://discord.com/api/webhooks/555555555555555555/" + "W".repeat(68), channelId: "c", guildId: null, label: "w", addedAt: 1 });
    const transport = new MemoryTransport();
    const a = new MetadataClient({ device: { id: acct.deviceId, name: "A" }, arbiter: new EncryptedArbiter(new OpCodec(key, acct.accountId), apiA), transport, webhooks: [{ id: "555555555555555555", url: "mem://" }] });
    await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "Wspólne" }, "mkdir");

    // B: own Ed25519 key, no credentials, shows a QR code with its public key.
    const bKey = await generateDeviceKey();
    const pending = await startPairing(bKey.publicKey);
    // A scans it and vouches for B's key with its own signature.
    const { sas, deviceId } = await acceptPairing(pending.offer, { accountId: acct.accountId, accountKey: key.rawB64, fromDevice: "A" }, (pub) => apiA.addDevice(pub), apiA.pairingMailbox());
    const got = await pending.complete(new HttpPairingMailbox(url, null));
    expect(got!.sas).toBe(sas);
    expect(got!.bundle.deviceCredential.deviceId).toBe(deviceId);

    const apiB = new HttpApi({ baseUrl: url, accountId: got!.bundle.accountId, deviceId, key: bKey });
    const vault = await new WebhookVault(apiB, got!.key, got!.bundle.accountId).load();
    expect(vault.webhooks).toHaveLength(1);
    expect(apiB.logins).toBe(1);
    const b = new MetadataClient({ device: { id: deviceId, name: "B" }, arbiter: new EncryptedArbiter(new OpCodec(got!.key, got!.bundle.accountId), apiB), transport, webhooks: [{ id: "555555555555555555", url: "mem://" }] });
    await b.pull();
    expect(canonicalState(b.store)).toBe(canonicalState(a.store));
    expect(b.store.getNode("fold-00001")!.name).toBe("Wspólne");
    expect((await apiA.listDevices()).map((d) => d.publicKey).sort()).toEqual([acct.device.publicKey, bKey.publicKey].sort());
    expect(await new HttpPairingMailbox(url, null).take(pending.pairingId)).toBeNull();
    expect(JSON.stringify(srv.db.prepare("SELECT * FROM pairing").all())).not.toContain(key.rawB64);
  });
});
