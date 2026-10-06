// Minimal functional UI (no styling: the look comes from the frontend profile).
// Every element has a stable data-ddn attribute for tests and for the designer.
import { connect } from "./rpc.js";

const cfg = (window as unknown as { DDN_CONFIG?: { discordApiOrigin?: string; serverUrl?: string } }).DDN_CONFIG ?? {};
const worker = new Worker("./worker.js", { type: "module" });
export const core = connect(worker);
(window as unknown as { ddnCore: typeof core }).ddnCore = core;

// Stream requests from the service worker -> app worker.
navigator.serviceWorker?.addEventListener("message", async (e) => {
  const m = e.data as { ddn?: string; nodeId: string; start: number; end: number };
  if (m?.ddn !== "range") return;
  try {
    e.ports[0]!.postMessage({ ok: true, result: await core.readRange(m.nodeId, m.start, m.end) });
  } catch (err) {
    e.ports[0]!.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
});

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`[data-ddn="${sel}"]`)!;
const fmt = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1 << 20)).toFixed(1)} MiB`);

let cursorStack: (string | undefined)[] = [undefined];
let currentFolder = "root";

async function render() {
  const st = await core.status();
  $("status").textContent = `${st.signedIn ? "zalogowano" : "niezalogowano"} | urządzenie ${st.deviceId ?? "-"} | ${st.leader ? "karta główna" : "karta pomocnicza"} | log ${st.headSeq}`;
  $("signed-out").hidden = st.signedIn;
  $("signed-in").hidden = !st.signedIn;
  if (!st.signedIn) return;
  const page = await core.list(currentFolder, cursorStack.at(-1), 50);
  const list = $("list");
  list.replaceChildren(
    ...page.rows.map((r) => {
      const li = document.createElement("li");
      li.dataset.ddn = "row";
      li.dataset.id = r.id;
      li.textContent = `${r.kind === "folder" ? "[folder] " : ""}${r.name} ${fmt(r.size)}`;
      if (r.kind === "file") {
        const dl = document.createElement("button");
        dl.textContent = "pobierz";
        dl.dataset.ddn = "download";
        dl.onclick = async () => {
          const b = await core.download(r.id);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(b);
          a.download = r.name;
          a.click();
        };
        const play = document.createElement("button");
        play.textContent = "odtwórz";
        play.dataset.ddn = "play";
        play.onclick = () => {
          const v = $<HTMLVideoElement>("player");
          v.src = `./ddn/file/${encodeURIComponent(r.id)}?size=${r.size}`;
          void v.play();
        };
        li.append(" ", dl, " ", play);
      }
      return li;
    }),
  );
  $("count").textContent = `${page.total} pozycji`;
  $("next").onclick = () => {
    if (page.rows.length) cursorStack.push(page.rows.at(-1)!.cursor);
    void render();
  };
  $("prev").onclick = () => {
    if (cursorStack.length > 1) cursorStack.pop();
    void render();
  };
  const wh = await core.webhooks();
  $("advice").textContent = wh.advice.message;
}

async function main() {
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("./sw.js").catch(() => {});
  await core.init({ discordApiOrigin: cfg.discordApiOrigin, wasmUrl: new URL("./sqlite3.wasm", location.href).href });
  $<HTMLInputElement>("server").value = cfg.serverUrl ?? "http://127.0.0.1:8787";
  $("create").onclick = async () => {
    await core.createAccount($<HTMLInputElement>("server").value, $<HTMLInputElement>("device-name").value || "przeglądarka");
    await core.open();
    await render();
  };
  $("add-webhook").onclick = async () => {
    const i = $<HTMLInputElement>("webhook-url");
    await core.addWebhook(i.value);
    i.value = "";
    await render();
  };
  $("mkdir").onclick = async () => {
    await core.mkdir($<HTMLInputElement>("folder-name").value || "Nowy folder", currentFolder);
    await render();
  };
  $<HTMLInputElement>("file").onchange = async (e) => {
    for (const f of (e.target as HTMLInputElement).files ?? []) await core.upload(f, f.name, currentFolder);
    await render();
  };
  $("pair").onclick = async () => {
    const r = await core.pairAccept($<HTMLInputElement>("pair-code").value);
    $("pair-sas").textContent = `Kod do porównania: ${r.sas}`;
  };
  if ((await core.status()).hasAccount) await core.open();
  await render();
  let seen = -1;
  setInterval(async () => {
    const v = (await core.status()).version;
    if (v !== seen) ((seen = v), void render());
  }, 1000);
  document.body.dataset.ready = "1";
}

void main();
