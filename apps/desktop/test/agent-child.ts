// Child process of agent-transfers.test.ts: an agent that opens the stored account and downloads one file
// to disk, to be killed (SIGKILL) halfway by the test.
import { h2Fetch } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";

const env = process.env as Record<string, string>;
const f = h2Fetch({ tls: { ca: env.DDN_T_CA } });
const core = new AppCore({ discordApiOrigin: env.DDN_T_ORIGIN }, nodePlatform({ dataDir: env.DDN_T_DATA!, downloadsDir: env.DDN_T_DL, discordFetch: f }));
await core.open();
await core.downloadToDisk(env.DDN_T_NODE!);
