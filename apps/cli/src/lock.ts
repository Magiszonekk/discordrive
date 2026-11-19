// One process at a time per profile. The profile's file list and its queue of changes are one replica of the
// account: two processes writing it at once (a script's `ddn mkdir` next to a running `ddn serve`) collide in
// SQLite, and the second may report a failure for a change it did make. So a command takes the profile's lock
// first: `ddn serve` keeps it while it runs (other commands on that profile stop at once with EXIT.busy and do
// nothing), ordinary commands hold it for their few seconds and wait for each other.
//
// The lock is SQLite's own exclusive lock on <profile>/lock.db (an OS file lock: released when the process
// ends, also when it is killed, on Linux, macOS and Windows). lock.json next to it says who holds it, for the
// message only.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "./profile.js";

export interface ProfileLock {
  release(): void;
}

interface Holder {
  pid: number;
  cmd: string;
  at: number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

function holder(dir: string): Holder | null {
  try {
    const h = JSON.parse(readFileSync(join(dir, "lock.json"), "utf8")) as Holder;
    return typeof h?.pid === "number" && typeof h.cmd === "string" ? h : null;
  } catch {
    return null;
  }
}

const busyMessage = (h: Holder) =>
  `this profile is in use by \`ddn serve\` (process ${h.pid}): use its HTTP API (docs/local-api.md), stop it first, or sign in a second profile with the same key (ddn login --profile NAME)`;

/**
 * Take the profile's lock for `cmd`. `serve` and anything else waits while an ordinary command holds it
 * (`onWait` is told once); while `ddn serve` holds it, throws EXIT.busy without waiting.
 */
export async function lockProfile(dir: string, cmd: string, onWait?: (h: Holder | null) => void, pollMs = 200): Promise<ProfileLock> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "lock.db"));
  const tryTake = () => {
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
      return true;
    } catch (e) {
      if (/locked|busy/i.test(String((e as Error).message))) return false;
      db.close();
      throw e;
    }
  };
  let told = false;
  let servedBy: number | null = null;
  while (!tryTake()) {
    const h = holder(dir);
    // A serve seen twice in a row (not a stale lock.json a new holder has not rewritten yet): stop now.
    if (h && h.cmd === "serve" && alive(h.pid)) {
      if (servedBy === h.pid) {
        db.close();
        throw new CliError(EXIT.busy, busyMessage(h));
      }
      servedBy = h.pid;
    } else servedBy = null;
    if (!told && !servedBy) ((told = true), onWait?.(h));
    await new Promise((r) => setTimeout(r, pollMs));
  }
  try {
    writeFileSync(join(dir, "lock.json"), JSON.stringify({ pid: process.pid, cmd, at: Date.now() } satisfies Holder) + "\n", { mode: 0o600 });
  } catch {
    /* only for the message */
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      try {
        db.exec("ROLLBACK");
      } catch {
        /* closing releases it too */
      }
      db.close();
    },
  };
}
