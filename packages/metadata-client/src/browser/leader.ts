// Main tab (one tab syncs, writes snapshots and owns the OPFS
// database; the others read through it). Web Locks: the lock is held for the
// tab's lifetime and released by the browser when the tab closes or crashes,
// so the next waiting tab takes over without timeouts or heartbeats.
// Same lock also serialises all uploads of the device on one ChannelPacer
// (the rate limit is per channel; tabs must not compete).

export interface Leadership {
  readonly isLeader: boolean;
  /** Resolves when this tab becomes the leader. */
  readonly ready: Promise<void>;
  /** Give up leadership (or stop waiting). */
  release(): void;
}

export function claimLeadership(name: string, onChange?: (leader: boolean) => void): Leadership {
  let leader = false;
  let releaseLock: (() => void) | null = null;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const abort = new AbortController();
  const held = new Promise<void>((r) => (releaseLock = r));
  navigator.locks
    .request(`ddn-leader:${name}`, { signal: abort.signal }, async () => {
      leader = true;
      onChange?.(true);
      resolveReady();
      await held;
      leader = false;
      onChange?.(false);
    })
    .catch(() => {
      /* aborted while waiting */
    });
  return {
    get isLeader() {
      return leader;
    },
    ready,
    release() {
      abort.abort();
      releaseLock?.();
    },
  };
}
