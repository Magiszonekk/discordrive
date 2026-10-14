// File preview (zlecenie 2026-10-13-webhooki p. 4): a full-screen dialog over the file list with
// ←/→ (keys and buttons) to the previous / next FILE of the folder (folders skipped, across the
// keyset pages of core.list), Esc to close and a Download button.
//
// Security (the file is untrusted, whoever uploaded it):
// - Text, code, JSON, CSV and Markdown go into the page only as DOM text nodes (textContent /
//   createTextNode), never through innerHTML. Markdown is parsed by markdown.ts into a tree of
//   whitelisted tags; raw HTML in it stays text, links keep only http/https/mailto, images are not
//   loaded (alt text instead). That is why it does not need a sandboxed iframe: nothing in it can
//   become markup, and it inherits the theme of the page.
// - Images (SVG included) are shown only as <img src="blob:…">: an SVG document in an <img> never
//   runs scripts or loads anything. Never inline, never <iframe>/<object> for SVG.
// - PDF: the browser's own viewer in an <iframe src="blob:…"> of type application/pdf. Chrome
//   refuses to render a PDF in a sandboxed iframe (tested: sandbox="", "allow-same-origin" and
//   "allow-scripts" all show the blocked-content page), so the frame has no sandbox attribute; the
//   blob holds only bytes we fetched ourselves, typed application/pdf (never text/html, so it is
//   never parsed as a page of this origin). The CSP gains exactly "frame-src 'self' blob:" for it
//   (static.ts). Where the browser has no inline viewer (navigator.pdfViewerEnabled === false,
//   phones: Android Chrome downloads instead) the dialog explains that and offers Download.
// - Every blob gets its real Content-Type; blob URLs are revoked when the file changes or the
//   dialog closes. Only the last requested file renders (a sequence number drops stale loads).
//
// Reading: text-like files read only their first TEXT_LIMIT bytes with core.readRange (only the
// fragments overlapping the range are fetched and decrypted), images/PDF the whole file with
// core.download (local decryption and verification, like Download), audio/video stream through
// the same source as the video player (service worker /ddn/file/<id>, or the server stream URL in
// plain). plain: the server thumbnail is shown while the full image loads.
//
// No DOM access at module load: the pure helpers below are unit-tested in Node
// (apps/ddn-server/test/preview.test.ts).

import { fmtNum, fmtSize, t } from "./i18n.js";
import { MD_ATTRS, MD_TAGS, parseMarkdown, type MdNode } from "./markdown.js";

export const TEXT_LIMIT = 2 * 1024 * 1024;
export const IMAGE_LIMIT = 25 * 1024 * 1024;
export const PDF_LIMIT = 100 * 1024 * 1024;
export const TABLE_ROWS = 500;
/** Page size when walking the folder for ←/→. */
const LIST_PAGE = 500;

export type PreviewKind = "text" | "markdown" | "json" | "csv" | "tsv" | "image" | "pdf" | "audio" | "video" | "none";

const TEXT_EXT =
  "txt text log md markdown json jsonl ndjson csv tsv yaml yml xml ini toml conf cfg env properties srt vtt " +
  "ts tsx mts cts js jsx mjs cjs py pyw go rs java kt kts scala c h cc cpp cxx hpp hh cs fs swift m mm rb php pl pm lua r dart " +
  "sh bash zsh fish ps1 psm1 bat cmd css scss sass less html htm xhtml svelte vue astro sql graphql gql proto " +
  "gradle cmake mk make dockerfile tf hcl nix ex exs erl hs ml clj el vim diff patch gitignore gitattributes editorconfig lock";
