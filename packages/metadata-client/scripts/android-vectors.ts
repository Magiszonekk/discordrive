// Compatibility vectors for the Android app (apps/android/core/ddn): every format the phone reads or writes,
// produced by THIS code with fixed keys, so the Kotlin implementation is checked byte for byte against it
// (JVM tests: AccountVectorsTest). Regenerate after a format change:
//   npx tsx scripts/android-vectors.ts
// Writes apps/android/core/ddn/src/test/resources/account-vectors.json (committed; CI checks it is current:
// everything below is deterministic except the random IVs, which the Kotlin side only opens, never compares).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_RULES_VERSION } from "@ddv4/sync-core";
import {
  OpCodec,
  accountKeyFromRaw,
  authMessage,
  cleanDeviceName,
  encodeRescueKit,
  importDeviceKey,
  makeRescueKit,
  rescueKey,
  sealDeviceName,
  sealJson,
  sealVault,
  startPairing,
  acceptPairing,
  MemoryPairingMailbox,
  verifySignature,
  writeSnapshot,
  createPointerMessage,
  InProcessLogServer,
  EncryptedArbiter,
  MetadataClient,
  MemoryTransport,
  ChannelPacer,
  clientBlobIO,
  readPointer,
  type Challenge,
} from "../src/index.js";
import { fromBase64, toBase64 } from "@ddv4/processing";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "..", "apps", "android", "core", "ddn", "src", "test", "resources", "account-vectors.json");
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + 3) & 255);

const ACCT = "acct-AAAAAAAAAAAAAAAAAAAAAA";
const raw = bytes(32, 1);
const key = accountKeyFromRaw(raw);
const subkeys: Record<string, string> = {};
for (const label of ["vault", "op", "snapshot", "device-name", "share-note"] as const) {
  // The subkeys are non-extractable CryptoKeys; their bytes are shown by encrypting a known block with a
  // known IV (AES-GCM is deterministic for a fixed key, IV and plaintext): Kotlin must produce the same.
  const iv = bytes(12, 9);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key.subkey(label), bytes(40, 5)));
  subkeys[label] = hex(ct);
}

// Ed25519: a device key from a fixed seed (PKCS#8 = RFC 8410 prefix + seed), and the rescue key.
const seed = bytes(32, 2);
const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", priv);
const device = await importDeviceKey({ pkcs8: toBase64(pkcs8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), publicKey: jwk.x! });
const c: Challenge = { challengeId: "chal-BBBBBBBBBBBBBBBBBBBBBB", nonce: "nonce-123", instanceId: "inst-CCCCCCCCCCCCCCCCCCCCCC", expiresAt: 1 };
const loginMsg = authMessage.login(c, ACCT, "dev-DDDDDDDDDDDDDDDDDDDDDD");
const rk = await rescueKey(key);
const rescueMsg = authMessage.rescueAddDevice(c, ACCT, device.publicKey);
const ed = {
  seedHex: hex(seed),
  publicKey: device.publicKey,
  loginMessage: loginMsg,
  loginSignature: await device.sign(loginMsg),
  rescuePublicKey: rk.publicKey,
  rescueMessage: rescueMsg,
  rescueSignature: await rk.sign(rescueMsg),
  addDeviceMessage: authMessage.addDevice(c, ACCT, rk.publicKey),
  createAccountMessage: authMessage.createAccount(c, device.publicKey, rk.publicKey),
};
if (!(await verifySignature(device.publicKey, loginMsg, ed.loginSignature))) throw new Error("self-check");

// Sealed objects (random IVs: the phone opens them; its own seals are opened by this code in the interop test).
const codec = new OpCodec(key, ACCT);
const env = {
  opId: "op-EEEEEEEEEEEEEEEEEEEEEE",
  rulesVersion: WRITE_RULES_VERSION,
  baseSeq: 4,
  device: { id: "dev-DDDDDDDDDDDDDDDDDDDDDD", name: "Łódź laptop" },
  createdAt: 1792600000000,
  tzOffsetMin: 120,
  leaseGuard: ["upl-FFFFFFFFFFFFFFFFFFFFFF"],
  op: { type: "upload_begin" as const, uploadId: "upl-FFFFFFFFFFFFFFFFFFFFFF" },
};
const encEnv = await codec.encrypt(env);
const encEntry = { ...encEnv, seq: 5, serverTime: 1792600000123 };
const decEntry = await codec.decrypt(encEntry);
const tampered = { ...encEntry, baseSeq: 3 };
const decTampered = await codec.decrypt(tampered);

const vault = {
  format: "ddn-webhook-vault" as const,
  version: 1,
  webhooks: [{ id: "1550000000000000001", url: "https://discord.com/api/webhooks/1550000000000000001/" + "t".repeat(68), channelId: "1550000000000000101", guildId: null, label: "kanał 1", addedAt: 10 }],
  pointer: { webhookId: "1550000000000000001", messageId: "1550000000000000201" },
  futureField: { kept: true },
};
const sealedVault = await sealVault(key, ACCT, 7, vault);

