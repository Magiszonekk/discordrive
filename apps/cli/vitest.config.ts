import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The core's `ddn:mode` is the command line's switch: one process talks to instances of every mode.
  resolve: { alias: { "ddn:mode": fileURLToPath(new URL("./src/mode-switch.ts", import.meta.url)) } },
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 180_000 },
});