const TEXT_NAMES = /^(dockerfile|makefile|readme|license|licence|changelog|authors|contributing|notice|copying|procfile|gemfile|rakefile|vagrantfile)$/i;
const MIME: Record<string, [PreviewKind, string]> = {
  md: ["markdown", "text/markdown"],
  markdown: ["markdown", "text/markdown"],
  json: ["json", "application/json"],
  csv: ["csv", "text/csv"],
  tsv: ["tsv", "text/tab-separated-values"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  jfif: ["image", "image/jpeg"],
  png: ["image", "image/png"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
  bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
  svg: ["image", "image/svg+xml"],
  pdf: ["pdf", "application/pdf"],
  mp3: ["audio", "audio/mpeg"],
  ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"],
  opus: ["audio", 'audio/ogg; codecs="opus"'],
  wav: ["audio", "audio/wav"],
  m4a: ["audio", "audio/mp4"],
  aac: ["audio", "audio/aac"],
  flac: ["audio", "audio/flac"],
  webm: ["video", "video/webm"],
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  mov: ["video", "video/quicktime"],
  mkv: ["video", "video/x-matroska"],
  ogv: ["video", "video/ogg"],
};
for (const e of TEXT_EXT.split(/\s+/)) MIME[e] ??= ["text", "text/plain"];

/** What the preview does with a file, from its name (the index keeps no MIME type). */
export function previewKind(name: string): { kind: PreviewKind; mime: string } {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const hit = dot >= 0 ? (Object.prototype.hasOwnProperty.call(MIME, ext) ? MIME[ext] : undefined) : TEXT_NAMES.test(name) ? (["text", "text/plain"] as [PreviewKind, string]) : undefined;
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: "none", mime: "application/octet-stream" };
}

/**
 * Length of the longest prefix of `b` that does not end inside a UTF-8 sequence (a read cut at
 * TEXT_LIMIT may split a character; its first bytes are dropped instead of becoming U+FFFD).
 */
export function utf8CutPoint(b: Uint8Array): number {
  for (let k = b.length - 1; k >= 0 && k >= b.length - 4; k--) {
    const x = b[k]!;
    if ((x & 0xc0) === 0x80) continue; // continuation byte: look further back for the lead byte
    // 0xF8..0xFF never start a character (they decode to U+FFFD whatever follows): nothing to cut.
    const need = x >= 0xf8 ? 1 : x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 1;
    return b.length - k >= need ? b.length : k;
  }
  return b.length;
}

/** UTF-8 text of a (possibly cut) read; invalid bytes become U+FFFD, a leading BOM is dropped. */
export function decodeText(b: Uint8Array, truncated: boolean): string {
  return new TextDecoder("utf-8").decode(truncated ? b.subarray(0, utf8CutPoint(b)) : b);
}

/**
 * JSON re-indented with 2 spaces, or null when it is not valid JSON. Validated with JSON.parse,
 * but printed from the original tokens, so numbers keep their exact digits (JSON.stringify of a
 * parsed 12345678901234567890 would show a different number).
 */
export function prettyJson(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const out: string[] = [];
  let depth = 0;
  const nl = () => "\n" + "  ".repeat(depth);
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (text[j] === (c === "{" ? "}" : "]")) {
        out.push(c === "{" ? "{}" : "[]");
        i = j;
      } else {
        depth++;
        out.push(c, nl());
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out.push(nl(), c);
    } else if (c === ",") out.push(",", nl());
    else if (c === ":") out.push(": ");
    else if (!/\s/.test(c)) out.push(c);
  }
  return out.join("");
}

/**
 * CSV / TSV (RFC 4180 quoting: a field starting with " runs to the closing ", "" is a quote,
 * separators and newlines inside quotes are data). Stops after `maxRows` rows; `more` = rows left.
 */
export function parseDelimited(text: string, sep: string, maxRows: number): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      // Copy up to the next quote in one go (fields with long text).
      const q = text.indexOf('"', i);
      const end = q < 0 ? n : q;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === sep) {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      if (rows.length >= maxRows) return { rows, more: i < n };
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length || quoted) {
    row.push(field);
    rows.push(row);
  }
  return { rows, more: false };
}

/** Inline PDF viewer in this browser? (Android Chrome and other phones download PDFs instead.) */
export function pdfInline(nav: { pdfViewerEnabled?: boolean; userAgent?: string }): boolean {
  if (nav.pdfViewerEnabled === false) return false;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? "");
}

// ── the dialog ──────────────────────────────────────────────────────

export interface PreviewRow {
  id: string;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  cursor?: string;
  /** Unavailable file (a piece on a removed channel): no preview, an explanation instead. */
  unavailable?: string[];
}
/** The part of the worker core the preview uses (structural: no import of app-core here). */
export interface PreviewCore {
  list(folder: string, after?: string, limit?: number): Promise<{ rows: PreviewRow[]; total: number }>;
  readRange(id: string, start: number, end: number): Promise<{ data: Uint8Array; size: number }>;
  download(id: string): Promise<Blob>;
  thumbnail(id: string): Promise<Blob | null>;
  streamUrl(id: string): Promise<string | null>;
}
export interface PreviewDeps {
  core: PreviewCore;
  features: () => { thumbnails: boolean; streaming: boolean };
  /** Save the file (ui.ts download: whole file, verified). */
  download: (id: string, name: string) => Promise<unknown>;
  /** Show an error (toast). */
  error: (e: unknown) => void;
}

