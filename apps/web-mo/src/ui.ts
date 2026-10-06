// UI layer of the metadata-only browser client (look: house-v1, frontend profile).
// Every element the tests drive keeps its stable data-ddn attribute; purely
// visual hooks use data-ddn-ui. All logic lives in app-core (worker) behind `core`.
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
const ui = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`[data-ddn-ui="${sel}"]`)!;

const nf1 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("pl-PL");
const fmt = (n: number | null) =>
  n === null ? "" : n < 1024 ? `${n} B` : n < 1 << 20 ? `${nf1.format(n / 1024)} KB` : n < 1 << 30 ? `${nf1.format(n / (1 << 20))} MB` : `${nf1.format(n / (1 << 30))} GB`;
const short = (id: string | null | undefined) => (id ? id.slice(0, 6) : "-");

/** Tiny DOM builder: h("span", {class: "x"}, "text", child). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
function icon(name: string) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "i");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}

const VIDEO = /\.(webm|mp4|m4v|mov|mkv|ogv)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|avif|heic|bmp)$/i;
const kindIcon = (name: string, kind: string) => (kind === "folder" ? "folder" : VIDEO.test(name) ? "video" : IMAGE.test(name) ? "image" : "file");

// ── komunikaty i akcje ──────────────────────────────────────────────
const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (/fetch|network/i.test(m)) return "Brak połączenia z serwerem. Sprawdź adres i sieć.";
  if (/not a pairing code|bad pairing code/i.test(m)) return "To nie jest kod parowania. Powinien zaczynać się od ddn-pair1:.";
  if (/webhook/i.test(m)) return `Webhook nie zadziałał: ${m}`;
  return m;
};
function toast(text: string, kind: "ok" | "err" = "ok") {
  const t = h("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" }, icon(kind === "err" ? "info" : "info"), h("span", {}, text));
  ui("toasts").append(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 3500);
}
/** Run an action from a button: busy state, Polish error message instead of a silent rejection. */
async function act(btn: HTMLElement | null, fn: () => Promise<unknown>) {
  if (btn?.getAttribute("aria-busy") === "true") return;
  btn?.setAttribute("aria-busy", "true");
  try {
    await fn();
  } catch (e) {
    toast(errText(e), "err");
  } finally {
    btn?.removeAttribute("aria-busy");
  }
}

// ── stan widoku ─────────────────────────────────────────────────────
const PAGE = 50;
let cursorStack: (string | undefined)[] = [undefined];
let currentFolder = "root";
let path: { id: string; name: string }[] = [{ id: "root", name: "Mój dysk" }];
let uploading: { done: number; total: number } | null = null;
let devicesLoaded = false;

function openFolder(id: string, name: string) {
  const at = path.findIndex((p) => p.id === id);
  path = at >= 0 ? path.slice(0, at + 1) : [...path, { id, name }];
  currentFolder = id;
  cursorStack = [undefined];
  void render();
}

function renderCrumbs() {
  const nav = ui("crumbs");
  nav.replaceChildren();
  path.forEach((p, i) => {
    if (i) nav.append(h("span", { class: "sep", "aria-hidden": "true" }, "/"));
    const last = i === path.length - 1;
    const b = h("button", { class: "crumb", type: "button", title: p.name }, p.name);
    if (last) b.setAttribute("aria-current", "page");
    else b.onclick = () => openFolder(p.id, p.name);
    nav.append(b);
  });
}

function chip(dot: string, text: string, title: string) {
  return h("span", { class: "chip", title }, h("span", { class: `dot ${dot}` }), text);
}

