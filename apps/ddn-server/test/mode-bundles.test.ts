// Build-time mode (koncept §2, docs/stage3-modes.md §2): every mode's web bundle and server
// bundle contains its own marker and none of the code that belongs to other modes. Greps the
// real build output for markers that live next to that code:
//   ddn-mode-marker:<mode>  the mode file itself (web modes/<mode>.ts, server modes/<mode>.ts)
//   ddn-webhook-vault       the webhook vault + direct posts to webhooks (metadata only)
//   ddn-server-blobs        blobs through the instance / the server sender (e2ee, plain)
//   ddn-plain-op-codec      operations in clear for the server (plain only)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMode } from "../../web-mo/build.js";
import { buildServerMode, serverModeFile } from "../build-server.js";
import { availableModes, type InstanceMode } from "../src/config.js";

const FORBIDDEN: Record<InstanceMode, string[]> = {
  "metadata-only": ["ddn-server-blobs", "ddn-plain-op-codec", "ddn-mode-marker:e2ee", "ddn-mode-marker:plain"],
  e2ee: ["ddn-webhook-vault", "ddn-plain-op-codec", "ddn-mode-marker:metadata-only", "ddn-mode-marker:plain"],
  plain: ["ddn-webhook-vault", "ddn-mode-marker:metadata-only", "ddn-mode-marker:e2ee"],
};
const REQUIRED: Record<InstanceMode, { web: string[]; server: string[] }> = {
  "metadata-only": { web: ["ddn-mode-marker:metadata-only", "ddn-webhook-vault"], server: ["ddn-mode-marker:metadata-only"] },
  e2ee: { web: ["ddn-mode-marker:e2ee", "ddn-server-blobs"], server: ["ddn-mode-marker:e2ee", "ddn-server-blobs"] },
  plain: { web: ["ddn-mode-marker:plain", "ddn-server-blobs", "ddn-plain-op-codec"], server: ["ddn-mode-marker:plain", "ddn-server-blobs", "ddn-plain-op-codec"] },
};

const jsOf = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

describe("mode bundles: no code of the other modes", () => {
  const modes = availableModes();
  it("at least metadata only and e2ee are available", () => {
    expect(modes).toEqual(expect.arrayContaining(["metadata-only", "e2ee"]));
  });
  for (const mode of modes) {
    it(`${mode}: web and server bundles carry their marker and nothing that belongs to another mode`, async () => {
      const web = jsOf(await buildMode(mode));
      await buildServerMode(mode);
      expect(existsSync(serverModeFile(mode))).toBe(true);
      const server = readFileSync(serverModeFile(mode), "utf8");
      for (const m of REQUIRED[mode].web) expect(web.includes(m), `web ${mode} has ${m}`).toBe(true);
      for (const m of REQUIRED[mode].server) expect(server.includes(m), `server ${mode} has ${m}`).toBe(true);
      for (const m of FORBIDDEN[mode]) {
        expect(web.includes(m), `web ${mode} must not contain ${m}`).toBe(false);
        expect(server.includes(m), `server ${mode} must not contain ${m}`).toBe(false);
      }
    }, 120_000);
  }
});
