import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from project root (vite.config.ts runs before Vite's own .env loading)
const __viteDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__viteDir, "../../.env") });

const apiPort = process.env.API_PORT ?? "3000";
const frontendPort = parseInt(process.env.FRONTEND_PORT ?? "5173", 10);
const tlsKey = process.env.TLS_KEY_PATH ?? "";
const tlsCert = process.env.TLS_CERT_PATH ?? "";
// Resolve relative paths from project root
const resolvedKey = tlsKey && !tlsKey.startsWith("/") && !/^[a-zA-Z]:/.test(tlsKey)
  ? resolve(__viteDir, "../..", tlsKey) : tlsKey;
const resolvedCert = tlsCert && !tlsCert.startsWith("/") && !/^[a-zA-Z]:/.test(tlsCert)
  ? resolve(__viteDir, "../..", tlsCert) : tlsCert;
const hasTls = resolvedKey && resolvedCert && existsSync(resolvedKey) && existsSync(resolvedCert);
const apiTarget = hasTls
  ? `https://localhost:${apiPort}`
  : `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: frontendPort,
    proxy: {
      "/api": {
        target: apiTarget,
        secure: false, // accept self-signed certs
      },
      "/graphql": {
        target: apiTarget,
        secure: false,
      },
    },
  },
});
