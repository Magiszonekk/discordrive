// Runs inside a dedicated Worker in Chromium (bundled by opfs-check.ts).
import { canonicalState, replay, type LogEntry } from "@ddv4/sync-core";
import { openOpfsIndexStore } from "../../src/browser/index.js";

async function sha(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

self.onmessage = async (ev: MessageEvent<{ cmd: string; logs?: LogEntry[][]; wasmUrl: string }>) => {
  try {
    const { cmd, logs, wasmUrl } = ev.data;
    if (cmd === "replay") {
      const hashes: string[] = [];
      let openMs = 0;
      let applyMs = 0;
      for (let i = 0; i < logs!.length; i++) {
        const t0 = performance.now();
        // One database file per account in real use; here one file, wiped before every log.
        const st = await openOpfsIndexStore({ filename: "/case.db", wasmUrl, clearOnInit: true });
        const t1 = performance.now();
        // Batch: one transaction per pulled batch (MetadataClient.pull does the same).
        st.atomically(() => replay(logs![i]!, st));
        const t2 = performance.now();
        openMs += t1 - t0;
        applyMs += t2 - t1;
        hashes.push(await sha(canonicalState(st)));
        st.close();
      }
      postMessage({ ok: true, hashes, openMs: Math.round(openMs), applyMs: Math.round(applyMs) });
    } else if (cmd === "persist-write") {
      const st = await openOpfsIndexStore({ filename: "/persist.db", wasmUrl, clearOnInit: true });
      replay(logs![0]!, st);
      const h = await sha(canonicalState(st));
      st.close();
      postMessage({ ok: true, hash: h });
    } else if (cmd === "persist-read") {
      const st = await openOpfsIndexStore({ filename: "/persist.db", wasmUrl });
      const h = await sha(canonicalState(st));
      const head = st.getMeta().headSeq;
      st.close();
      postMessage({ ok: true, hash: h, head });
    }
  } catch (e) {
    postMessage({ ok: false, error: String((e as Error)?.stack ?? e) });
  }
};
