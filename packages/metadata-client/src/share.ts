// Share links, client side.
//
// Owner: collects the attachment addresses of ONE file version (manifest
// first, then fragments in order), seals {name, size, sha256, mime} with that
// file's own key, registers the share on the server and builds
//   <origin>/s/<shareId>#<file key, base64url>
// The fragment after '#' never reaches the server. The link never carries the
// account key.
//
// Recipient: asks the server for fresh CDN links (the server refreshes them
// with its bot), downloads from the CDN, checks hashes, decrypts locally.

import { fromBase64, toBase64 } from "@ddv4/processing";
import { createSHA256 } from "hash-wasm";
import type { ChunkManifest } from "@ddv4/sync-core";
import { BLOB_EXT, decodeManifestRef, type ByteSink } from "./drive-client.js";
import { decryptFragment, decryptManifest, encryptManifest, importFileKey, sha256Hex } from "./file-crypto.js";
import { isDiscordPlacement, type Placement, type WebhookRef, type WebhookTransport } from "./types.js";

export interface ShareMeta {
  v: 1;
  name: string;
  size: number;
  sha256: string;
  mime?: string;
}

export interface ShareAttachment {
  channelId: string;
  attachmentId: string;
  filename: string;
}

const b64u = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64u(s: string): string {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return t;
}

/** Attachment filename from a CDN URL (/attachments/<channel>/<id>/<name>). */
export function attachmentFilename(url: string): string {
  const m = /\/attachments\/\d+\/\d+\/([^/?#]+)/.exec(url);
  if (!m) throw new Error("unexpected CDN url shape");
  return decodeURIComponent(m[1]!);
}

/**
 * Everything the server needs for one file version. Fragments were posted as
 * `<blobId>` + BLOB_EXT; the manifest name is not recorded, so it is read from the
 * manifest message once (one webhook GET). Metadata only.
 */
export async function prepareShare(
  o: {
    transport: WebhookTransport;
    hook: (id: string) => WebhookRef;
    loadManifest: (ref: string) => Promise<{ manifest: ChunkManifest }>;
  },
  manifestRef: string,
  meta: Omit<ShareMeta, "v">,
): Promise<{ attachments: ShareAttachment[]; meta: string; fileKey: string }> {
  return prepareShareWith(
    {
      loadManifest: o.loadManifest,
      attachments: async (loc, manifest) => {
        // A share link reads Discord attachments through the instance's bot; other backends have no such path yet.
        const onDiscord = (p: Placement | undefined) => !p || isDiscordPlacement(p);
        if (!onDiscord(loc.at) || manifest.chunks.some((c) => !onDiscord(c.placements?.[0] as Placement | undefined))) throw new Error("share_unavailable: this file is stored on a backend that cannot be shared");
        const atts = await o.transport.getAttachments(o.hook(loc.at.locationId), (loc.at as { messageId: string }).messageId);
        const at = loc.at as { attachmentId: string; channelId: string };
        const ma = atts.find((a) => a.id === at.attachmentId);
        if (!ma) throw new Error("manifest attachment missing");
        const out: ShareAttachment[] = [{ channelId: at.channelId, attachmentId: at.attachmentId, filename: attachmentFilename(ma.url) }];
        for (const c of manifest.chunks) {
          const p = c.placements?.[0] as Placement | undefined;
          if (!p || !isDiscordPlacement(p) || !p.attachmentId || !p.channelId) throw new Error(`chunk ${c.index}: no placement`);
          out.push({ channelId: p.channelId, attachmentId: p.attachmentId, filename: `${c.blobId}${BLOB_EXT}` });
        }
        return out;
      },
    },
    manifestRef,
    meta,
  );
}

/**
 * Share of one file version with the attachment addresses from any source (e2ee/plain: the
 * instance knows the names it posted under). Manifest first, then fragments in order.
 */
export async function prepareShareWith(
  o: {
    loadManifest: (ref: string) => Promise<{ manifest: ChunkManifest }>;
    attachments: (loc: ReturnType<typeof decodeManifestRef>, manifest: ChunkManifest) => Promise<ShareAttachment[]>;
  },
  manifestRef: string,
  meta: Omit<ShareMeta, "v">,
): Promise<{ attachments: ShareAttachment[]; meta: string; fileKey: string }> {
  const loc = decodeManifestRef(manifestRef);
  const { manifest } = await o.loadManifest(manifestRef);
  const out = await o.attachments(loc, manifest);
  const key = await importFileKey(loc.k);
  const sealed = await encryptManifest(key, { v: 1, ...meta } as unknown as ChunkManifest);
  return { attachments: out, meta: toBase64(sealed), fileKey: b64u(loc.k) };
}

export function shareLink(origin: string, shareId: string, fileKeyB64u: string): string {
  return `${origin.replace(/\/$/, "")}/s/${shareId}#${fileKeyB64u}`;
}

export function parseShareLink(href: string): { shareId: string; key: string } | null {
  const u = new URL(href);
  const m = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(u.pathname);
  const k = u.hash.slice(1);
  if (!m || !/^[A-Za-z0-9_-]{40,}$/.test(k)) return null;
  return { shareId: m[1]!, key: unb64u(k) };
}

export interface OpenedShare {
  meta: ShareMeta;
  download(sink: ByteSink, onProgress?: (done: number, total: number) => void): Promise<void>;
}

/** Recipient side. `server` = instance origin; `cdnFetch` lets tests point CDN links at a fake. */
export async function openShare(server: string, shareId: string, keyB64: string, f: typeof fetch = (...a) => fetch(...a)): Promise<OpenedShare> {
  const key = await importFileKey(keyB64);
  const r = await f(`${server}/v1/shares/${shareId}`);
  if (r.status === 404) throw new Error("share not found or revoked");
  if (!r.ok) throw new Error(`share: HTTP ${r.status}`);
  const info = (await r.json()) as { meta: string; count: number };
  let meta: ShareMeta;
  try {
    meta = (await decryptManifest(key, fromBase64(info.meta))) as unknown as ShareMeta;
  } catch {
    throw new Error("wrong key in the link");
  }
  const urls = async (from: number, n: number): Promise<string[]> => {
    const u = await f(`${server}/v1/shares/${shareId}/urls?from=${from}&n=${n}`);
    if (!u.ok) throw new Error(`share urls: HTTP ${u.status}`);
    return ((await u.json()) as { urls: string[] }).urls;
  };
  const get = async (url: string): Promise<Uint8Array> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await f(url);
        if (!res.ok) throw new Error(`cdn: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
      }
    }
  };
  return {
    meta,
    async download(sink, onProgress) {
      const [murl] = await urls(0, 1);
      const manifest = await decryptManifest(key, await get(murl!));
      const hasher = await createSHA256();
      hasher.init();
      const parts = manifest.chunks.length;
      let done = 0;
      for (let i = 0; i < parts; i += 50) {
        const batch = await urls(1 + i, Math.min(50, parts - i));
        for (let k = 0; k < batch.length; k++) {
          const c = manifest.chunks[i + k]!;
          const ct = await get(batch[k]!);
          if (c.ciphertextHash && (await sha256Hex(ct)) !== c.ciphertextHash) throw new Error(`chunk ${c.index}: hash mismatch`);
          const pt = await decryptFragment(key, ct);
          hasher.update(pt);
          await sink.write(pt);
          done += pt.byteLength;
          onProgress?.(done, meta.size);
        }
      }
      // Whole-file check (plaintext SHA-256 from the owner's index).
      if (meta.sha256 && hasher.digest("hex") !== meta.sha256) throw new Error("file hash mismatch");
    },
  };
}
