// Small, safe Markdown renderer for the file preview.
//
// It never parses HTML: the output is a tree of a few whitelisted element names with text leaves
// (MdNode), which preview.ts turns into DOM nodes with createElement / createTextNode. Raw HTML in
// the .md file therefore stays visible text (`<script>` is shown, not run); links keep only
// http/https/mailto targets (anything else, javascript: included, becomes plain text); images are
// never loaded (the CSP would block remote ones anyway), their alt text is shown instead.
//
// Supported: ATX + setext headings, paragraphs, hard breaks, emphasis / strong / ~~strike~~,
// `code`, fenced and indented code blocks, block quotes, nested bullet / ordered lists, horizontal
// rules, GFM tables, [links](url "title"), <autolinks>, bare https:// links, backslash escapes.
// Pathological input is bounded: delimiter searches look ahead at most WINDOW characters and the
// nesting depth is capped, so a 2 MB file cannot make the parser quadratic or blow the stack.

export type MdTag =
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "br" | "hr" | "em" | "strong" | "del" | "code" | "pre"
  | "blockquote" | "ul" | "ol" | "li" | "a" | "span" | "table" | "thead" | "tbody" | "tr" | "th" | "td";
export type MdElement = { t: MdTag; a?: Record<string, string>; c: MdNode[] };
export type MdNode = string | MdElement;

/** Every tag the renderer may produce (preview.ts re-checks it when building the DOM). */
export const MD_TAGS: ReadonlySet<string> = new Set<MdTag>([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "em", "strong", "del", "code", "pre",
  "blockquote", "ul", "ol", "li", "a", "span", "table", "thead", "tbody", "tr", "th", "td",
]);
/** Every attribute the renderer may produce. */
export const MD_ATTRS: ReadonlySet<string> = new Set(["href", "rel", "target", "title", "start", "class", "align"]);

export interface MdOptions {
  /** Text shown instead of an image (default: "[image: alt]"). */
  imageLabel?: (alt: string) => string;
}

const WINDOW = 4000;
const MAX_DEPTH = 24;
const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/**
 * The only link targets kept: absolute http(s) and mailto. The URL parser normalises the scheme
 * (case, tabs and newlines inside it), so "JaVa\tScript:" is recognised as javascript: and dropped.
 */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s.replace(/[\t\n\r]/g, ""))) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null; // relative links would point into this app
  }
  return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
}

const el = (t: MdTag, c: MdNode[] = [], a?: Record<string, string>): MdElement => (a ? { t, a, c } : { t, c });

// ── blocks ──────────────────────────────────────────────────────────

