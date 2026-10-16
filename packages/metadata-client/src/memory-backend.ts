// A second kind of storage backend, in memory: tests use it to prove that the client core works with a
// backend that is not Discord, from upload to restore, without any format change. A bucket of objects
// with a key per blob; the pointer slot is one object rewritten in place.
//
// Placement: { provider: "memory-bucket", locationId: <backend id>, key: <object key> }.

import type { BlobGetContext, LaneFetch } from "./blob-store.js";
import type { BackendSlot, BlobBackend } from "./backends.js";
import type { BackendDescriptor } from "./snapshots.js";
import type { Placement, ReqTiming } from "./types.js";

export const MEMORY_BACKEND_KIND = "memory-bucket";

/** The storage itself (shared by every backend object pointing at it, like a server would be). */
export class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  private n = 0;
  puts = 0;
  gets = 0;
  newKey(): string {
    return `obj-${++this.n}`;
  }
}

export class MemoryBackend implements BlobBackend {
  readonly kind = MEMORY_BACKEND_KIND;
  retired = false;
  readonly slot: BackendSlot;

  constructor(
    readonly id: string,
    readonly bucket: MemoryBucket,
    readonly paceKey = `${MEMORY_BACKEND_KIND}:${id}`,
  ) {
    const b = bucket;
    this.slot = {
      create: async (data) => {
        const k = `slot-${b.newKey()}`;
        b.objects.set(k, new Uint8Array(data));
        return k;
      },
      read: async (k) => {
        const d = b.objects.get(k);
        if (!d) throw new Error("404 no such slot");
        return new Uint8Array(d);
      },
      write: async (k, data) => {
        if (!b.objects.has(k)) throw new Error("404 no such slot");
        b.objects.set(k, new Uint8Array(data));
      },
      remove: async (k) => (b.objects.delete(k) ? "deleted" : "gone"),
    };
  }

  get logChannel(): string | null {
    return null;
  }

  private keyOf(p: Placement): string {
    const key = (p as unknown as Record<string, unknown>).key;
    if (p.provider !== MEMORY_BACKEND_KIND || p.locationId !== this.id || typeof key !== "string") throw new Error("not a placement of this backend");
    return key;
  }

  async put(data: Uint8Array, _filename: string, _signal?: AbortSignal, timing?: ReqTiming): Promise<Placement> {
    const key = this.bucket.newKey();
    this.bucket.objects.set(key, new Uint8Array(data));
    this.bucket.puts++;
    if (timing) timing.st = 200;
    return { provider: MEMORY_BACKEND_KIND, locationId: this.id, key };
  }

  async get(p: Placement, _signal?: AbortSignal, _ctx?: BlobGetContext): Promise<Uint8Array> {
    const d = this.bucket.objects.get(this.keyOf(p));
    if (!d) throw new Error("404 no such object");
    this.bucket.gets++;
    return new Uint8Array(d);
  }

  async remove(p: Placement): Promise<"deleted" | "gone"> {
    return this.bucket.objects.delete(this.keyOf(p)) ? "deleted" : "gone";
  }

  async stat(p: Placement): Promise<{ exists: boolean; size?: number }> {
    const d = this.bucket.objects.get(this.keyOf(p));
    return d ? { exists: true, size: d.byteLength } : { exists: false };
  }

  async inspect(): Promise<{ label: string; paceKey: string }> {
    return { label: `memory ${this.id}`, paceKey: this.paceKey };
  }

  setCdnLanes(_lanes: LaneFetch[]): void {}
}

/** Builds memory backends from descriptors (restore from a rescue kit): `secret.bucket` names the bucket. */
export function memoryBackendFactory(buckets: Map<string, MemoryBucket>): (d: BackendDescriptor) => BlobBackend | null {
  return (d) => {
    if (d.kind !== MEMORY_BACKEND_KIND) return null;
    const b = buckets.get(d.secret?.bucket ?? "");
    return b ? new MemoryBackend(d.id, b, d.meta?.paceKey) : null;
  };
}
