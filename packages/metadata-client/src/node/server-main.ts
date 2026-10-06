// ddn-server: DDN_DB=<path> DDN_PORT=<port> npx tsx src/node/server-main.ts
// Binds to 127.0.0.1 only (stage 2: no public domain).
import { DdnServer } from "./server.js";

const srv = new DdnServer({ dbPath: process.env.DDN_DB ?? "ddn-server.db" });
const { url } = await srv.listen(Number(process.env.DDN_PORT ?? 8787), "127.0.0.1");
console.log(`ddn-server listening on ${url}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void srv.close().then(() => process.exit(0)));
