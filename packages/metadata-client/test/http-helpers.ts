// Shared helpers for tests against the real HTTP server (127.0.0.1).
import { HttpApi, createAccountHttp, generateDeviceKey, newAccountKey, type AccountKey, type DeviceKey } from "../src/index.js";
import { DdnServer, type ServerOptions } from "../src/node/index.js";

export const servers: DdnServer[] = [];
export async function closeServers(): Promise<void> {
  for (const s of servers.splice(0)) await s.close().catch(() => {});
}

export async function startServer(opts: ServerOptions = {}): Promise<{ srv: DdnServer; url: string }> {
  const srv = new DdnServer(opts);
  servers.push(srv);
  const { url } = await srv.listen(0);
  return { srv, url };
}

export interface TestAccount {
  key: AccountKey;
  accountId: string;
  deviceId: string;
  device: DeviceKey;
  api: HttpApi;
}

/** New account with one device, signed in lazily through HttpApi. */
export async function newAccount(url: string, key: AccountKey = newAccountKey()): Promise<TestAccount> {
  const device = await generateDeviceKey();
  const r = await createAccountHttp(url, device, key);
  return { key, accountId: r.accountId, deviceId: r.deviceId, device, api: new HttpApi({ baseUrl: url, accountId: r.accountId, deviceId: r.deviceId, key: device, instanceId: r.instanceId }) };
}

/** Second device of the same account, added by `by` (pairing path without the mailbox). */
export async function addDevice(url: string, by: TestAccount): Promise<{ deviceId: string; device: DeviceKey; api: HttpApi }> {
  const device = await generateDeviceKey();
  const { deviceId } = await by.api.addDevice(device.publicKey);
  return { deviceId, device, api: new HttpApi({ baseUrl: url, accountId: by.accountId, deviceId, key: device }) };
}