function renderStatus(st: Awaited<ReturnType<typeof core.status>>) {
  const s = $("status");
  if (!st.signedIn) {
    s.replaceChildren(chip("", st.hasAccount ? "łączenie…" : "niezalogowano", "To urządzenie nie ma jeszcze konta."));
    return;
  }
  s.replaceChildren(
    st.leader
      ? chip("ok", "karta główna", "Ta karta prowadzi spis plików na dysku przeglądarki (OPFS). Inne otwarte karty są pomocnicze.")
      : chip("warm", "karta pomocnicza", "Spis na dysku prowadzi inna otwarta karta. Ta działa na kopii w pamięci: wszystko działa, tylko start jest wolniejszy."),
    uploading
      ? chip("live", `wysyłanie ${uploading.done}/${uploading.total}`, "Wysyłanie trwa, dopóki ta karta jest otwarta.")
      : chip("live", `synchronizacja · zmiana ${nf0.format(st.headSeq)}`, `Pozycja w dzienniku zmian: ${st.headSeq}. Zmiany z innych urządzeń przychodzą od razu.`),
    chip(st.persistent ? "ok" : "", st.persistent ? "pamięć trwała" : "pamięć podręczna", st.persistent
      ? "Przeglądarka obiecała nie czyścić danych tej witryny. Mimo to to tylko kopia: pliki są na Discordzie."
      : "Przeglądarka może wyczyścić lokalną kopię spisu. Pliki są na Discordzie, spis odtworzy się z serwera."),
    h("span", { class: "chip", title: `Identyfikator urządzenia: ${st.deviceId ?? "-"}` }, icon("phone"), h("b", {}, short(st.deviceId))),
  );
}

function fileRow(r: { id: string; name: string; kind: "file" | "folder"; size: number | null }) {
  const li = h("li", { class: "row" });
  li.dataset.ddn = "row";
  li.dataset.id = r.id;
  const ic = kindIcon(r.name, r.kind);
  const name = h("div", { class: "name" });
  const sub = h("span", { class: "sub" }, r.kind === "folder" ? "folder" : fmt(r.size));
  const acts = h("div", { class: "acts" });
  if (r.kind === "folder") {
    const b = h("button", { class: "name-btn", type: "button", title: r.name }, r.name);
    b.onclick = () => openFolder(r.id, r.name);
    name.append(b, sub);
    const go = h("button", { class: "iconbtn", type: "button", "aria-label": `Otwórz ${r.name}` }, icon("right"));
    go.onclick = () => openFolder(r.id, r.name);
    acts.append(go);
  } else {
    name.append(h("span", { class: "name-text", title: r.name }, r.name), sub);
    if (VIDEO.test(r.name)) {
      const play = h("button", { class: "iconbtn", type: "button", "aria-label": `Odtwórz ${r.name}`, title: "Odtwórz" }, icon("play"));
      play.dataset.ddn = "play";
      play.onclick = () => openPlayer(r.id, r.name, r.size ?? 0);
      acts.append(play);
    }
    const dl = h("button", { class: "iconbtn", type: "button", "aria-label": `Pobierz ${r.name}`, title: "Pobierz" }, icon("down"));
    dl.dataset.ddn = "download";
    dl.onclick = () =>
      act(dl, async () => {
        const b = await core.download(r.id);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = r.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      });
    acts.append(dl);
  }
  li.append(h("span", { class: `ficon ${ic}` }, icon(ic)), name, h("span", { class: "size" }, r.kind === "folder" ? "" : fmt(r.size)), acts);
  return li;
}

function openPlayer(id: string, name: string, size: number) {
  const d = ui<HTMLDialogElement>("player-dialog");
  const v = $<HTMLVideoElement>("player");
  ui("player-title").textContent = name;
  v.src = `./ddn/file/${encodeURIComponent(id)}?size=${size}`;
  if (!d.open) d.showModal();
  void v.play().catch(() => {});
}
function closePlayer() {
  const v = $<HTMLVideoElement>("player");
  v.pause();
  v.removeAttribute("src");
  v.load();
  ui<HTMLDialogElement>("player-dialog").close();
}

