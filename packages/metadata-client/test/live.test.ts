// Live slice on the TEST server a test Discord server only (koncept §7 environment).
// Runs only with DDN_LIVE=1 and DDN_LIVE_WEBHOOK_FILE pointing at a webhook URL
// file created by tools/testbot.py. Never prints the URL.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWebhooks, openClient, runCli } from "../src/cli.js";
import { DiscordWebhookTransport, decodeManifestRef, sha256Hex } from "../src/index.js";

const live = process.env.DDN_LIVE === "1" && !!process.env.DDN_LIVE_WEBHOOK_FILE;

describe.skipIf(!live)("live: CLI put/get through a real test webhook", () => {
  it("uploads a multi-fragment file and downloads it with matching SHA-256", async () => {
    const hookFile = process.env.DDN_LIVE_WEBHOOK_FILE!;
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-live-"));
    const size = Number(process.env.DDN_LIVE_BYTES ?? 25 * 1024 * 1024);
    const data = crypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(size);
    for (let o = 0; o < size; o += data.byteLength) big.set(data.subarray(0, Math.min(data.byteLength, size - o)), o);
    big[0] = 1; big[size - 1] = 2;
    const src = join(dir, "in.bin");
    writeFileSync(src, big);
    const lines: string[] = [];
    const env = { stateDir: join(dir, "state"), webhookFiles: [hookFile], out: (l: string) => (lines.push(l), console.log(l)) };
    expect(await runCli(["put", src, "live.bin"], env)).toBe(0);
    const dst = join(dir, "out.bin");
    expect(await runCli(["get", "live.bin", dst], env)).toBe(0);
    expect(await sha256Hex(readFileSync(dst))).toBe(await sha256Hex(big));

    // Clean up: delete every message this upload made (fragments + manifest).
    const c = await openClient(env);
    const node = c.list().find((x) => x.name === "live.bin")!;
    const ref = c.store.getNode(node.id)!.content!.manifestRef;
    const { manifest } = await c.loadManifest(ref);
    const t = new DiscordWebhookTransport();
    const [hook] = loadWebhooks([hookFile]);
    for (const id of [...manifest.chunks.map((ch) => ch.placements![0]!.messageId!), decodeManifestRef(ref).at.messageId]) {
      await t.deleteMessage(hook!, id);
      await new Promise((r) => setTimeout(r, 400));
    }
  });
});