/** Files of one folder in name order, loaded page by page with core.list (folders skipped). */
export class FolderFiles {
  files: PreviewRow[] = [];
  private cursor: string | undefined;
  done = false;
  constructor(
    private readonly core: PreviewCore,
    private readonly folder: string | null,
    fixed?: PreviewRow[],
    private readonly pageSize = LIST_PAGE,
  ) {
    if (fixed) {
      this.files = fixed.filter((r) => r.kind === "file");
      this.done = true;
    }
  }
  private loading: Promise<number> | null = null;
  /** Load the next page; concurrent callers share one request (a page must never be added twice). */
  private more(): Promise<number> {
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }
  private async load(): Promise<number> {
    const before = this.files.length;
    if (this.done || this.folder === null) return ((this.done = true), before);
    const pg = await this.core.list(this.folder, this.cursor, this.pageSize);
    for (const r of pg.rows) if (r.kind === "file") this.files.push(r);
    this.cursor = pg.rows.at(-1)?.cursor;
    if (pg.rows.length < this.pageSize || !this.cursor) this.done = true;
    return before;
  }
  async indexOf(id: string): Promise<number> {
    let from = 0;
    for (;;) {
      for (; from < this.files.length; from++) if (this.files[from]!.id === id) return from;
      if (this.done) return -1;
      await this.more();
    }
  }
  async at(i: number): Promise<PreviewRow | null> {
    while (i >= this.files.length && !this.done) await this.more();
    return i >= 0 ? (this.files[i] ?? null) : null;
  }
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** Markdown tree -> DOM (whitelisted tags and attributes only, text as text nodes). */
export function markdownDom(nodes: MdNode[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const build = (n: MdNode): Node => {
    if (typeof n === "string") return document.createTextNode(n);
    if (!MD_TAGS.has(n.t)) return document.createTextNode("");
    const el = document.createElement(n.t);
    for (const [k, v] of Object.entries(n.a ?? {})) if (MD_ATTRS.has(k)) el.setAttribute(k, v);
    for (const c of n.c) el.append(build(c));
    return el;
  };
  for (const n of nodes) frag.append(build(n));
  return frag;
}

export interface Preview {
  /** Open a file; siblings for ←/→ come from `folder` (core.list paging) or from `rows` (search hits). */
  open(row: PreviewRow, from: { folder: string } | { rows: PreviewRow[] }): void;
  close(): void;
}

export function createPreview(deps: PreviewDeps): Preview {
  let dlg: HTMLDialogElement | null = null;
  let body: HTMLElement;
  let title: HTMLElement;
  let prevBtn: HTMLButtonElement;
  let nextBtn: HTMLButtonElement;
  let dlBtn: HTMLButtonElement;
  let list: FolderFiles | null = null;
  let index = -1;
  /** Resolves when the opened file's position in the folder is known. */
  let located: Promise<void> = Promise.resolve();
  /** Target of the ←/→ step in flight (several quick presses add up), -1 = none. */
  let want = -1;
  let current: PreviewRow | null = null;
  /** Bumped on every file shown and on close: async work of an older value is dropped. */
  let seq = 0;
  /** Bumped on every ←/→: only the last step shows its file. */
  let navSeq = 0;
  let urls: string[] = [];
  let media: HTMLMediaElement | null = null;

  const q = <T extends HTMLElement>(k: string) => dlg!.querySelector<T>(`[data-ddn="${k}"]`)!;

  function wire() {
    if (dlg) return;
    dlg = document.querySelector<HTMLDialogElement>('[data-ddn="preview-dialog"]')!;
    body = q("preview-body");
    title = q("preview-title");
    prevBtn = q("preview-prev");
    nextBtn = q("preview-next");
    dlBtn = q("preview-download");
    prevBtn.onclick = () => void go(-1);
    nextBtn.onclick = () => void go(1);
    q("preview-close").onclick = () => close();
    dlBtn.onclick = () => void save(dlBtn);
    dlg.addEventListener("close", () => reset());
    document.addEventListener("keydown", (e) => {
      if (!dlg?.open || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tgt = e.target as HTMLElement | null;
      // Arrows keep their own meaning in media controls and fields.
      if (tgt && (tgt.closest("audio, video, input, textarea, select") || tgt.isContentEditable)) return;
      e.preventDefault();
      void go(e.key === "ArrowLeft" ? -1 : 1);
    });
  }

  async function save(btn: HTMLElement) {
    const f = current;
    if (!f || btn.getAttribute("aria-busy") === "true") return;
    btn.setAttribute("aria-busy", "true");
    try {
      await deps.download(f.id, f.name);
    } catch (e) {
      deps.error(e);
    } finally {
      btn.removeAttribute("aria-busy");
    }
  }

  /** Stop media, revoke blob URLs, drop pending loads. */
  function reset() {
    seq++;
    if (media) {
      media.pause();
      media.removeAttribute("src");
      media.load();
      media = null;
    }
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    body?.replaceChildren();
  }

  function close() {
    if (dlg?.open) dlg.close();
    else reset();
  }

  function message(text: string, withDownload = true, tone = "") {
    const box = h("div", { class: `pv-msg${tone ? ` ${tone}` : ""}`, "data-ddn": "preview-msg" }, h("p", {}, text));
    if (withDownload) {
      const b = h("button", { class: "btn primary", type: "button", "data-ddn": "preview-download-msg" }, t("pv.download"));
      b.onclick = () => void save(b);
      box.append(b);
    }
    return box;
  }

  function note(text: string) {
    return h("p", { class: "pv-note muted", "data-ddn": "preview-note" }, text);
  }

  async function navState() {
    const my = seq;
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = true;
    const nx = list ? await list.at(index + 1).catch(() => null) : null;
    if (my === seq) nextBtn.disabled = !nx;
  }

  async function go(delta: number) {
    if (!list || !dlg?.open) return;
    const l = list;
    await located; // the position in the folder is looked up when the preview opens
    if (l !== list || index < 0) return;
    const target = (want >= 0 ? want : index) + delta;
    if (target < 0) return;
    want = target;
    const my = ++navSeq;
    const f = await l.at(target).catch(() => null);
    if (my !== navSeq || l !== list || !dlg.open) return;
    want = -1;
    if (!f) return void navState();
    index = target;
    show(f);
  }

  function open(row: PreviewRow, from: { folder: string } | { rows: PreviewRow[] }) {
    wire();
    list = "folder" in from ? new FolderFiles(deps.core, from.folder) : new FolderFiles(deps.core, null, from.rows);
    index = -1;
    want = -1;
    if (!dlg!.open) dlg!.showModal();
    show(row);
    const l = list;
    located = l.indexOf(row.id).catch(() => -1).then((i) => {
      if (l !== list) return;
      if (i < 0) {
        // Not in the folder any more (renamed away, another device): browse just this file.
        list = new FolderFiles(deps.core, null, [row]);
        index = 0;
      } else index = i;
      void navState();
    });
  }

  function show(f: PreviewRow) {
    reset();
    const my = seq;
    current = f;
    const { kind, mime } = previewKind(f.name);
    const size = f.size ?? 0;
    title.textContent = f.name;
    title.title = f.name;
    dlg!.dataset.kind = kind;
    dlg!.dataset.file = f.name;
    dlg!.dataset.state = "loading";
    body.replaceChildren(h("p", { class: "pv-loading muted" }, t("pv.loading")));
    void navState();
    if (f.unavailable?.length) {
      dlg!.dataset.kind = "unavailable";
      return message(t("un.noPreview"), false, "warn");
    }
    const done = (...kids: (Node | string)[]) => {
      if (my !== seq) return false;
      body.replaceChildren(...kids);
      dlg!.dataset.state = "ready";
      return true;
    };
    const fail = (e: unknown) => {
      console.warn("ddn: preview", String((e as Error)?.message ?? e));
      done(message(t("pv.fail"), true, "err"));
    };
    /** Blob URL owned by the file on screen (revoked on reset), only while it is still current. */
    const own = (b: Blob) => {
      const u = URL.createObjectURL(b);
      // A late answer (the plain thumbnail arriving after the preview moved on or closed): revoke it at once
      // instead of keeping a URL nobody will release.
      if (my !== seq) queueMicrotask(() => URL.revokeObjectURL(u));
      else urls.push(u);
      return u;
    };
    const tooBig = (limit: number) => size > limit && (done(message(t("pv.tooBig", { size: fmtSize(size), limit: fmtSize(limit) }))), true);

    (async () => {
      switch (kind) {
        case "text":
        case "markdown":
        case "json":
        case "csv":
        case "tsv": {
          if (size === 0) return void done(message(t("pv.empty"), false));
          const n = Math.min(size, TEXT_LIMIT);
          const r = await deps.core.readRange(f.id, 0, n - 1);
          if (my !== seq) return;
          const cut = r.size > n;
          const text = decodeText(r.data, cut);
          const kids: Node[] = [];
          if (cut) kids.push(note(t("pv.truncated", { size: fmtSize(TEXT_LIMIT) })));
          if (kind === "markdown") {
            const art = h("article", { class: "pv-md", "data-ddn": "preview-md" });
            art.append(markdownDom(parseMarkdown(text, { imageLabel: (alt) => t("pv.image", { alt: alt || "-" }) })));
            kids.push(art);
          } else if (kind === "csv" || kind === "tsv") {
            const { rows, more } = parseDelimited(text, kind === "csv" ? "," : "\t", TABLE_ROWS);
            if (cut && !more && rows.length > 1) rows.pop(); // the last row was cut by the read limit
            const [head, ...rest] = rows;
            const width = Math.max(1, ...rows.map((x) => x.length));
            const tr = (cells: string[], tag: "th" | "td") => h("tr", {}, ...Array.from({ length: width }, (_, k) => h(tag, {}, cells[k] ?? "")));
            const table = h("table", { class: "pv-table", "data-ddn": "preview-table" }, h("thead", {}, tr(head ?? [], "th")), h("tbody", {}, ...rest.map((x) => tr(x, "td"))));
            if (more) kids.push(note(t("pv.rows", { n: fmtNum(TABLE_ROWS) })));
            kids.push(h("div", { class: "pv-scroll" }, table));
          } else {
            const pretty = kind === "json" && !cut ? prettyJson(text) : null;
            if (kind === "json" && pretty === null) kids.push(note(t(cut ? "pv.jsonCut" : "pv.jsonBad")));
            const pre = h("pre", { class: "pv-text", "data-ddn": "preview-text" });
            pre.textContent = pretty ?? text;
            kids.push(pre);
          }
          return void done(...kids);
        }
        case "image": {
          if (tooBig(IMAGE_LIMIT)) return;
          const img = h("img", { class: "pv-img", alt: f.name, "data-ddn": "preview-img", decoding: "async" });
          if (deps.features().thumbnails)
            void deps.core
              .thumbnail(f.id)
              .then((b) => {
                // Checked again here: the thumbnail may come after the full image, a next file or the close.
                if (!b || my !== seq || img.dataset.full) return;
                img.src = own(new Blob([b], { type: "image/jpeg" }));
                img.dataset.placeholder = "1";
                body.replaceChildren(img);
              })
              .catch(() => {});
          const b = await deps.core.download(f.id);
          if (my !== seq) return;
          img.dataset.full = "1";
          img.src = own(new Blob([b], { type: mime }));
          try {
            await img.decode();
          } catch {
            if (my === seq) return void done(message(t("pv.fail"), true, "err"));
          }
          delete img.dataset.placeholder;
          return void done(img);
        }
        case "pdf": {
          if (tooBig(PDF_LIMIT)) return;
          if (!pdfInline(navigator as Navigator & { pdfViewerEnabled?: boolean })) return void done(message(t("pv.pdfNo")));
          const b = await deps.core.download(f.id);
          if (my !== seq) return;
          // No sandbox attribute: Chrome refuses PDFs in sandboxed frames (see the top comment).
          const frame = h("iframe", { class: "pv-pdf", title: f.name, "data-ddn": "preview-pdf", referrerpolicy: "no-referrer" });
          frame.src = own(new Blob([b], { type: "application/pdf" }));
          return void done(frame);
        }
        case "audio":
        case "video": {
          const el = document.createElement(kind);
          if (kind === "audio" && !el.canPlayType(mime)) return void done(message(t("pv.media")));
          el.controls = true;
          el.preload = "metadata";
          el.dataset.ddn = `preview-${kind}`;
          el.className = `pv-${kind}`;
          if (el instanceof HTMLVideoElement) el.playsInline = true;
          // Same source as the video player: plain = server stream, other modes = service worker.
          const direct = deps.features().streaming ? await deps.core.streamUrl(f.id).catch(() => null) : null;
          if (my !== seq) return;
          el.src = direct ?? `./ddn/file/${encodeURIComponent(f.id)}?size=${size}`;
          el.dataset.source = direct ? "server" : "sw";
          el.addEventListener("error", () => {
            if (my === seq && media === el) done(message(t("pv.media")));
          });
          media = el;
          return void done(el);
        }
        default:
          return void done(message(t("pv.none")));
      }
    })().catch(fail);
  }

  return { open, close };
}
