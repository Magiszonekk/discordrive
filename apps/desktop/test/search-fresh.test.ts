// A file uploaded from this device is found by a search by its date at once (an open search in the window
// is redone after each upload): its content date goes into the local index with the upload, not only after
// the background look at its manifest.
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";

const fake = new FakeDiscord();
const srv = new DdnServer({ rateLimits: false, signup: "open" });
afterAll(async () => {
  await srv.close().catch(() => {});
  await fake.close();
});

it("a new upload is found by its date right away (picked file and file from disk)", async () => {
  const origin = await fake.listen();
  const { url } = await srv.listen(0);
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-search-"));
  const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
  await core.createAccount(url, "search fresh");
  await core.open();
  await core.addWebhook(fake.addWebhook("1550000000000000802").url);
  // The background look at manifests must not be what finds them: it is kept from running.
  (core as unknown as { descRunning: boolean }).descRunning = true;
  const march = Date.UTC(2022, 2, 14, 12);
  await core.upload(new File(["a"], "IMG_0001.jpg", { lastModified: march }), "IMG_0001.jpg");
  const p = join(base, "IMG_0002.jpg");
  writeFileSync(p, "b");
  utimesSync(p, march / 1000, march / 1000);
  await core.uploadPath(p);
  expect((await core.search("2022-03")).map((h) => h.name).sort()).toEqual(["IMG_0001.jpg", "IMG_0002.jpg"]);
  core.close();
});
