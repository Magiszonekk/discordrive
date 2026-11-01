// "This computer only": the instance built into the desktop app. The same DdnServer the `discordrive`
// command runs, in metadata-only mode, inside its own utilityProcess, on 127.0.0.1 with a random port, its
// database in the app's data folder. No npm, no build: the server code is bundled into this file.
//
// Sign-up: the first account is the admin and the only one. Until it exists the instance is invite-only
// with a fresh one-shot code made at every start and handed to the app (never shown), so another program
// on this computer that finds the port cannot take the admin account first. Once the account exists,
// sign-up is closed.
//
// Messages from the main process: { type: "start", dataDir, discordApiOrigin? } → { type: "ready", url,
// invite | null } or { type: "error", message }.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DdnServer } from "@ddv4/metadata-client/node";

const parent = process.parentPort;
let srv: DdnServer | null = null;

async function start(o: { dataDir: string; discordApiOrigin?: string }) {
  mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  srv = new DdnServer({
    dbPath: join(o.dataDir, "instance.db"),
    mode: "metadata-only",
    signup: "invite",
    // One user on this computer: the per-IP limits only get in the way of the app itself.
    rateLimits: false,
    cdnOrigins: o.discordApiOrigin ? [o.discordApiOrigin] : [],
  });
  const accounts = Number((srv.db.prepare("SELECT COUNT(*) n FROM accounts").get() as { n: number }).n);
  let invite: string | null = null;
  if (accounts === 0) invite = srv.invites.create(24 * 3600_000, "first account (desktop app)", "desktop").code;
  else if (srv.signup !== "closed") srv.admin.setSignup("closed", null);
  const { url } = await srv.listen(0, "127.0.0.1");
  return { url, invite, accounts };
}

parent?.on("message", (e) => {
  const m = e.data as { type?: string; dataDir?: string; discordApiOrigin?: string };
  if (m?.type === "start" && typeof m.dataDir === "string" && !srv) {
    start({ dataDir: m.dataDir, discordApiOrigin: m.discordApiOrigin }).then(
      (r) => parent.postMessage({ type: "ready", ...r }),
      (err) => parent.postMessage({ type: "error", message: String((err as Error)?.message ?? err) }),
    );
  } else if (m?.type === "close-signup" && srv) {
    // The first account was made: nobody else may sign up here.
    srv.admin.setSignup("closed", null);
    parent.postMessage({ type: "signup-closed" });
  } else if (m?.type === "quit") quit("asked by the app");
});

let quitStarted = false;
function quit(why: string) {
  if (quitStarted) return;
  quitStarted = true;
  if (process.env.DDN_DESKTOP_DEBUG || process.env.DDN_DESKTOP_DATA) console.error(`[ddn] instance quits: ${why}`);
  // Open connections (a window's notifications) can hold the HTTP server's close: the database is what
  // matters, so it is closed after 2 s at the latest.
  const t = setTimeout(() => {
    try {
      srv?.db.close();
    } catch {
      /* closed already */
    }
    process.exit(0);
  }, 2000);
  void (srv ? srv.close() : Promise.resolve()).catch(() => {}).finally(() => (clearTimeout(t), process.exit(0)));
}
// The session ends (shut down, log out): the system sends SIGTERM to every process of the app at once,
// this one included. Close the database the same way as when the app asks.
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => quit(s));
