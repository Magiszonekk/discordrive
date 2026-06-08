import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: [
      "src/__tests__/smoke/**/*.test.ts",
      "src/__tests__/unit/**/*.test.ts",
      "src/__tests__/integration/**/*.test.ts",
    ],
    sequence: {
      concurrent: false,
    },
  },
});
