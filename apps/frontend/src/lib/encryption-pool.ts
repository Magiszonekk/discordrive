// DiscorDrive v4 — Encryption Worker Pool
// Manages N Web Workers for parallel AES-GCM chunk encryption.

type PendingResolve = {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
};

const MAX_WORKERS = 4;

export class EncryptionPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waitQueue: { resolve: (worker: Worker) => void; reject: (err: Error) => void }[] = [];
  private pending = new Map<Worker, PendingResolve>();
  private destroyed = false;

  private constructor() {}

  /**
   * Create a pool of encryption workers and initialize each with the FEK.
   * Returns null if Workers are unavailable (falls back to main-thread encryption).
   */
  static async create(fekRaw: ArrayBuffer): Promise<EncryptionPool | null> {
    try {
      const count = Math.min(navigator.hardwareConcurrency ?? 4, MAX_WORKERS);
      const pool = new EncryptionPool();

      const initPromises: Promise<void>[] = [];

      for (let i = 0; i < count; i++) {
        const worker = new Worker(
          new URL("./encrypt.worker.ts", import.meta.url),
          { type: "module" },
        );

        const initPromise = new Promise<void>((resolve, reject) => {
          const onMessage = (e: MessageEvent) => {
            if (e.data.type === "ready") {
              worker.removeEventListener("message", onMessage);
              worker.addEventListener("message", (ev) =>
                pool.handleMessage(worker, ev),
              );
              resolve();
            } else if (e.data.type === "error") {
              reject(new Error(e.data.message));
            }
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", () =>
            reject(new Error("Worker failed to load")),
          );
        });

        // Each worker gets its own copy of the key material
        const fekCopy = fekRaw.slice(0);
        worker.postMessage({ type: "init", fekRaw: fekCopy }, [fekCopy]);

        pool.workers.push(worker);
        initPromises.push(initPromise);
      }

      await Promise.all(initPromises);
      pool.idle = [...pool.workers];
      return pool;
    } catch {
      return null;
    }
  }

  private handleMessage(worker: Worker, e: MessageEvent): void {
    const msg = e.data;
    const entry = this.pending.get(worker);
    if (!entry) return;

    this.pending.delete(worker);

    if (msg.type === "encrypted") {
      entry.resolve(msg.data);
    } else if (msg.type === "error") {
      entry.reject(new Error(msg.message));
    }

    // Return worker to idle pool or give it to a waiter
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter.resolve(worker);
    } else {
      this.idle.push(worker);
    }
  }

  private acquireWorker(): Promise<Worker> {
    if (this.destroyed) return Promise.reject(new Error("Pool is destroyed"));
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise<Worker>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  /**
   * Encrypt a chunk using a worker from the pool.
   * Waits for an idle worker if all are busy.
   * Transfers the chunk buffer zero-copy (the caller must not reuse it).
   */
  async encrypt(index: number, chunk: ArrayBuffer): Promise<ArrayBuffer> {
    if (this.destroyed) throw new Error("Pool is destroyed");

    const worker = await this.acquireWorker();

    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(worker, { resolve, reject });
      worker.postMessage({ type: "encrypt", index, chunk }, [chunk]);
    });
  }

  /** Terminate all workers immediately. */
  destroy(): void {
    this.destroyed = true;
    for (const worker of this.workers) {
      worker.terminate();
    }
    // Reject any pending operations
    for (const [, entry] of this.pending) {
      entry.reject(new Error("Pool destroyed"));
    }
    this.pending.clear();
    this.idle = [];
    // Reject any waiters
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error("Pool destroyed"));
    }
    this.waitQueue = [];
    this.workers = [];
  }
}
