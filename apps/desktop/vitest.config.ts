import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The core imports its mode as the virtual module `ddn:mode` (web-mo build.ts). The desktop app's
  // first mode is metadata only.
  resolve: { alias: { "ddn:mode": fileURLToPath(new URL("../web-mo/src/modes/metadata-only.ts", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