async function renderDevices(myId: string | null) {
  const list = ui("devices");
  try {
    const devs = await core.devices();
    devicesLoaded = true;
    ui("dev-count").textContent = String(devs.length);
    list.replaceChildren(
      ...devs.map((d) => {
        const when = new Date(d.createdAt).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" });
        const li = h("li", {}, icon("phone"), h("span", { class: "mono" }, short(d.deviceId)));
        if (d.deviceId === myId) li.append(h("span", { class: "me" }, "to urządzenie"));
        li.append(h("span", { class: "when" }, `od ${when}`));
        return li;
      }),
    );
  } catch {
    list.replaceChildren(h("li", { class: "muted" }, "Nie udało się pobrać listy urządzeń."));
  }
}

async function render() {
  const st = await core.status();
  renderStatus(st);
  $("signed-out").hidden = st.signedIn;
  $("signed-in").hidden = !st.signedIn;
  if (!st.signedIn) return;

  // kanały: kreator, dopóki nie ma żadnego
  const wh = await core.webhooks();
  const channels = wh.advice.channels;
  ui("app").classList.toggle("setup", !wh.advice.ok);
  const adv = $("advice");
  adv.textContent = wh.advice.message;
  adv.classList.toggle("need", !wh.advice.ok || wh.advice.sharedChannels.length > 0);
  ui("hook-count").textContent = `${channels} ${channels === 1 ? "kanał" : channels >= 2 && channels <= 4 ? "kanały" : "kanałów"}`;
  [...ui("slots").children].forEach((s, i) => s.classList.toggle("on", i < channels));
  ui("hooks").replaceChildren(
    ...wh.webhooks.map((w) => h("li", {}, icon("hook"), h("b", { title: w.label }, w.label || "webhook"), h("span", { class: "mono" }, `#${String(w.channelId).slice(-6)}`))),
  );

  if (!devicesLoaded) void renderDevices(st.deviceId);

  // pliki
  renderCrumbs();
  const page = await core.list(currentFolder, cursorStack.at(-1), PAGE);
  const pageIndex = cursorStack.length - 1;
  // Kopia w pamięci (karta pomocnicza) zwraca cały folder: tniemy na strony tutaj.
  const rows = page.rows.length > PAGE ? page.rows.slice(pageIndex * PAGE, pageIndex * PAGE + PAGE) : page.rows;
  $("list").replaceChildren(...rows.map(fileRow));
  ui("empty").hidden = page.total > 0;
  const from = page.total ? pageIndex * PAGE + 1 : 0;
  const to = pageIndex * PAGE + rows.length;
  $("count").textContent = page.total > PAGE ? `${nf0.format(from)}–${nf0.format(to)} z ${nf0.format(page.total)} pozycji` : `${nf0.format(page.total)} ${page.total === 1 ? "pozycja" : "pozycji"}`;
  const prev = $<HTMLButtonElement>("prev");
  const next = $<HTMLButtonElement>("next");
  prev.disabled = pageIndex === 0;
  next.disabled = to >= page.total;
  const toTop = () => {
    const top = ui("crumbs").getBoundingClientRect().top;
    if (top < 0) ui("crumbs").scrollIntoView({ block: "start" });
  };
  next.onclick = () => {
    if (rows.length && to < page.total) cursorStack.push(page.rows.length > PAGE ? `p${pageIndex + 1}` : rows.at(-1)!.cursor);
    void render().then(toTop);
  };
  prev.onclick = () => {
    if (cursorStack.length > 1) cursorStack.pop();
    void render().then(toTop);
  };
}

