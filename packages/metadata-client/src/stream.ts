// Service-worker side of streaming: answers GET /ddn/file/<nodeId>
// with Range support from MetadataClient.readRange, so <video src> plays and
// seeks while only the needed fragments are fetched from the CDN and
// decrypted in the browser. Pure Request -> Response, testable in Node.

import type { DriveClient as MetadataClient } from "./drive-client.js";

export const STREAM_PREFIX = "/ddn/file/";
/** Cap for open-ended "bytes=N-" requests: about one fragment, so seeking stays cheap. */
export const MAX_OPEN_RANGE = 10 * 1024 * 1024;

export function parseRange(h: string | null, size: number, maxOpen = MAX_OPEN_RANGE): { start: number; end: number } | "invalid" | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? Math.min(size - 1, start + maxOpen - 1) : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

export async function handleStreamRequest(
  req: Request,
  client: MetadataClient,
  opts: { cache?: Map<string, Uint8Array>; contentType?: (name: string) => string; maxOpenRange?: number } = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(STREAM_PREFIX) || req.method !== "GET") return null;
  const nodeId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
  const node = client.store.getNode(nodeId);
  if (!node || node.kind !== "file" || !node.content || node.trashed) return new Response("not found", { status: 404 });
  const size = node.content.sizeBytes;
  const type = opts.contentType?.(node.name) ?? guessType(node.name);
  const base = { "accept-ranges": "bytes", "content-type": type, "cache-control": "no-store" };
  const maxOpen = opts.maxOpenRange ?? MAX_OPEN_RANGE;
  const range = parseRange(req.headers.get("range"), size, maxOpen);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  // No Range header: answer the first window as 206 if the file is larger, so the
  // player switches to ranged requests instead of downloading everything.
  const { start, end } = range ?? { start: 0, end: Math.min(size - 1, maxOpen - 1) };
  if (size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...base, "content-length": "0" } });
  const r = await client.readRange(nodeId, start, end, opts.cache);
  const whole = r.start === 0 && r.end === size - 1;
  return new Response(r.data as BodyInit, {
    status: whole ? 200 : 206,
    headers: { ...base, "content-length": String(r.data.byteLength), ...(whole ? {} : { "content-range": `bytes ${r.start}-${r.end}/${size}` }) },
  });
}

/** Content type of a file by its name (players need it: an MP4 that starts with `mdat` is not sniffed). */
export function guessType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf", txt: "text/plain; charset=utf-8" } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}
