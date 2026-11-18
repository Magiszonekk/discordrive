// API keys: access to an account from scripts, the command line and a local service.
//
// An API key is an ordinary device of the account: its own Ed25519 key pair, registered by the
// device that created it (signed like pairing), listed and revoked like any device. Only its sealed
// name says it is an API key (device-names.ts, kind "api"); the server cannot tell it apart.
//
// Unlike a paired device, its private key leaves the creating device once, inside the key text, so
// whoever holds the text can sign in as that device. The text also carries the account key: files
// are encrypted and decrypted on the client, the server never gets a key it could use.
//
// Text form: "ddn-api1:" + base64url(JSON) + "." + checksum, where the checksum is the first 6 bytes
// of SHA-256 over everything before the dot (base64url, 8 characters). A typo or a cut-off copy
// gives "this is not a whole API key", not a JSON error.

import { fromBase64 } from "@ddv4/processing";
import { accountKeyFromB64, type AccountKey } from "./account-key.js";
import { b64u, deviceKeyFromSeed, isPublicKey, unb64u, type DeviceKey } from "./device-key.js";
import { sealDeviceName } from "./device-names.js";
import { HttpApi } from "./http-api.js";

export const API_KEY_PREFIX = "ddn-api1:";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** What an API key holds. Secret as a whole (account key + device signing key). */
export interface ApiKey {
  /** Server address (origin). */
  server: string;
  /** Server instance the device was registered on (refuses challenges of another one). */
  instanceId: string;
  accountId: string;
  deviceId: string;
  /** Ed25519 seed of the device key, 32 bytes, base64url. */
  seed: string;
  /** Account key, base64. */
  accountKey: string;
}

/** Why a text is not a usable API key: "format" (not a key at all), "damaged" (typo, cut off), "kind" (another code). */
export class ApiKeyError extends Error {
  constructor(
    readonly reason: "format" | "damaged" | "kind",
    message: string,
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

async function checksum(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return b64u(d.subarray(0, 6));
}

interface Wire {
  v: 1;
  s: string;
  i: string;
  a: string;
  d: string;
  p: string;
  k: string;
}

export async function encodeApiKey(k: ApiKey): Promise<string> {
  const w: Wire = { v: 1, s: k.server, i: k.instanceId, a: k.accountId, d: k.deviceId, p: k.seed, k: k.accountKey };
  const head = API_KEY_PREFIX + b64u(enc.encode(JSON.stringify(w)));
  return `${head}.${await checksum(head)}`;
}

/** Reads a key text (surrounding white space and line breaks inside it are ignored). */
export async function decodeApiKey(text: string): Promise<ApiKey> {
  const t = text.replace(/\s+/g, "");
  if (!t.startsWith(API_KEY_PREFIX)) {
    if (/^ddn-kit\d+:/.test(t)) throw new ApiKeyError("kind", "this is a rescue kit, not an API key");
    if (/^ddn-pair\d+:/.test(t)) throw new ApiKeyError("kind", "this is a pairing code, not an API key");
    if (/^ddn-api\d+:/.test(t)) throw new ApiKeyError("kind", "API key of a newer format: update this program");
    throw new ApiKeyError("format", "not an API key (it starts with ddn-api1:)");
  }
  const dot = t.lastIndexOf(".");
  if (dot < API_KEY_PREFIX.length) throw new ApiKeyError("damaged", "the API key is incomplete (copy all of it)");
  const head = t.slice(0, dot);
  if (t.slice(dot + 1) !== (await checksum(head))) throw new ApiKeyError("damaged", "the API key is damaged or incomplete (copy all of it)");
  let w: Wire;
  try {
    w = JSON.parse(dec.decode(unb64u(head.slice(API_KEY_PREFIX.length)))) as Wire;
  } catch {
    throw new ApiKeyError("damaged", "the API key is damaged");
  }
  const ok =
    w &&
    w.v === 1 &&
    typeof w.s === "string" &&
    /^https?:\/\//.test(w.s) &&
    typeof w.i === "string" &&
    typeof w.a === "string" &&
    typeof w.d === "string" &&
    typeof w.p === "string" &&
    unb64uLen(w.p) === 32 &&
    typeof w.k === "string" &&
    b64Len(w.k) === 32;
  if (!ok) throw new ApiKeyError("damaged", "the API key is damaged");
  return { server: w.s, instanceId: w.i, accountId: w.a, deviceId: w.d, seed: w.p, accountKey: w.k };
}

function unb64uLen(s: string): number {
  try {
    return unb64u(s).byteLength;
  } catch {
    return -1;
  }
}
function b64Len(s: string): number {
  try {
    return fromBase64(s).byteLength;
  } catch {
    return -1;
  }
}

/**
 * New API key on this account, created by a signed-in device: registers a new device key (signed by
 * this device, like pairing) and seals its name with kind "api". Returns the key text (show it once)
 * and the new device's ID.
 */
export async function createApiKey(
  http: HttpApi,
  account: { server: string; instanceId: string; accountId: string; key: AccountKey },
  name: string,
): Promise<{ text: string; deviceId: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    const dk = await deviceKeyFromSeed(seed);
    const { deviceId } = await http.addDevice(dk.publicKey);
    await http.setDeviceName(deviceId, await sealDeviceName(account.key, account.accountId, deviceId, name, "api"));
    const text = await encodeApiKey({
      server: account.server.replace(/\/+$/, ""),
      instanceId: account.instanceId,
      accountId: account.accountId,
      deviceId,
      seed: b64u(seed),
      accountKey: account.key.rawB64,
    });
    return { text, deviceId };
  } finally {
    seed.fill(0);
  }
}

/** What a program holding the key needs: a signed-in API client, the account key, the device key. */
export async function apiKeyHttp(k: ApiKey, f?: typeof fetch): Promise<{ http: HttpApi; key: AccountKey; device: DeviceKey }> {
  const seed = unb64u(k.seed);
  const device = await deviceKeyFromSeed(seed);
  seed.fill(0);
  if (!isPublicKey(device.publicKey)) throw new ApiKeyError("damaged", "the API key is damaged");
  const http = new HttpApi({ baseUrl: k.server, accountId: k.accountId, deviceId: k.deviceId, key: device, instanceId: k.instanceId, fetch: f });
  return { http, key: accountKeyFromB64(k.accountKey), device };
}