const RE = {
  blank: /^[ \t]*$/,
  fence: /^ {0,3}(`{3,}|~{3,})(.*)$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  list: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+(.*))?$/,
  setext1: /^ {0,3}=+[ \t]*$/,
  setext2: /^ {0,3}-+[ \t]*$/,
  tableSep: /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/,
  indented: /^( {4}|\t)/,
};

function startsBlock(line: string): boolean {
  return RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line) || (RE.list.test(line) && !RE.blank.test(RE.list.exec(line)![4] ?? ""));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function parseBlocks(lines: string[], o: Required<MdOptions>, depth: number): MdNode[] {
  const out: MdNode[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    // Fenced code: everything up to the closing fence (or the end) is text.
    const f = RE.fence.exec(line);
    if (f) {
      const mark = f[1]!;
      const body: string[] = [];
      i++;
      while (i < n && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(el("pre", [el("code", [body.join("\n")])]));
      continue;
    }
    const h = RE.atx.exec(line);
    if (h) {
      out.push(el(`h${h[1]!.length}` as MdTag, parseInline(h[2] ?? "", o, depth + 1)));
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      out.push(el("hr"));
      i++;
      continue;
    }
    if (RE.quote.test(line) && depth < MAX_DEPTH) {
      const body: string[] = [];
      while (i < n && RE.quote.test(lines[i]!)) body.push(lines[i++]!.replace(RE.quote, ""));
      out.push(el("blockquote", parseBlocks(body, o, depth + 1)));
      continue;
    }
    const lm = RE.list.exec(line);
    if (lm && depth < MAX_DEPTH) {
      const ordered = /\d/.test(lm[2]!);
      const items: MdNode[] = [];
      const start = ordered ? parseInt(lm[2]!, 10) : 1;
      while (i < n) {
        const m = RE.list.exec(lines[i]!);
        if (!m || /\d/.test(m[2]!) !== ordered) break;
        const offset = m[1]!.length + m[2]!.length + Math.min(Math.max((m[3] ?? " ").length - (m[4] ?? "").length, 1), 4);
        const body: string[] = [m[4] ?? ""];
        let tight = true;
        i++;
        while (i < n) {
          const l = lines[i]!;
          if (RE.blank.test(l)) {
            let j = i + 1;
            while (j < n && RE.blank.test(lines[j]!)) j++;
            if (j < n && lines[j]!.length - lines[j]!.trimStart().length >= offset) {
              for (; i < j; i++) body.push("");
              tight = false;
              continue;
            }
            break;
          }
          const ind = l.length - l.trimStart().length;
          if (ind >= offset) body.push(l.slice(offset));
          else if (RE.list.test(l) || startsBlock(l)) break;
          else body.push(l.trim()); // lazy continuation of the item's paragraph
          i++;
        }
        const blocks = parseBlocks(body, o, depth + 1);
        items.push(el("li", tight ? blocks.flatMap((b) => (typeof b !== "string" && b.t === "p" ? b.c : [b])) : blocks));
      }
      out.push(el(ordered ? "ol" : "ul", items, ordered && start !== 1 ? { start: String(start) } : undefined));
      continue;
    }
    // GFM table: a header row with pipes followed by a separator row.
    if (line.includes("|") && i + 1 < n && RE.tableSep.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      const cell = (tag: "th" | "td", text: string, k: number) => el(tag, parseInline(text, o, depth + 1), align[k] ? { align: align[k]! } : undefined);
      i += 2;
      const rows: MdNode[] = [];
      while (i < n && !RE.blank.test(lines[i]!) && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i++]!);
        rows.push(el("tr", head.map((_, k) => cell("td", cells[k] ?? "", k))));
      }
      out.push(el("table", [el("thead", [el("tr", head.map((c, k) => cell("th", c, k)))]), el("tbody", rows)]));
      continue;
    }
    if (RE.indented.test(line)) {
      const body: string[] = [];
      while (i < n && (RE.indented.test(lines[i]!) || RE.blank.test(lines[i]!))) body.push(lines[i++]!.replace(RE.indented, ""));
      while (body.length && RE.blank.test(body.at(-1)!)) body.pop();
      out.push(el("pre", [el("code", [body.join("\n")])]));
      continue;
    }
    // Paragraph (setext heading when underlined with === / ---).
    const para: string[] = [line];
    i++;
    let heading: MdTag | null = null;
    while (i < n && !RE.blank.test(lines[i]!)) {
      if (RE.setext1.test(lines[i]!)) {
        heading = "h1";
        i++;
        break;
      }
      if (RE.setext2.test(lines[i]!)) {
        heading = "h2";
        i++;
        break;
      }
      if (startsBlock(lines[i]!)) break;
      para.push(lines[i++]!);
    }
    out.push(el(heading ?? "p", parseInline(para.map((l) => l.replace(/^[ \t]+/, "")).join("\n"), o, depth + 1)));
  }
  return out;
}

// ── inline ──────────────────────────────────────────────────────────

const isWs = (c: string | undefined) => c === undefined || /\s/.test(c);
const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** End of the [label] starting at s[i] === "[" (index of "]"), or -1. */
function closeBracket(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length && j - i < WINDOW; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[") d++;
    else if (c === "]" && --d === 0) return j;
  }
  return -1;
}

/** `(dest "title")` starting at s[i] === "(": [dest, title, index after ")"] or null. */
function linkTail(s: string, i: number): [string, string | null, number] | null {
  let j = i + 1;
  while (s[j] === " " || s[j] === "\n") j++;
  let dest = "";
  if (s[j] === "<") {
    const e = s.indexOf(">", j);
    if (e < 0 || e - j > WINDOW || s.slice(j + 1, e).includes("\n")) return null;
    dest = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let d = 0;
    const from = j;
    for (; j < s.length && j - from < WINDOW; j++) {
      const c = s[j]!;
      if (c === "\\" && j + 1 < s.length) {
        j++;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === "(") d++;
      else if (c === ")") {
        if (d === 0) break;
        d--;
      }
    }
    dest = s.slice(from, j).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (s[j] === " " || s[j] === "\n") j++;
  let title: string | null = null;
  const q = s[j];
  if (q === '"' || q === "'" || q === "(") {
    const close = q === "(" ? ")" : q;
    const e = s.indexOf(close, j + 1);
    if (e < 0 || e - j > WINDOW) return null;
    title = s.slice(j + 1, e);
    j = e + 1;
    while (s[j] === " " || s[j] === "\n") j++;
  }
  return s[j] === ")" ? [dest, title, j + 1] : null;
}

/** Closing delimiter `delim` for an opener ending at `from` (emphasis rules, bounded look-ahead). */
function findCloser(s: string, from: number, delim: string): number {
  const ch = delim[0]!;
  for (let j = from; j < s.length && j - from < WINDOW; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      // Skip code spans: emphasis does not close inside them.
      let k = j;
      while (s[k] === "`") k++;
      const run = s.slice(j, k);
      const e = s.indexOf(run, k);
      if (e > 0 && e - k < WINDOW) j = e + run.length - 1;
      else j = k - 1;
      continue;
    }
    if (c !== ch) continue;
    let k = j;
    while (s[k] === ch) k++;
    const len = k - j;
    // A longer closing run (***) closes with its last characters, so ***x*** nests strong(em(x)).
    // A run of exactly the other length pairs with its own kind (*a **b** c*): skip it.
    const otherKind = (delim.length === 1 && len === 2) || (delim.length === 2 && len === 1);
    if (!otherKind && len >= delim.length && j > from && !isWs(s[j - 1]) && (ch !== "_" || !isAlnum(s[k]))) return k - delim.length;
    j = k - 1;
  }
  return -1;
}

