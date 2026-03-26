// @ddv4/sw-client — Low-level Service Worker registration + messaging

/**
 * Ensures the Service Worker at swPath is registered and controlling this page.
 * Always calls register() — browser compares bytes and no-ops if unchanged.
 * Waits for navigator.serviceWorker.controller to be set (clients.claim() complete)
 * so that fetch requests are guaranteed to be intercepted before we return.
 */
export async function ensureSW(
  swPath: string,
  scope: string,
): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers are not supported in this browser");
  }

  // Always register — handles the case where an old SW (e.g. stream-sw.js) is
  // still registered at this scope. The browser installs the new script and
  // skipWaiting() + clients.claim() in the SW take over immediately.
  await navigator.serviceWorker.register(swPath, { scope });
  const reg = await navigator.serviceWorker.ready;

  // Wait until the SW is actually controlling this page (clients.claim() done).
  // Without this, a triggerDownload() call immediately after would bypass the SW
  // entirely — Vite dev server serves index.html instead of the decrypted file.
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => resolve(),
        { once: true },
      );
    });
  }

  return reg;
}

/**
 * Posts a message to the active Service Worker.
 * Throws if the SW is not yet active.
 */
export function postToSW(
  reg: ServiceWorkerRegistration,
  message: unknown,
  transfer?: Transferable[],
): void {
  const sw = reg.active;
  if (!sw) throw new Error("Service Worker is not active");
  sw.postMessage(message, transfer ?? []);
}
