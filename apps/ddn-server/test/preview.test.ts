// File preview: the pure parts of apps/web-mo/src/preview.ts and
// markdown.ts (type detection, the safe Markdown renderer, CSV/TSV, UTF-8 cut, JSON). The dialog
// itself is driven in headless Chromium by apps/web-mo/check.ts (step "preview").
import { describe, expect, it } from "vitest";
import { MD_ATTRS, MD_TAGS, parseMarkdown, safeHref, type MdNode } from "../../web-mo/src/markdown.js";
import { FolderFiles, decodeText, parseDelimited, pdfInline, prettyJson, previewKind, utf8CutPoint } from "../../web-mo/src/preview.js";

/** Markdown tree as compact HTML-like text (text escaped), for readable assertions. */
function html(nodes: MdNode[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return nodes
    .map((n) => (typeof n === "string" ? esc(n) : `<${n.t}${Object.entries(n.a ?? {}).map(([k, v]) => ` ${k}="${v}"`).join("")}>${html(n.c)}</${n.t}>`))
    .join("");
}
const md = (s: string) => html(parseMarkdown(s));
function walk(nodes: MdNode[], f: (n: Exclude<MdNode, string>) => void) {
  for (const n of nodes) if (typeof n !== "string") (f(n), walk(n.c, f));
}

describe("preview type by extension", () => {
  it.each([
    ["notes.txt", "text", "text/plain"],
    ["README.md", "markdown", "text/markdown"],
    ["data.JSON", "json", "application/json"],
    ["t.csv", "csv", "text/csv"],
    ["t.tsv", "tsv", "text/tab-separated-values"],
    ["app.log", "text", "text/plain"],
    ["ci.yml", "text", "text/plain"],
    ["c.yaml", "text", "text/plain"],
    ["pom.xml", "text", "text/plain"],
    ["a.ini", "text", "text/plain"],
    ["Cargo.toml", "text", "text/plain"],
    ["x.ts", "text", "text/plain"],
    ["x.py", "text", "text/plain"],
    ["main.go", "text", "text/plain"],
    ["lib.rs", "text", "text/plain"],
    ["A.java", "text", "text/plain"],
    ["a.c", "text", "text/plain"],
    ["a.cpp", "text", "text/plain"],
    ["a.h", "text", "text/plain"],
    ["run.sh", "text", "text/plain"],
    ["s.css", "text", "text/plain"],
    // HTML is shown as source text, never rendered.
    ["page.html", "text", "text/plain"],
    ["q.sql", "text", "text/plain"],
    ["Dockerfile", "text", "text/plain"],
    ["photo.JPG", "image", "image/jpeg"],
    ["a.jpeg", "image", "image/jpeg"],
    ["a.png", "image", "image/png"],
    ["a.gif", "image", "image/gif"],
    ["a.webp", "image", "image/webp"],
    ["a.avif", "image", "image/avif"],
    ["a.bmp", "image", "image/bmp"],
    ["logo.svg", "image", "image/svg+xml"],
    ["doc.pdf", "pdf", "application/pdf"],
    ["a.mp3", "audio", "audio/mpeg"],
    ["a.ogg", "audio", "audio/ogg"],
    ["a.oga", "audio", "audio/ogg"],
    ["a.wav", "audio", "audio/wav"],
    ["a.m4a", "audio", "audio/mp4"],
    ["a.aac", "audio", "audio/aac"],
    ["a.flac", "audio", "audio/flac"],
    ["a.opus", "audio", 'audio/ogg; codecs="opus"'],
    ["klip.webm", "video", "video/webm"],
    ["a.mp4", "video", "video/mp4"],
  ])("%s -> %s (%s)", (name, kind, mime) => {
    expect(previewKind(name)).toEqual({ kind, mime });
  });
  it.each(["report.docx", "sheet.xlsx", "a.zip", "IMG_1.HEIC", "noext", "a.exe", "x.toString", "x.constructor", "x.__proto__", "duzy.bin"])("%s -> no preview", (name) => {
    expect(previewKind(name).kind).toBe("none");
    expect(previewKind(name).mime).toBe("application/octet-stream");
  });
});

describe("markdown renderer (no raw HTML)", () => {
  it("headings, paragraphs, emphasis, strong, strike, code", () => {
    expect(md("# Title\n\nSome *em* and **strong** and ***both*** and ~~gone~~ and `a<b>`.")).toBe(
      "<h1>Title</h1><p>Some <em>em</em> and <strong>strong</strong> and <strong><em>both</em></strong> and <del>gone</del> and <code>a&lt;b&gt;</code>.</p>",
    );
    expect(md("Sub\n===\n\nSub2\n---")).toBe("<h1>Sub</h1><h2>Sub2</h2>");
    expect(md("###### six #####")).toBe("<h6>six</h6>");
    expect(md("snake_case_name and _em_")).toBe("<p>snake_case_name and <em>em</em></p>");
    expect(md("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
    expect(md("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>");
  });
  it("lists (nested, ordered with start), quotes, rules, code blocks, tables", () => {
    expect(md("- one\n- two\n  - inner\n- three")).toBe("<ul><li>one</li><li>two<ul><li>inner</li></ul></li><li>three</li></ul>");
    expect(md("3. c\n4. d")).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
    expect(md("> quoted **x**\n> more")).toBe("<blockquote><p>quoted <strong>x</strong>\nmore</p></blockquote>");
    expect(md("---")).toBe("<hr></hr>");
    expect(md("```js\nconst a = '<script>';\n```")).toBe("<pre><code>const a = '&lt;script&gt;';</code></pre>");
    expect(md("    indented <b>\n    code")).toBe("<pre><code>indented &lt;b&gt;\ncode</code></pre>");
    expect(md("| a | b |\n|:--|--:|\n| 1 | **2** |")).toBe('<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="left">1</td><td align="right"><strong>2</strong></td></tr></tbody></table>');
  });
  it("raw HTML stays text: no element other than the whitelist ever appears", () => {
    const src = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<div onclick="x()">hi</div> <iframe src="javascript:alert(3)"></iframe>\n\n<svg onload=alert(4)>';
    const tree = parseMarkdown(src);
    const tags: string[] = [];
    walk(tree, (n) => {
      tags.push(n.t);
      expect(MD_TAGS.has(n.t)).toBe(true);
      for (const k of Object.keys(n.a ?? {})) expect(MD_ATTRS.has(k)).toBe(true);
    });
    expect(tags.every((x) => x === "p")).toBe(true);
    expect(md(src)).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md(src)).toContain('&lt;img src=x onerror="alert(2)"&gt;');
  });
  it("links: only http/https/mailto, rel noopener noreferrer, target _blank; javascript: and friends dropped", () => {
    expect(md("[ok](https://example.com/a?b=1 \"T\")")).toBe('<p><a href="https://example.com/a?b=1" rel="noopener noreferrer" target="_blank" title="T">ok</a></p>');
    expect(md("[m](mailto:a@b.pl)")).toBe('<p><a href="mailto:a@b.pl" rel="noopener noreferrer" target="_blank">m</a></p>');
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "file:///etc/passwd", "/relative", "#frag", "blob:https://x/1"]) {
      const out = md(`[click](${bad})`);
      expect(out, bad).not.toContain("<a");
      expect(out, bad).toContain("click");
    }
    expect(md("<javascript:alert(1)>")).not.toContain("<a");
    expect(md("<https://ok.example>")).toBe('<p><a href="https://ok.example/" rel="noopener noreferrer" target="_blank">https://ok.example</a></p>');
    expect(md("see https://x.example/p.")).toBe('<p>see <a href="https://x.example/p" rel="noopener noreferrer" target="_blank">https://x.example/p</a>.</p>');
    expect(safeHref("https://a.b/")).toBe("https://a.b/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("jav&#x09;ascript:alert(1)")).toBeNull();
  });
  it("images are never loaded: alt text instead", () => {
    const out = md("![a cat](https://evil.example/track.png)");
    expect(out).toBe('<p><span class="md-img">[image: a cat]</span></p>');
    expect(html(parseMarkdown("![x](y)", { imageLabel: (a) => `obraz ${a}` }))).toBe('<p><span class="md-img">obraz x</span></p>');
  });
  it("escapes, hard breaks, large and hostile input stay bounded", () => {
    expect(md("\\*not em\\* and \\<b>")).toBe("<p>*not em* and &lt;b&gt;</p>");
    expect(md("a  \nb")).toBe("<p>a<br></br>b</p>");
    const t0 = Date.now();
    parseMarkdown("*".repeat(50_000) + "_".repeat(50_000) + "[".repeat(20_000) + "`".repeat(20_000));
    parseMarkdown("> ".repeat(5000) + "x\n" + "- ".repeat(5000) + "y");
    parseMarkdown(("word *em* [l](https://a.b) `c`\n").repeat(40_000));
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("CSV / TSV", () => {
  it("quotes, commas, doubled quotes and newlines inside quotes, CRLF", () => {
    const { rows, more } = parseDelimited('name,note\r\n"Kowalski, Jan","said ""hi""\nthen left"\r\nplain,x\r\n', ",", 100);
    expect(rows).toEqual([["name", "note"], ["Kowalski, Jan", 'said "hi"\nthen left'], ["plain", "x"]]);
    expect(more).toBe(false);
  });
  it("empty fields, no trailing newline, TSV, row limit", () => {
    expect(parseDelimited("a,,c\n,b,", ",", 10).rows).toEqual([["a", "", "c"], ["", "b", ""]]);
    expect(parseDelimited("a\tb,c\n1\t2", "\t", 10).rows).toEqual([["a", "b,c"], ["1", "2"]]);
    const big = Array.from({ length: 1000 }, (_, i) => `${i},x`).join("\n");
    const r = parseDelimited(big, ",", 500);
    expect(r.rows.length).toBe(500);
    expect(r.rows[499]).toEqual(["499", "x"]);
    expect(r.more).toBe(true);
    expect(parseDelimited('"unterminated, still one field', ",", 10).rows).toEqual([["unterminated, still one field"]]);
  });
});

describe("UTF-8 cut at a character boundary", () => {
  const enc = new TextEncoder();
  it("drops the bytes of a character split by the read limit", () => {
    const b = enc.encode("aż€😀"); // 1 + 2 + 3 + 4 bytes
    expect(b.length).toBe(10);
    for (let n = 0; n <= 10; n++) {
      const part = b.subarray(0, n);
      const cut = utf8CutPoint(part);
      expect([0, 1, 3, 6, 10]).toContain(cut);
      expect(cut).toBeLessThanOrEqual(n);
      expect(decodeText(part, true)).not.toContain("\uFFFD");
      expect("aż€😀".startsWith(decodeText(part, true))).toBe(true);
    }
    expect(decodeText(b.subarray(0, 9), true)).toBe("aż€");
    expect(decodeText(b.subarray(0, 2), true)).toBe("a");
  });
  it("whole files decode as they are (invalid bytes -> U+FFFD, BOM dropped)", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), false)).toBe("a");
    expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]), false)).toBe("a\uFFFDb");
    expect(utf8CutPoint(new Uint8Array([0x61, 0xff]))).toBe(2);
  });
});

