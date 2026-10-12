// Device display names (zlecenie 2026-10-09 A). Decision (DECISIONS.md, etap 2):
// the name is sealed with the account key (subkey "device-name"), bound to the
// account and device ID, so the server stores an opaque blob and the §3.3
// contract (what the server sees in clear) stays unchanged.

import { fromBase64, toBase64 } from "@ddv4/processing";
import { sealJson, unsealJson, type AccountKey } from "./account-key.js";

export const MAX_DEVICE_NAME = 64;
const aad = (accountId: string, deviceId: string) => `ddn-devname-v1|${accountId}|${deviceId}`;

export function cleanDeviceName(name: string): string {
  const n = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return [...n].slice(0, MAX_DEVICE_NAME).join("") || "device";
}

export async function sealDeviceName(key: AccountKey, accountId: string, deviceId: string, name: string): Promise<string> {
  return toBase64(await sealJson(await key.subkey("device-name"), { n: cleanDeviceName(name) }, aad(accountId, deviceId)));
}

/** Null if missing or not decryptable (e.g. tampered): the UI shows the short ID instead. */
export async function openDeviceName(key: AccountKey, accountId: string, deviceId: string, sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  try {
    const v = await unsealJson<{ n: string }>(await key.subkey("device-name"), fromBase64(sealed), aad(accountId, deviceId), "device name");
    return typeof v?.n === "string" ? v.n : null;
  } catch {
    return null;
  }
}
