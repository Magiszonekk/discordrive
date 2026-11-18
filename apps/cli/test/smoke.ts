// Smoke test of the real `ddn` executable (bin/ddn.mjs, a separate process like a user's shell): a local
// metadata-only instance and a fake Discord, an account + API key, then login / put / get of a big file
// with SHA-256, progress on stderr, exit codes. DDN_SMOKE_MB sets the size (default 64).
//   npx tsx apps/cli/test/smoke.ts
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, openSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordWebhookTransport, HttpApi, WebhookVault, createAccountHttp, createApiKey, generateDeviceKey, inspectForVault, newAccountKey } from "@ddv4/metadata-client";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";

const MB = Number(process.env.DDN_SMOKE_MB ?? 64);
const bin = fileURLToPath(new URL("../bin/ddn.mjs", import.meta.url));
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-smoke-"));
const fake = new FakeDiscord();
fake.blobDir = join(tmp, "blobs");
mkdirSync(fake.blobDir);
const origin = await fake.listen();
const srv = new DdnServer({ dbPath: join(tmp, "ddn.db"), rateLimits: false, signup: "open" });
const { url } = await srv.listen(0);
const key = newAccountKey();
const dk = await generateDeviceKey();
const a = await createAccountHttp(url, dk, key);
const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk, instanceId: a.instanceId });
const v = new WebhookVault(api, key, a.accountId);
for (const c of ["1550000000000000701", "1550000000000000702", "1550000000000000703"]) await v.addWebhook(await inspectForVault(new DiscordWebhookTransport({ apiOrigin: origin }), fake.addWebhook(c).url));
const made = await createApiKey(api, { server: url, instanceId: a.instanceId, accountId: a.accountId, key }, "smoke");
writeFileSync(join(tmp, "key.txt"), made.text + "\n");

const big = join(tmp, "big.bin");
const h = createHash("sha256");
const fd = openSync(big, "w");
for (let i = 0; i < MB; i++) {
  const b = randomBytes(1024 * 1024);
  h.update(b);
  writeSync(fd, b);
}
closeSync(fd);
const want = h.digest("hex");

const env = { ...process.env, DDN_CONFIG_DIR: join(tmp, "conf"), DDN_TEST_DISCORD_ORIGIN: origin };
const ddn = (...args: string[]) =>
  new Promise<{ code: number; out: string; err: string; ms: number }>((res) => {
    const t0 = Date.now();
    execFile(process.execPath, [bin, ...args], { env, maxBuffer: 64 << 20 }, (e, out, err) => res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err, ms: Date.now() - t0 }));
  });
const sha = (p: string) => new Promise<string>((res) => { const x = createHash("sha256"); createReadStream(p).on("data", (d) => x.update(d)).on("end", () => res(x.digest("hex"))); });

const r: Record<string, unknown> = { MB };
r.notSignedIn = (await ddn("whoami")).code;
const lg = await ddn("login", "--key-file", join(tmp, "key.txt"));
r.login = lg.code;
r.loginOut = (lg.out + lg.err).trim().slice(-400);
r.whoami = (await ddn("whoami", "--json")).out.trim();
const put = await ddn("put", "--parents", big, "/Smoke/");
r.put = { code: put.code, ms: put.ms, mbps: +(MB / (put.ms / 1000)).toFixed(1), out: put.out.trim() };
const ls = await ddn("ls", "-l", "/Smoke");
r.ls = ls.out.trim();
const get = await ddn("get", "/Smoke/big.bin", join(tmp, "back.bin"));
r.get = { code: get.code, ms: get.ms, mbps: +(MB / (get.ms / 1000)).toFixed(1) };
r.getOut = (get.out + get.err).trim().slice(-600);
r.putErr = put.err.trim().slice(-600);
r.sha256Ok = get.code === 0 && (await sha(join(tmp, "back.bin"))) === want;
r.missing = (await ddn("get", "/Smoke/none.bin", tmp)).code;
// A reader that stops early: quiet end, no Node stack (exit 0 or the shell's SIGPIPE status).
const pipe = (cmd: string) =>
  new Promise<{ code: number; err: string }>((res) => {
    execFile("bash", ["-c", cmd], { env }, (e, _o, err) => res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err }));
  });
if (process.platform !== "win32") {
  for (let i = 0; i < 60; i++) await ddn("mkdir", `/Smoke/d${String(i).padStart(2, "0")}`);
  const q = JSON.stringify(process.execPath);
  const b = JSON.stringify(bin);
  // A transfer whose report is cut short (`| grep -m1`, `| head -1`) still sends every file.
  const many = join(tmp, "many");
  mkdirSync(many);
  for (let i = 0; i < 10; i++) writeFileSync(join(many, `f${i}.txt`), `file ${i}`);
  const cut = await pipe(`set -o pipefail; ${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} put --json --parents ${JSON.stringify(many)} /Cut/ | head -1 >/dev/null`);
  const left = await ddn("ls", "/Cut/many", "--json");
  r.putCut = { code: cut.code, quiet: !/EPIPE|node:events|Error:/.test(cut.err), files: left.out.trim().split("\n").filter((l) => l.includes('"kind":"file"')).length };
  r.epipe = [await pipe(`${q} ${b} ls /Smoke --json | head -1 >/dev/null`), await pipe(`${q} ${b} get /Smoke/big.bin - | head -c 100 >/dev/null`)].map((x) => ({ code: x.code, quiet: !/EPIPE|node:events|Error:/.test(x.err) }));
}
await api.revokeDevice(made.deviceId);
const rev = await ddn("ls", "/");
r.revoked = { code: rev.code, err: rev.err.trim() };
console.log(JSON.stringify(r, null, 1));
const pc = r.putCut as { code: number; quiet: boolean; files: number } | undefined;
const epipeOk = (!r.epipe || (r.epipe as { quiet: boolean }[]).every((x) => x.quiet)) && (!pc || (pc.files === 10 && pc.quiet));
const ok = epipeOk && r.notSignedIn === 5 && r.login === 0 && put.code === 0 && get.code === 0 && r.sha256Ok === true && r.missing === 3 && rev.code === 5;
await srv.close();
await fake.close();
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