function parseInline(s: string, o: Required<MdOptions>, depth: number): MdNode[] {
  const out: MdNode[] = [];
  if (depth > MAX_DEPTH) return s ? [s] : [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      const nx = s[i + 1]!;
      if (nx === "\n") {
        flush();
        out.push(el("br"));
        i += 2;
        continue;
      }
      if (PUNCT.includes(nx)) {
        buf += nx;
        i += 2;
        continue;
      }
    }
    if (c === "\n") {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push(el("br"));
      } else buf += "\n";
      i++;
      continue;
    }
    if (c === "`") {
      let k = i;
      while (s[k] === "`") k++;
      const run = s.slice(i, k);
      let e = s.indexOf(run, k);
      // The closing run must have exactly the same length.
      while (e >= 0 && e - k < WINDOW && s[e + run.length] === "`") {
        let z = e;
        while (s[z] === "`") z++;
        e = s.indexOf(run, z);
      }
      if (e >= 0 && e - k < WINDOW) {
        flush();
        let code = s.slice(k, e).replace(/\n/g, " ");
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push(el("code", [code]));
        i = e + run.length;
      } else {
        buf += run;
        i = k;
      }
      continue;
    }
    if ((c === "[" || (c === "!" && s[i + 1] === "[")) && depth < MAX_DEPTH) {
      const open = c === "!" ? i + 1 : i;
      const close = closeBracket(s, open);
      const tail = close > 0 && s[close + 1] === "(" ? linkTail(s, close + 1) : null;
      if (tail) {
        flush();
        const label = s.slice(open + 1, close);
        if (c === "!") out.push(el("span", [o.imageLabel(label.replace(/[\\*_`[\]]/g, "").trim())], { class: "md-img" }));
        else {
          const href = safeHref(tail[0]);
          const kids = parseInline(label, o, depth + 1);
          if (href) out.push(el("a", kids, { href, rel: "noopener noreferrer", target: "_blank", ...(tail[1] ? { title: tail[1] } : {}) }));
          else out.push(...kids);
        }
        i = tail[2];
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === "<") {
      const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(s.slice(i, i + 2048)) ?? /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(s.slice(i, i + 512));
      if (m) {
        const target = m[1]!.includes(":") ? m[1]! : `mailto:${m[1]}`;
        const href = safeHref(target);
        flush();
        out.push(href ? el("a", [m[1]!], { href, rel: "noopener noreferrer", target: "_blank" }) : m[0]);
        i += m[0].length;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if ((c === "h" || c === "H") && !isAlnum(s[i - 1])) {
      const m = /^https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~]/i.exec(s.slice(i, i + 2048));
      const href = m ? safeHref(m[0]) : null;
      if (m && href) {
        flush();
        out.push(el("a", [m[0]], { href, rel: "noopener noreferrer", target: "_blank" }));
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let k = i;
      while (s[k] === c) k++;
      const n = k - i;
      const leftOk = !isWs(s[k]) && (c !== "_" || !isAlnum(s[i - 1]));
      let done = false;
      if (leftOk && depth < MAX_DEPTH) {
        if (c === "~") {
          if (n === 2) {
            const e = findCloser(s, k, "~~");
            if (e > k) {
              flush();
              out.push(el("del", parseInline(s.slice(k, e), o, depth + 1)));
              i = e + 2;
              done = true;
            }
          }
        } else {
          for (const len of n >= 2 ? [2, 1] : [1]) {
            const d = c.repeat(len);
            const from = i + len;
            const e = findCloser(s, from, d);
            if (e > from) {
              flush();
              out.push(el(len === 2 ? "strong" : "em", parseInline(s.slice(from, e), o, depth + 1)));
              i = e + len;
              done = true;
              break;
            }
          }
        }
      }
      if (!done) {
        buf += s.slice(i, k);
        i = k;
      }
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Markdown source -> tree of whitelisted elements and text (see the file comment). */
export function parseMarkdown(src: string, opts: MdOptions = {}): MdNode[] {
  const o: Required<MdOptions> = { imageLabel: opts.imageLabel ?? ((alt) => `[image: ${alt}]`) };
  const lines = src.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD").split("\n");
  return parseBlocks(lines, o, 0);
}
