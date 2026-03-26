import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "esbuild";

const apiPort = process.env.API_PORT ?? "3000";
const frontendPort = parseInt(process.env.FRONTEND_PORT ?? "5173", 10);

const swEntry = resolve(__dirname, "src/sw/stream-sw.ts");
const swOutDir = resolve(__dirname, "public");

/**
 * Vite plugin that bundles the Service Worker from TypeScript source.
 * In dev mode: builds on startup and watches for changes.
 * In build mode: builds once before Vite's own build.
 */
function serviceWorkerPlugin(): Plugin {
  async function buildSW() {
    await build({
      entryPoints: [swEntry],
      bundle: true,
      format: "iife",
      outfile: resolve(swOutDir, "stream-sw.js"),
      platform: "browser",
      target: "es2022",
      minify: false,
      sourcemap: false,
    });
  }

  return {
    name: "service-worker-build",

    // Build mode: compile SW before Vite build
    async buildStart() {
      await buildSW();
    },

    // Dev mode: watch SW source and rebuild on change
    configureServer(server) {
      buildSW().catch(console.error);

      server.watcher.add(swEntry);
      server.watcher.on("change", (path) => {
        if (path.includes("stream-sw") || path.includes("sw/")) {
          buildSW()
            .then(() => console.log("[sw] Service Worker rebuilt"))
            .catch(console.error);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
  server: {
    port: frontendPort,
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      "/graphql": `http://localhost:${apiPort}`,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
});
