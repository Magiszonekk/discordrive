// Manifest layer.
//
// The tree stores only FileVersion.manifestRef. The chunk list of a version
// is immutable, lives next to the fragments (encrypted, on Discord in
// metadata-only mode) and is fetched only when a file is opened or
// downloaded. This module defines the manifest shape and a small bounded
// cache; fetching and decryption are injected (ManifestSource), so the core
// has no Discord or crypto dependency.
//
// Format compatibility (approved): the chunk list mirrors
// FileChunkManifestPlaintext from @ddv4/types (schemaVersion, chunkSizeBytes,
// chunks[index, blobId, ciphertextSizeBytes, ciphertextHash]) and adds the
// placement fields metadata-only mode needs because there is no server-side
// BlobPlacement table.

export interface ChunkRef {
  index: number;
  /** Logical blob ID (as in discordrive). */
  blobId: string;
  ciphertextSizeBytes: number;
  ciphertextHash?: string;
  /** Where the fragment lives (metadata-only mode). Opaque to the core. */
  placements?: { provider: string; locationId?: string; messageId?: string; attachmentId?: string }[];
}

export interface ChunkManifest {
  schemaVersion: number;
  chunkSizeBytes: number;
  chunks: ChunkRef[];
  /**
   * When the content was made, if the uploader knew (a photo's EXIF / camera date, a file's modification
   * time), ms since the epoch. Optional and inside the encrypted manifest: search and the gallery use it
   * instead of the upload time. Readers that do not know it ignore it.
   */
  takenAt?: number;
}

export interface ManifestSource {
  /** Fetch and decrypt the manifest behind a manifestRef. */
  load(manifestRef: string): Promise<ChunkManifest>;
}

/**
 * LRU cache of manifests keyed by manifestRef. Manifests are immutable, so
 * entries never need invalidation, only eviction by size.
 */
export class ManifestCache {
  private readonly entries = new Map<string, { m: ChunkManifest; bytes: number }>();
  private readonly inflight = new Map<string, Promise<ChunkManifest>>();
  private bytes = 0;

  constructor(
    private readonly source: ManifestSource,
    /** Budget in approximate bytes (default 32 MB). */
    readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  get sizeBytes(): number {
    return this.bytes;
  }
  get count(): number {
    return this.entries.size;
  }
  has(ref: string): boolean {
    return this.entries.has(ref);
  }

  async get(ref: string): Promise<ChunkManifest> {
    const hit = this.entries.get(ref);
    if (hit) {
      this.entries.delete(ref);
      this.entries.set(ref, hit);
      return hit.m;
    }
    const pending = this.inflight.get(ref);
    if (pending) return pending;
    const p = this.source
      .load(ref)
      .then((m) => {
        this.insert(ref, m);
        return m;
      })
      .finally(() => this.inflight.delete(ref));
    this.inflight.set(ref, p);
    return p;
  }

  private insert(ref: string, m: ChunkManifest): void {
    const bytes = estimateManifestBytes(m);
    this.entries.set(ref, { m, bytes });
    this.bytes += bytes;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.maxBytes || this.entries.size <= 1) break;
      this.entries.delete(k);
      this.bytes -= v.bytes;
    }
  }
}

/** Rough in-memory size: ~120 B per chunk (70–120 B serialized) + overhead. */
export function estimateManifestBytes(m: ChunkManifest): number {
  return 64 + m.chunks.length * 160;
}
