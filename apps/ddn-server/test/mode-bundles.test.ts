// Build-time mode: every mode's web bundle and server
// bundle contains its own marker and none of the code that belongs to other modes. Greps the
// real build output for markers that live next to that code:
//   ddn-mode-marker:<mode>  the mode file itself (web modes/<mode>.ts, server modes/<mode>.ts)
//   ddn-webhook-vault       the webhook vault + direct posts to webhooks (metadata only)
//   ddn-server-blobs        blobs through the instance / the server sender (e2ee, plain)
//   ddn-plain-op-codec      operations in clear for the server (plain only)
// The server bundle keeps the workspace packages shared by all modes external (one DdnServer per
// process); what a mode pulls from them is visible as its import specifier, so the server checks
// also look for "@ddv4/metadata-client/plain-ops" / "/server-blobs" in the bundle text.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMode } from "../../web-mo/build.js";
import { buildServerMode, serverModeFile } from "../build-server.js";
import { availableModes, type InstanceMode } from "../src/config.js";

const PLAIN_OPS = "@ddv4/metadata-client/plain-ops";
const FORBIDDEN: Record<InstanceMode, string[]> = {
  "metadata-only": ["ddn-server-blobs", "ddn-plain-op-codec", PLAIN_OPS, "ddn-mode-marker:e2ee", "ddn-mode-marker:plain", "/v1/plain/"],
  e2ee: ["ddn-webhook-vault", "ddn-plain-op-codec", PLAIN_OPS, "ddn-mode-marker:metadata-only", "ddn-mode-marker:plain", "/v1/plain/"],
  plain: ["ddn-webhook-vault", "ddn-mode-marker:metadata-only", "ddn-mode-marker:e2ee"],
};
const REQUIRED: Record<InstanceMode, { web: string[]; server: string[] }> = {
  "metadata-only": { web: ["ddn-mode-marker:metadata-only", "ddn-webhook-vault"], server: ["ddn-mode-marker:metadata-only"] },
  e2ee: { web: ["ddn-mode-marker:e2ee", "ddn-server-blobs"], server: ["ddn-mode-marker:e2ee", "ddn-server-blobs"] },
  plain: { web: ["ddn-mode-marker:plain", "ddn-server-blobs", "ddn-plain-op-codec"], server: ["ddn-mode-marker:plain", "ddn-server-blobs", PLAIN_OPS, "/v1/plain/"] },
};

// Every bundle of the web build, the app worker under w/ included.
const jsOf = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((f) => (f.isDirectory() ? [jsOf(join(dir, f.name))] : f.name.endsWith(".js") || f.name.endsWith(".mjs") ? [readFileSync(join(dir, f.name), "utf8")] : []))
    .join("\n");

describe("mode bundles: no code of the other modes", () => {
  const modes = availableModes();
  it("at least metadata only and e2ee are available", () => {
    expect(modes).toEqual(expect.arrayContaining(["metadata-only", "e2ee"]));
  });
  for (const mode of modes) {
    it(`${mode}: web and server bundles carry their marker and nothing that belongs to another mode`, async () => {
      // Own output dirs: running previews serve dist/<mode> of this checkout (never rebuilt under them).
      const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-bundles-"));
      const web = jsOf(await buildMode(mode, out));
      await buildServerMode(mode, out);
      expect(existsSync(serverModeFile(mode, out))).toBe(true);
      const server = readFileSync(serverModeFile(mode, out), "utf8");
      for (const m of REQUIRED[mode].web) expect(web.includes(m), `web ${mode} has ${m}`).toBe(true);
      for (const m of REQUIRED[mode].server) expect(server.includes(m), `server ${mode} has ${m}`).toBe(true);
      for (const m of FORBIDDEN[mode]) {
        expect(web.includes(m), `web ${mode} must not contain ${m}`).toBe(false);
        expect(server.includes(m), `server ${mode} must not contain ${m}`).toBe(false);
      }
    }, 120_000);
  }
});