describe("JSON pretty print", () => {
  it("indents valid JSON, keeps strings and big numbers exactly", () => {
    expect(prettyJson('{"a":[1,2,{"b":"x, y: {z}"}],"e":{},"f":[],"n":12345678901234567890,"s":"q\\"\\\\"}')).toBe(
      '{\n  "a": [\n    1,\n    2,\n    {\n      "b": "x, y: {z}"\n    }\n  ],\n  "e": {},\n  "f": [],\n  "n": 12345678901234567890,\n  "s": "q\\"\\\\"\n}',
    );
    expect(JSON.parse(prettyJson(' [ true , null , "ż" ] ')!)).toEqual([true, null, "ż"]);
  });
  it("invalid or cut JSON -> null (shown as raw text)", () => {
    expect(prettyJson('{"a": 1')).toBeNull();
    expect(prettyJson("not json")).toBeNull();
  });
});

describe("PDF inline", () => {
  it("off where the browser has no viewer or on phones", () => {
    expect(pdfInline({ pdfViewerEnabled: true, userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/126" })).toBe(true);
    expect(pdfInline({ pdfViewerEnabled: false, userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe(false);
    expect(pdfInline({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36" })).toBe(false);
    expect(pdfInline({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe(false);
  });
});

describe("←/→ walk the folder's files across list pages", () => {
  // 23 children in name order, every third one a folder; pages of 5 like core.list (keyset cursor).
  const rows = Array.from({ length: 23 }, (_, i) => ({ id: `n${i}`, name: `item-${String(i).padStart(2, "0")}`, kind: (i % 3 === 1 ? "folder" : "file") as "file" | "folder", size: 1, cursor: String(i) }));
  const calls: (string | undefined)[] = [];
  const core = {
    async list(_f: string, after?: string, limit = 200) {
      calls.push(after);
      const from = after === undefined ? 0 : Number(after) + 1;
      return { rows: rows.slice(from, from + limit), total: rows.length };
    },
    readRange: async () => ({ data: new Uint8Array(), size: 0 }),
    download: async () => new Blob(),
    thumbnail: async () => null,
    streamUrl: async () => null,
  };
  it("finds a file on a later page, skips folders, stops at the end", async () => {
    const files = rows.filter((r) => r.kind === "file");
    const ff = new FolderFiles(core, "f", undefined, 5);
    const i = await ff.indexOf("n20");
    expect(i).toBe(files.findIndex((r) => r.id === "n20"));
    expect(calls.length).toBe(5); // pages 0-4, 5-9, 10-14, 15-19, 20-24
    expect((await ff.at(i - 1))!.id).toBe("n18");
    expect((await ff.at(i + 1))!.id).toBe("n21");
    expect(await ff.at(i + 2)).toBeNull(); // n22 is a folder, nothing after it
    expect(await ff.at(-1)).toBeNull();
    expect((await Promise.all(files.map((_, k) => ff.at(k)))).map((r) => r!.id)).toEqual(files.map((r) => r.id));
    expect(await new FolderFiles(core, "f", undefined, 5).indexOf("gone")).toBe(-1);
  });
  it("concurrent lookups (position + next button) load each page once", async () => {
    calls.length = 0;
    const ff = new FolderFiles(core, "f", undefined, 50);
    const [next, i] = await Promise.all([ff.at(0), ff.indexOf("n0")]);
    expect(next!.id).toBe("n0");
    expect(i).toBe(0);
    expect(calls).toEqual([undefined]);
    expect(ff.files.length).toBe(rows.filter((r) => r.kind === "file").length);
  });
  it("search hits: a fixed list without paging", async () => {
    const ff = new FolderFiles(core, null, rows.slice(0, 4));
    expect(await ff.indexOf("n3")).toBe(2);
    expect(await ff.at(3)).toBeNull();
  });
});