// ── kolejka wysyłania ──────────────────────────────────────────────
async function uploadAll(files: File[]) {
  if (!files.length) return;
  const box = ui("queue");
  const list = ui("queue-list");
  const total = files.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  let failed = 0;
  const items = files.map((f) => {
    const state = h("span", { class: "qstate wait" }, "czeka");
    list.append(h("li", {}, h("span", { title: f.name }, f.name), h("span", { class: "mono" }, fmt(f.size)), state));
    return { f, state };
  });
  box.hidden = false;
  ui("queue-close").hidden = true;
  uploading = { done: 0, total: files.length };
  const meta = () => {
    ui("queue-title").textContent = uploading ? `Wysyłanie ${uploading.done} z ${uploading.total}` : failed ? `Wysłano z błędami (${failed})` : "Wysłano";
    ui("queue-meta").textContent = `${fmt(sent)} z ${fmt(total)}`;
    ui("queue-bar").style.width = `${total ? (sent / total) * 100 : 100}%`;
  };
  meta();
  for (const { f, state } of items) {
    state.className = "qstate run";
    state.textContent = "szyfrowanie…";
    try {
      await core.upload(f, f.name, currentFolder);
      state.className = "qstate done";
      state.textContent = "gotowe";
    } catch (e) {
      failed++;
      state.className = "qstate err";
      state.textContent = "błąd";
      state.title = errText(e);
    }
    sent += f.size;
    uploading.done++;
    meta();
    void render();
  }
  uploading = null;
  meta();
  ui("queue-close").hidden = false;
  if (failed) toast(`${failed} z ${files.length} plików nie udało się wysłać. Najedź na „błąd”, żeby zobaczyć powód.`, "err");
  await render();
}

async function main() {
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("./sw.js").catch(() => {});
  await core.init({ discordApiOrigin: cfg.discordApiOrigin, wasmUrl: new URL("./sqlite3.wasm", location.href).href });
  $<HTMLInputElement>("server").value = cfg.serverUrl ?? "http://127.0.0.1:8787";
  $("create").onclick = (e) =>
    act(e.currentTarget as HTMLElement, async () => {
      await core.createAccount($<HTMLInputElement>("server").value, $<HTMLInputElement>("device-name").value || "przeglądarka");
      await core.open();
      await render();
    });
  $("add-webhook").onclick = (e) =>
    act(e.currentTarget as HTMLElement, async () => {
      const i = $<HTMLInputElement>("webhook-url");
      if (!i.value.trim()) throw new Error("Wklej adres webhooka z ustawień kanału.");
      await core.addWebhook(i.value);
      i.value = "";
      await render();
      toast("Kanał dodany.");
    });
  $("mkdir").onclick = (e) =>
    act(e.currentTarget as HTMLElement, async () => {
      const i = $<HTMLInputElement>("folder-name");
      await core.mkdir(i.value.trim() || "Nowy folder", currentFolder);
      i.value = "";
      await render();
    });
  $<HTMLInputElement>("folder-name").onkeydown = (e) => e.key === "Enter" && $("mkdir").click();
  $<HTMLInputElement>("webhook-url").onkeydown = (e) => e.key === "Enter" && $("add-webhook").click();
  $<HTMLInputElement>("file").onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    await uploadAll(files);
  };
  ui("queue-close").onclick = () => {
    ui("queue").hidden = true;
    ui("queue-list").replaceChildren();
  };
  $("pair").onclick = (e) =>
    act(e.currentTarget as HTMLElement, async () => {
      const r = await core.pairAccept($<HTMLInputElement>("pair-code").value);
      $("pair-sas").textContent = r.sas;
      ui("sas-box").hidden = false;
      ui("sas-box").scrollIntoView({ block: "nearest" });
      $<HTMLInputElement>("pair-code").value = "";
      devicesLoaded = false;
      await render();
    });
  ui("player-close").onclick = closePlayer;
  ui<HTMLDialogElement>("player-dialog").addEventListener("close", () => $<HTMLVideoElement>("player").pause());
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.onclick = () => {
      ui("app").dataset.tab = t.dataset.tab!;
      document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    };
  });
  if ((await core.status()).hasAccount) await act(null, () => core.open());
  await render();
  let seen = -1;
  setInterval(async () => {
    const v = (await core.status()).version;
    if (v !== seen) ((seen = v), void render());
  }, 1000);
  document.body.dataset.ready = "1";
}

void main();
