/// <reference lib="webworker" />
// Service worker for /w/ only (the app worker's directory). It has no fetch handler on purpose: the app
// worker (w/worker.js) becomes ITS client instead of /sw.js's, so the worker's requests (webhook posts,
// CDN reads, the API) go straight to the network. Measured 2026-10-14 (scripts/sw-body-memory.mts,
// Chromium 151): 3 GB of 10 MiB POSTs from a worker controlled by a service worker with a fetch handler
// grew the browser process to 2.27 GB and a third of the posts failed ("Failed to fetch"); under this
// worker the same run stays at ~310 MB with no failures. A Static Routing rule (source: network) on
// /sw.js did not help.
declare const self: ServiceWorkerGlobalScope;
export {};
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
