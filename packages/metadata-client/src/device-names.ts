// Device display names. Decision (DECISIONS.md, etap 2):
// the name is sealed with the account key (subkey "device-name"), bound to the
// account and device ID, so the server stores an opaque blob and the contract
// for what the server sees in clear stays unchanged.

import { fromBase64, toBase64 } from "@ddv4/processing";
import { sealJson, unsealJson, type AccountKey } from "./account-key.js";

export const MAX_DEVICE_NAME = 64;
const aad = (accountId: string, deviceId: string) => `ddn-devname-v1|${accountId}|${deviceId}`;

export function cleanDeviceName(name: string): string {
  const n = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return [...n].slice(0, MAX_DEVICE_NAME).join("") || "device";
}

/**
 * What kind of device an entry is. "api": an API key (a device whose key was handed to scripts, the
 * command line or a local service). Kept next to the name, sealed: the server cannot tell an API key
 * from any other device. Older apps read only the name and ignore the kind.
 */
export type DeviceKind = "device" | "api";

export async function sealDeviceName(key: AccountKey, accountId: string, deviceId: string, name: string, kind: DeviceKind = "device"): Promise<string> {
  const v: { n: string; k?: DeviceKind } = { n: cleanDeviceName(name) };
  if (kind !== "device") v.k = kind;
  return toBase64(await sealJson(await key.subkey("device-name"), v, aad(accountId, deviceId)));
}

/** Name and kind; null if missing or not decryptable (e.g. tampered): the UI shows the short ID instead. */
export async function openDeviceInfo(key: AccountKey, accountId: string, deviceId: string, sealed: string | null | undefined): Promise<{ name: string; kind: DeviceKind } | null> {
  if (!sealed) return null;
  try {
    const v = await unsealJson<{ n: string; k?: string }>(await key.subkey("device-name"), fromBase64(sealed), aad(accountId, deviceId), "device name");
    if (typeof v?.n !== "string") return null;
    return { name: v.n, kind: v.k === "api" ? "api" : "device" };
  } catch {
    return null;
  }
}

/** Null if missing or not decryptable (e.g. tampered): the UI shows the short ID instead. */
export async function openDeviceName(key: AccountKey, accountId: string, deviceId: string, sealed: string | null | undefined): Promise<string | null> {
  return (await openDeviceInfo(key, accountId, deviceId, sealed))?.name ?? null;
}
