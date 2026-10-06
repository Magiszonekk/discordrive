// Device pairing (koncept §3.8): an already signed-in device hands the
// account key to a new device. The server only relays one opaque, one-shot
// message and can read nothing.
//
//  1. New device N: ephemeral ECDH P-256 key pair + random pairingId; shows
//     offer = "ddn-pair1:" + pairingId + "." + pubN as a QR code / text.
//  2. Existing device E scans the offer (out of band, so pubN is authentic),
//     makes its own ephemeral pair, derives K = HKDF(ECDH(e, N), transcript),
//     seals the bundle {accountId, account key, device credential} with K and
//     posts {pubE, sealed} to the server mailbox under pairingId.
//  3. N fetches (the mailbox deletes on read), derives the same K, opens.
//  4. Both show a 6-digit code from K (SAS). The user checks they match: a
//     server swapping pubE for its own would give N a fake account and the
//     codes would differ. It can never obtain the account key: that is sealed
//     to pubN, which only travelled through the QR code.
//
// Device credential (decision #13): N puts its Ed25519 public key into the
// offer; E registers it on the server with its own signature (HttpApi.addDevice)
// and sends back the resulting deviceId. N's private key never leaves N. The
// key is covered by the SAS too (it is part of the HKDF transcript).

import { fromBase64, toBase64 } from "@ddv4/processing";
import { accountKeyFromB64, type AccountKey } from "./account-key.js";
import { isPublicKey } from "./device-key.js";

export const PAIRING_TTL_MS = 10 * 60_000;
const OFFER_PREFIX = "ddn-pair1:";
const enc = new TextEncoder();

const b64u = (b: Uint8Array) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64u(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return fromBase64(t);
}

export interface PairingBundle {
  v: 1;
  accountId: string;
  /** Account key, base64. Secret. */
  accountKey: string;
  /** Server identity of the new device (its public key was registered by the sender). */
  deviceCredential: { deviceId: string };
  /** Display name of the device that paired it. */
  fromDevice: string;
}

/** Server mailbox: one opaque message per pairingId, deleted on first read, expires. */
export interface PairingMailbox {
  put(pairingId: string, msg: { pub: string; sealed: string }): Promise<void>;
  take(pairingId: string): Promise<{ pub: string; sealed: string } | null>;
}

export class MemoryPairingMailbox implements PairingMailbox {
  readonly box = new Map<string, { msg: { pub: string; sealed: string }; at: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async put(id: string, msg: { pub: string; sealed: string }): Promise<void> {
    if (this.box.has(id)) throw new Error("pairing slot already used");
    this.box.set(id, { msg, at: this.now() });
  }
  async take(id: string): Promise<{ pub: string; sealed: string } | null> {
    const m = this.box.get(id);
    if (!m) return null;
    this.box.delete(id);
    return this.now() - m.at > PAIRING_TTL_MS ? null : m.msg;
  }
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function exportPub(k: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", k));
}
async function importPub(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new Error("bad pairing public key");
  return crypto.subtle.importKey("raw", raw as BufferSource, ECDH, false, []);
}

async function deriveKeys(priv: CryptoKey, peer: CryptoKey, pairingId: string, pubN: Uint8Array, pubE: Uint8Array, signPub: string): Promise<{ aes: CryptoKey; sas: string }> {
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256));
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey", "deriveBits"]);
  const info = (label: string) => enc.encode(`ddn-pair-v2|${label}|${pairingId}|${b64u(pubN)}|${b64u(pubE)}|${signPub}`);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: info("key") }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const sasBits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: info("sas") }, base, 32));
  const n = ((sasBits[0]! << 24) | (sasBits[1]! << 16) | (sasBits[2]! << 8) | sasBits[3]!) >>> 0;
  return { aes, sas: String(n % 1_000_000).padStart(6, "0") };
}

export interface PendingPairing {
  /** Show this as QR/text on the new device. */
  offer: string;
  pairingId: string;
  /** Poll the mailbox; resolves with the bundle and the SAS code once E has answered. */
  complete(mailbox: PairingMailbox): Promise<{ bundle: PairingBundle; key: AccountKey; sas: string } | null>;
}

/** Step 1 (new device). `devicePublicKey`: the new device's Ed25519 public key (DeviceKey.publicKey). */
export async function startPairing(devicePublicKey: string): Promise<PendingPairing> {
  if (!isPublicKey(devicePublicKey)) throw new Error("bad device public key");
  const kp = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  const pubN = await exportPub(kp.publicKey);
  const pairingId = b64u(crypto.getRandomValues(new Uint8Array(16)));
  return {
    pairingId,
    offer: `${OFFER_PREFIX}${pairingId}.${b64u(pubN)}.${devicePublicKey}`,
    async complete(mailbox) {
      const msg = await mailbox.take(pairingId);
      if (!msg) return null;
      const pubE = unb64u(msg.pub);
      const { aes, sas } = await deriveKeys(kp.privateKey, await importPub(pubE), pairingId, pubN, pubE, devicePublicKey);
      const sealed = unb64u(msg.sealed);
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) as BufferSource }, aes, sealed.subarray(12) as BufferSource));
      } catch {
        throw new Error("pairing message does not decrypt (wrong offer or tampered)");
      }
      const bundle = JSON.parse(new TextDecoder().decode(plain)) as PairingBundle;
      if (bundle.v !== 1 || !bundle.accountId || !bundle.accountKey || !bundle.deviceCredential?.deviceId) throw new Error("bad pairing bundle");
      return { bundle, key: accountKeyFromB64(bundle.accountKey), sas };
    },
  };
}

export function parseOffer(offer: string): { pairingId: string; pubN: Uint8Array; devicePublicKey: string } {
  const t = offer.trim();
  if (!t.startsWith(OFFER_PREFIX)) throw new Error("not a pairing code");
  const [pairingId, pub, signPub, ...rest] = t.slice(OFFER_PREFIX.length).split(".");
  if (!pairingId || !/^[A-Za-z0-9_-]{22}$/.test(pairingId) || !pub || !isPublicKey(signPub) || rest.length) throw new Error("bad pairing code");
  return { pairingId, pubN: unb64u(pub), devicePublicKey: signPub };
}

/**
 * Step 2 (existing device). `register` adds the new device's public key on
 * the server (HttpApi.addDevice, signed by this device) and returns its ID.
 * Returns the SAS code to show next to the new device's.
 */
export async function acceptPairing(
  offer: string,
  bundle: Omit<PairingBundle, "v" | "deviceCredential">,
  register: (devicePublicKey: string) => Promise<{ deviceId: string }>,
  mailbox: PairingMailbox,
): Promise<{ sas: string; deviceId: string }> {
  const { pairingId, pubN, devicePublicKey } = parseOffer(offer);
  const peer = await importPub(pubN);
  const kp = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  const pubE = await exportPub(kp.publicKey);
  const { aes, sas } = await deriveKeys(kp.privateKey, peer, pairingId, pubN, pubE, devicePublicKey);
  const { deviceId } = await register(devicePublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const full: PairingBundle = { v: 1, ...bundle, deviceCredential: { deviceId } };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify(full))));
  const sealed = new Uint8Array(12 + ct.byteLength);
  sealed.set(iv);
  sealed.set(ct, 12);
  await mailbox.put(pairingId, { pub: b64u(pubE), sealed: b64u(sealed) });
  return { sas, deviceId };
}
