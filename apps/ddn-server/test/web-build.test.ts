// `discordrive start` rebuilds apps/web-mo/dist when the sources changed since
// the last build (git pull), using the hash that build.ts stores in dist.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildId, builtHash, builtId, sourceHash, STAMP_FILE } from "../../web-mo/source-hash.js";

function fakeRepo() {
  const r = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-hash-"));
  mkdirSync(join(r, "apps/web-mo/src"), { recursive: true });
  mkdirSync(join(r, "packages/sync-core/src"), { recursive: true });
  writeFileSync(join(r, "apps/web-mo/index.html"), "<p>a</p>");
  writeFileSync(join(r, "apps/web-mo/src/ui.ts"), "export {}");
  writeFileSync(join(r, "packages/sync-core/src/x.ts"), "export const x = 1");
  writeFileSync(join(r, "package-lock.json"), "{}");
  return r;
}

describe("web build stamp", () => {
  it("hash changes with any input file and ignores unrelated files", () => {
    const r = fakeRepo();
    const h0 = sourceHash(r);
    expect(sourceHash(r)).toBe(h0);
    writeFileSync(join(r, "README.md"), "unrelated");
    mkdirSync(join(r, "apps/web-mo/dist"));
    writeFileSync(join(r, "apps/web-mo/dist/ui.js"), "built output");
    expect(sourceHash(r)).toBe(h0);
    writeFileSync(join(r, "packages/sync-core/src/x.ts"), "export const x = 2");
    const h1 = sourceHash(r);
    expect(h1).not.toBe(h0);
    writeFileSync(join(r, "apps/web-mo/src/new.ts"), "export {}");
    expect(sourceHash(r)).not.toBe(h1);
  });
  it("reads the stamp written by the build; none = stale", () => {
    const r = fakeRepo();
    const dist = join(r, "apps/web-mo/dist");
    mkdirSync(dist);
    expect(builtHash(dist)).toBeNull();
    writeFileSync(join(dist, STAMP_FILE), JSON.stringify({ hash: sourceHash(r) }));
    expect(builtHash(dist)).toBe(sourceHash(r));
  });
  it("build ID: version + 8 chars of the source hash + the git commit when known; no paths", () => {
    expect(buildId("a76246c6eb4d60ca7acde6a86fb1a2c6", "b045e69", "0.2.0")).toBe("0.2.0+a76246c6.gb045e69");
    expect(buildId("a76246c6eb4d60ca7acde6a86fb1a2c6", null, "0.2.0")).toBe("0.2.0+a76246c6");
    const real = buildId(sourceHash());
    expect(real).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{8}(\.g[0-9a-f]{7,12})?$/);
    const r = fakeRepo();
    const dist = join(r, "apps/web-mo/dist");
    mkdirSync(dist);
    expect(builtId(dist)).toBeNull();
    writeFileSync(join(dist, STAMP_FILE), JSON.stringify({ hash: "x", build: real }));
    expect(builtId(dist)).toBe(real);
  });
});
