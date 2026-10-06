import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { MemoryTransport, sha256Hex } from "../src/index.js";

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

describe("ddn CLI (single device, state persisted between runs)", () => {
  it("put in one process, ls/get in the next, file permissions 0600/0700", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-cli-"));
    const hookFile = join(dir, "hook.url");
    // Fake but well-formed URL; MemoryTransport never dials it.
    writeFileSync(hookFile, `https://discord.com/api/webhooks/123456789012345678/${"x".repeat(68)}\n`, { mode: 0o600 });
    const transport = new MemoryTransport();
    const lines: string[] = [];
    const env = { stateDir: join(dir, "state"), webhookFiles: [hookFile], transport, out: (l: string) => lines.push(l) };

    const src = join(dir, "in.bin");
    const data = rand(65_000);
    writeFileSync(src, data);
    expect(await runCli(["put", src, "dane.bin"], env)).toBe(0);
    expect(lines.at(-1)).toMatch(/^put \S+ 65000 B in 1 fragment/);

    // "new process": everything rebuilt from the state dir
    expect(await runCli(["ls"], env)).toBe(0);
    expect(lines.at(-1)).toMatch(/dane\.bin$/);
    const dst = join(dir, "out.bin");
    expect(await runCli(["get", "dane.bin", dst], env)).toBe(0);
    expect(await sha256Hex(readFileSync(dst))).toBe(await sha256Hex(data));

    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "state", "log.jsonl")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "state", "log.jsonl"), "utf8")).not.toContain("x".repeat(68));
  });
});