const names = ["  laptop\tw  pracy ", "a\u0000b", "Ż".repeat(70), "", "e\u0301", "\u00a0x\u3000"];
const devName = { inputs: names, cleaned: names.map(cleanDeviceName), sealed: await sealDeviceName(key, ACCT, "dev-DDDDDDDDDDDDDDDDDDDDDD", "Telefon Ola") };

// Pairing: the web app's side as the NEW device (an offer the phone accepts) and as the SIGNED-IN device
// (it answers an offer made here; the phone, given the same ECDH key, would need its private half: so the
// phone's half is checked live in the interop test). Here: an offer + the mailbox answer + the SAS.
const pend = await startPairing(device.publicKey);
const mb = new MemoryPairingMailbox();
const acc = await acceptPairing(pend.offer, { accountId: ACCT, accountKey: key.rawB64, fromDevice: "laptop" }, async () => ({ deviceId: "dev-NEWNEWNEWNEWNEWNEWNEW1" }), mb);

// Snapshots: pointer + segment + base written by the real writer to an in-memory Discord.
const transport = new MemoryTransport();
const hook = { id: "1550000000000000001", url: "mem://hook/1" };
const server = new InProcessLogServer({ now: () => 1792600000000 });
const a = new MetadataClient({ device: { id: "dev-A", name: "A" }, arbiter: new EncryptedArbiter(codec, server.session("dev-A")), transport, webhooks: [hook], chunkSize: 1000, now: () => 1792600000000, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }) });
const io = clientBlobIO(a, transport, 300);
const loc = await createPointerMessage(io, key, ACCT, hook);
for (let i = 1; i <= 30; i++) await a.commitOp({ type: "create", kind: "folder", nodeId: `fold-${String(i).padStart(10, "0")}`, parentId: "root", name: `Folder ${i} Zażółć` }, "mkdir");
await writeSnapshot({ io, key, accountId: ACCT, pointer: loc, log: server.session("dev-A"), store: a.store, now: () => 1792600000000 }, "base");
await a.commitOp({ type: "rename", nodeId: "fold-0000000002", name: "Dokumenty" }, "rename");
await writeSnapshot({ io, key, accountId: ACCT, pointer: loc, log: server.session("dev-A"), store: a.store, now: () => 1792600000000 }, "segment");
const ptr = await readPointer(io, key, ACCT, loc);
const objects: Record<string, string> = {};
for (const [id, m] of transport.messages) objects[id] = toBase64(m.attachments[0]!.data);
const { canonicalState } = await import("@ddv4/sync-core");
const { createHash } = await import("node:crypto");
const kit1 = encodeRescueKit({ v: 1, accountId: ACCT, key: key.rawB64, webhookUrl: vault.webhooks[0]!.url, pointerMessageId: "1550000000000000201" });
const kit3 = makeRescueKit(ACCT, key.rawB64, { webhookId: vault.webhooks[0]!.id, messageId: "1550000000000000201" }, [
  { kind: "discord-webhook", id: vault.webhooks[0]!.id, url: vault.webhooks[0]!.url, channelId: "1550000000000000101" },
  { kind: "discord-webhook", id: "1550000000000000002", url: "https://discord.com/api/webhooks/1550000000000000002/" + "u".repeat(68) },
]);

const v = {
  note: "Generated by packages/metadata-client/scripts/android-vectors.ts. Do not edit.",
  accountId: ACCT,
  accountKeyB64: key.rawB64,
  subkeyProbe: { ivHex: hex(bytes(12, 9)), plainHex: hex(bytes(40, 5)), ciphertextHex: subkeys },
  ed25519: ed,
  op: { envelope: env, encrypted: encEntry, decrypted: decEntry, tamperedDecrypted: decTampered },
  vault: { revision: 7, blobB64: toBase64(sealedVault.blob), content: vault },
  deviceName: devName,
  pairing: { offer: pend.offer, devicePublicKey: device.publicKey, sasWebAcceptor: acc.sas, deviceIdGiven: "dev-NEWNEWNEWNEWNEWNEWNEW1" },
  snapshots: {
    pointer: loc,
    toSeq: ptr.toSeq,
    baseHeadSeq: ptr.base!.headSeq,
    baseParts: ptr.base!.parts.length,
    objects,
    stateSha256AtHead: createHash("sha256").update(canonicalState(a.store)).digest("hex"),
    headSeq: a.store.getMeta().headSeq,
    log: (await server.session("dev-A").read(0, 1000)),
  },
  kits: { kit1, kit3 },
};
// The pairing mailbox message of the web acceptor, for the phone's side as the new device it cannot open
// (no private key here); kept for the record of the format only.
void mb;
void fromBase64;
void sealJson;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(v, null, 1) + "\n");
console.log(JSON.stringify({ out, objects: Object.keys(objects).length, baseParts: v.snapshots.baseParts, headSeq: v.snapshots.headSeq }));
