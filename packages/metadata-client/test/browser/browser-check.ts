// The metadata-only client in a real browser engine (koncept §4.1: browser +
// CLI are the MVP clients). Bundles src/index.ts for the browser (fails if
// anything Node-only leaks in), then in headless Chromium:
//   account over HTTP (Node server on 127.0.0.1, CORS for this origin only),
//   sealed vault, upload (WebCrypto, hash-wasm) to an in-page fake Discord,
//   encrypted log over HTTP, download + SHA-256 check, snapshot + restore,
//   and pairing of a Node device by the browser device (SAS must match).
// Usage: CHROMIUM_PATH=... npx tsx test/browser/browser-check.ts
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedArbiter, HttpApi, HttpPairingMailbox, MemoryTransport, MetadataClient, OpCodec, startPairing } from "../../src/index.js";
import { DdnServer } from "../../src/node/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [join(here, "..", "..", "src", "index.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "DDN",
  write: false,
  logLevel: "error",
});
const code = bundle.outputFiles[0]!.text;

// Static page origin for the browser, API server on another port (cross-origin, like production).
const page = createServer((_q, r) => (r.writeHead(200, { "content-type": "text/html" }), r.end("<!doctype html><title>ddn</title>")));
await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const srv = new DdnServer({ corsOrigins: [pageOrigin] });
const { url: api } = await srv.listen(0);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
try {
  const p = await browser.newPage();
  p.on("console", (m) => (m.type() === "error" ? console.error("[browser]", m.text()) : undefined));
  await p.goto(pageOrigin);
  // tsx/esbuild wrap named functions in __name(); the page callback below is
  // serialized as text and needs that helper in the page too.
  await p.addScriptTag({ content: "window.__name = (f) => f;" });
  await p.addScriptTag({ content: code });
  const pending = await startPairing();

  const r = await p.evaluate(
    async ({ api, offer }) => {
      const D = (globalThis as unknown as { DDN: typeof import("../../src/index.js") }).DDN;
      const acct = await D.createAccountHttp(api);
      const http = new D.HttpApi({ baseUrl: api, token: acct.token });
      const key = D.newAccountKey();
      const vault = new D.WebhookVault(http, key, acct.accountId);
      const hook = { id: "666666666666666666", url: "https://discord.com/api/webhooks/666666666666666666/" + "B".repeat(68) };
      await vault.addWebhook({ ...hook, channelId: "chan-b", guildId: null, label: "b", addedAt: 1 });
      const transport = new D.MemoryTransport();
      const c = new D.MetadataClient({
        device: { id: acct.deviceId, name: "Chromium" },
        arbiter: new D.EncryptedArbiter(new D.OpCodec(key, acct.accountId), http),
        transport,
        webhooks: D.toWebhookRefs(await vault.load()),
        chunkSize: 64 * 1024,
      });
      const data = new Uint8Array(300_000);
      for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
      const up = await c.upload(D.memorySource(data), "Film z wakacji.mp4");
      const parts: Uint8Array[] = [];
      await c.download(up.nodeId, { write: async (d) => void parts.push(new Uint8Array(d)) });
      const got = new Uint8Array(parts.reduce((a, x) => a + x.byteLength, 0));
      let o = 0;
      for (const x of parts) (got.set(x, o), (o += x.byteLength));
      const same = (await D.sha256Hex(got)) === (await D.sha256Hex(data));

      const io = D.clientBlobIO(c, transport, 2048);
      const loc = await D.createPointerMessage(io, key, acct.accountId, c.webhook(hook.id));
      await D.writeSnapshot({ io, key, accountId: acct.accountId, pointer: loc, log: http, store: c.store, now: () => Date.now() }, "base");
      const restored = await D.restoreFromDiscord(io, key, acct.accountId, loc);

      // Pair a Node device that showed `offer`.
      const cred = await http.addDevice();
      const { sas } = await D.acceptPairing(offer, { accountId: acct.accountId, accountKey: key.rawB64, deviceCredential: cred, fromDevice: "Chromium" }, new D.HttpPairingMailbox(api, acct.token));

      return {
        ua: navigator.userAgent,
        chunks: up.chunks,
        same,
        sha: up.version.plaintextSha256,
        restoredHead: restored.store.getMeta().headSeq,
        head: c.store.getMeta().headSeq,
        sas,
        hookId: hook.id,
      };
    },
    { api, offer: pending.offer },
  );

  // Node side: finish pairing, read the same encrypted log, compare state.
  const paired = await pending.complete(new HttpPairingMailbox(api, null));
  const httpB = new HttpApi({ baseUrl: api, token: paired!.bundle.deviceCredential.token });
  const b = new MetadataClient({
    device: { id: paired!.bundle.deviceCredential.deviceId, name: "node" },
    arbiter: new EncryptedArbiter(new OpCodec(paired!.key, paired!.bundle.accountId), httpB),
    transport: new MemoryTransport(),
    webhooks: [{ id: r.hookId, url: "mem://" }],
  });
  await b.pull();
  const nodeFile = [...b.store.allNodes()].find((n) => n.name === "Film z wakacji.mp4");
  const result = {
    engine: r.ua.replace(/^.*(HeadlessChrome\/[\d.]+).*$/, "$1"),
    uploadChunks: r.chunks,
    downloadHashOk: r.same,
    snapshotRestoreOk: r.restoredHead === r.head,
    pairingSasMatch: paired!.sas === r.sas,
    nodeSeesFile: nodeFile?.content?.plaintextSha256 === r.sha,
    nodeHead: b.replica.headSeq,
    browserHead: r.head,
  };
  console.log(JSON.stringify(result));
  failed = !(result.downloadHashOk && result.snapshotRestoreOk && result.pairingSasMatch && result.nodeSeesFile && result.nodeHead === result.browserHead);
} finally {
  await browser.close();
  await srv.close();
  page.close();
}
process.exit(failed ? 1 : 0);
