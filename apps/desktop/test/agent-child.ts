// Child process of agent-transfers.test.ts: an agent that opens the stored account and downloads one file
// to disk, to be killed (SIGKILL) halfway by the test. Steps go to stderr (shown when the test fails).
import { h2Fetch } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";

const t0 = Date.now();
const say = (s: string) => process.stderr.write(`[child +${Date.now() - t0} ms] ${s}\n`);
const env = process.env as Record<string, string>;
const f = h2Fetch({ tls: { ca: env.DDN_T_CA } });
const core = new AppCore({ discordApiOrigin: env.DDN_T_ORIGIN }, nodePlatform({ dataDir: env.DDN_T_DATA!, downloadsDir: env.DDN_T_DL, discordFetch: f }));
core.onEvent = (e) => {
  if (e.type === "download-progress") say(`progress ${e.done}/${e.total}`);
};
say("open");
await core.open();
say("download");
await core.downloadToDisk(env.DDN_T_NODE!, undefined, "t");
say("done");
