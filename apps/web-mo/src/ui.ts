// UI layer of the metadata-only browser client. Look: Cobalt (the theme of discordrive, cobalt/README.md);
// layout: discordrive's app-shell (sidebar Files / Devices / Settings, AuthCard screens before sign-in).
// Routing: History API (/, /folder/<id>, /devices, /settings, /welcome; signed out: /, /join, /restore;
// share links /s/<id>#<key>); the instance serves index.html for every path without an extension, so a
// reload keeps the page. Texts: i18n.ts (en default, pl); static HTML via data-i18n hooks.
// Every element the tests drive keeps its stable data-ddn attribute; purely visual hooks use data-ddn-ui.
// All logic lives in app-core (worker) behind `core`.
//
// on* handlers: always a block body or `void …`. An on* handler that RETURNS false cancels the event
// (an `e.key === "Enter" && …` arrow blocked typing in the webhook field); check.ts greps for it.
import { renderSVG } from "uqr";
import type { CoreEvent } from "./app-core.js";
import { applyStatic, fmtDate, fmtDateTime, fmtNum, fmtSize, getLang, isLang, setLang, storeLang, storedLang, t, tn, type Lang } from "./i18n.js";
import { connect } from "./rpc.js";

/** Mode this bundle was built for (build.ts define). */
declare const __DDN_MODE__: string;
/** Server-side features of this mode (plain: thumbnails, search, streaming). */
let features = { thumbnails: false, search: false, streaming: false };
/** plain: current server search ("" = none). */
let searchQ = "";

const cfg = (window as unknown as { DDN_CONFIG?: { discordApiOrigin?: string; serverUrl?: string; language?: string } }).DDN_CONFIG ?? {};
// Language before the first paint: this browser's choice, else the instance default, else English.
setLang(storedLang() ?? (isLang(cfg.language) ? cfg.language : "en"));
applyStatic();
/** Same-origin instance (served by `discordrive serve`): the API is this origin. */
const serverUrl = cfg.serverUrl ?? location.origin;
const worker = new Worker("./worker.js", { type: "module" });
const progressHandlers = new Map<string, (done: number, total: number) => void>();
let onShareProgress: (done: number, total: number) => void = () => {};
function onCoreEvent(e: CoreEvent) {
  if (e.type === "upload-progress") progressHandlers.get(e.token)?.(e.done, e.total);
  else if (e.type === "share-progress") onShareProgress(e.done, e.total);
  else if (e.type === "changed") void render();
}
export const core = connect(worker, onCoreEvent);
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
const all = <T extends HTMLElement>(css: string) => [...document.querySelectorAll<T>(css)];

const fmt = fmtSize;
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
const chip = (text: string, tone = "", title = "") => h("span", { class: `chip${tone ? ` chip--${tone}` : ""}`, ...(title ? { title } : {}) }, text);

// File type badge (FileTable): from the extension, the index keeps no MIME type.
const EXT: [RegExp, string, string][] = [
  [/\.(webm|mp4|m4v|mov|mkv|ogv|avi)$/i, "video", "media"],
  [/\.(jpe?g|png|gif|webp|avif|heic|bmp|svg)$/i, "image", "media"],
  [/\.(mp3|flac|wav|ogg|oga|m4a|opus|aac)$/i, "audio", ""],
  [/\.pdf$/i, "pdf", "doc"],
  [/\.(docx?|odt|rtf|pages)$/i, "doc", "doc"],
  [/\.(xlsx?|ods|csv|tsv)$/i, "sheet", "sheet"],
  [/\.(zip|gz|tgz|tar|7z|rar|xz|bz2|zst)$/i, "archive", "archive"],
  [/\.(txt|md|json|log|ya?ml|xml|html?|ini|toml)$/i, "text", ""],
];
const typeOf = (name: string) => EXT.find(([re]) => re.test(name)) ?? [null, "file", ""];
const VIDEO = EXT[0]![0];

// ── messages and actions ────────────────────────────────────────────
const KNOWN_ERRORS = ["invite_required", "signup_closed", "rate_limited", "unauthorized", "body_too_large", "need_channel", "pointer_hook_gone", "instance_busy", "discord_blocked", "webhook_in_use", "too_many_channels"];
/** Readable text for an error: no technical codes in the message (the raw one goes to the console). */
const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  console.warn("ddn:", m);
  if (/fetch|network/i.test(m)) return t("err.network");
  if (/not a pairing code|bad pairing code/i.test(m)) return t("err.pairCode");
  const code = KNOWN_ERRORS.find((c) => m.includes(c));
  if (code) return t(`err.${code}`);
  if (/webhook/i.test(m)) return t("err.webhook");
  return /^[A-Z]/.test(m) && !/[_{}]/.test(m) ? m : t("err.generic", { msg: m.replace(/^[a-z_]+:\s*/, "") });
};
function toast(text: string, kind: "ok" | "err" | "info" = "ok") {
  const el = h("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" }, text);
  ui("toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3500);
}
/** Run an action from a button: busy state, a readable error message instead of a silent rejection. */
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

// ── routing ─────────────────────────────────────────────────────────
type Route =
  | { name: "files"; folder: string }
  | { name: "devices" }
  | { name: "settings" }
  | { name: "welcome" }
  | { name: "create" }
  | { name: "join" }
  | { name: "restore" };
const SIGNED_OUT_ROUTES = new Set(["create", "join", "restore"]);
function parseRoute(path = location.pathname): Route {
  const p = path.replace(/\/+$/, "") || "/";
  const f = /^\/folder\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (f) return { name: "files", folder: f[1]! };
  if (p === "/devices") return { name: "devices" };
  if (p === "/settings") return { name: "settings" };
  if (p === "/welcome") return { name: "welcome" };
  if (p === "/join") return { name: "join" };
  if (p === "/restore") return { name: "restore" };
  return { name: "files", folder: "root" };
}
const hrefOf = (r: Route) =>
  r.name === "files" ? (r.folder === "root" ? "/" : `/folder/${r.folder}`) : r.name === "create" ? "/" : `/${r.name}`;
let route: Route = parseRoute();
let routeSeq = 0;
/** Go to a page (pushState). `replace` for redirects, so Back does not bounce. */
function navigate(href: string, replace = false) {
  const u = new URL(href, location.origin);
  if (u.pathname + u.hash !== location.pathname + location.hash) history[replace ? "replaceState" : "pushState"](null, "", u.pathname + u.search + u.hash);
  void onRoute();
}
async function onRoute() {
  const prev = route;
  route = parseRoute();
  const seq = ++routeSeq;
  if (prev.name !== route.name || (prev.name === "files" && route.name === "files" && prev.folder !== route.folder)) {
    cursorStack = [undefined];
    if (route.name === "devices") devicesLoaded = false;
    if (route.name === "join") resetJoin?.();
  }
  closeDrawer();
  await render();
  if (seq !== routeSeq) return;
  const anchor = location.hash.length > 1 && !location.hash.startsWith("#pair=") ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (anchor) anchor.scrollIntoView({ block: "start" });
  else if (prev.name !== route.name || (prev.name === "files" && route.name === "files" && prev.folder !== route.folder)) window.scrollTo(0, 0);
}
function wireLinks() {
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a[data-link]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute("href")!);
  });
  window.addEventListener("popstate", () => {
    void onRoute();
  });
}

// ── mobile drawer (MainLayout) ──────────────────────────────────────
function openDrawer() {
  ui("signed-in-shell").dataset.drawer = "open";
  ui("nav-open").setAttribute("aria-expanded", "true");
  ui<HTMLElement>("sidebar").querySelector<HTMLElement>("a[aria-current=page], a")?.focus({ preventScroll: true });
}
function closeDrawer() {
  const s = ui("signed-in-shell");
  if (s.dataset.drawer !== "open") return;
  delete s.dataset.drawer;
  ui("nav-open").setAttribute("aria-expanded", "false");
}
function wireDrawer() {
  ui("nav-open").onclick = () => openDrawer();
  ui("nav-close").onclick = () => closeDrawer();
  ui("scrim").onclick = () => closeDrawer();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
}

// ── view state ──────────────────────────────────────────────────────
const PAGE = 50;
let cursorStack: (string | undefined)[] = [undefined];
let uploading: { done: number; total: number } | null = null;
let devicesLoaded = false;
let channelsOk = false;
let sharesOn = false;
let shareMode = false;
let resetJoin: (() => void) | null = null;
const SKIP_KEY = "ddn.skip-welcome";

const currentFolder = () => (route.name === "files" ? route.folder : "root");
const openFolder = (id: string) => navigate(id === "root" ? "/" : `/folder/${id}`);

function renderCrumbs(path: { id: string; name: string }[]) {
  const nav = ui("crumbs");
  const kids: (Node | string)[] = [];
  // Mobile: back arrow to the parent (FolderBreadcrumb); desktop: the full path.
  const back = h("span", { class: "back" });
  if (path.length) {
    const parent = path.at(-2);
    const a = h("a", { href: parent ? `/folder/${parent.id}` : "/", "data-link": "" }, icon("left"), parent ? parent.name : t("files.root"));
    back.append(a);
  } else back.append(h("span", { "aria-current": "page" }, t("files.root")));
  kids.push(back);
  const desk = h("span", { class: "desk crumbs" });
  desk.append(path.length ? h("a", { href: "/", "data-link": "" }, t("files.root")) : h("span", { "aria-current": "page" }, t("files.root")));
  path.forEach((p, i) => {
    desk.append(icon("right"));
    desk.append(i === path.length - 1 ? h("span", { "aria-current": "page", title: p.name }, p.name) : h("a", { href: `/folder/${p.id}`, "data-link": "", title: p.name }, p.name));
  });
  kids.push(desk);
  nav.replaceChildren(...kids);
}

type Status = Awaited<ReturnType<typeof core.status>>;

function renderShellStatus(st: Status) {
  const s = $("status");
  s.dataset.tabRole = st.leader ? "main" : "secondary";
  s.replaceChildren(
    uploading
      ? chip(t("status.uploading", { done: uploading.done, total: uploading.total }), "accent", t("status.uploading.t"))
      : chip(t("status.synced"), "success", t("status.synced.t", { seq: fmtNum(st.headSeq) })),
  );
  const me = ui("me-name");
  me.textContent = st.deviceName || short(st.deviceId);
  me.title = st.deviceId ?? "";
}

/** Folder + page of the list shown last: the row stagger (.reveal) plays only when that changes, like
 * discordrive's one-shot load (render() also runs after every upload and sync, and the rows must not fade again). */
let shownList = "";

function fileRow(r: { id: string; name: string; kind: "file" | "folder"; size: number | null; modifiedAt?: number | null }, i: number, enter = false) {
  const tr = enter ? h("tr", { class: "reveal", style: `--i:${Math.min(i, 12)}` }) : h("tr");
  tr.dataset.ddn = "row";
  tr.dataset.id = r.id;
  const name = h("td", { class: "c-name" });
  const acts = h("span", { class: "acts" });
  const iconBtn = (ic: string, label: string, title: string, tone = "") => h("button", { class: `iconbtn${tone ? ` ${tone}` : ""}`, type: "button", "aria-label": label, title }, icon(ic));
  if (r.kind === "folder") {
    name.append(h("span", { class: "nm" }, icon("folder"), h("a", { href: `/folder/${r.id}`, "data-link": "", title: r.name }, r.name)), h("span", { class: "sub" }, t("files.folder")));
    const go = iconBtn("right", t("files.open", { name: r.name }), t("files.open", { name: r.name }));
    go.onclick = () => openFolder(r.id);
    acts.append(go);
  } else {
    const [, label, tone] = typeOf(r.name);
    const badge = h("span", { class: `badge ${tone}` }, label);
    if (features.thumbnails && tone === "media") void showThumb(badge, r.id);
    name.append(h("span", { class: "nm" }, badge, h("span", { title: r.name }, r.name)), h("span", { class: "sub" }, [fmt(r.size), r.modifiedAt ? fmtDate(r.modifiedAt) : ""].filter(Boolean).join(" · ")));
    if (VIDEO.test(r.name)) {
      const play = iconBtn("play", t("files.play.aria", { name: r.name }), t("files.play"));
      play.dataset.ddn = "play";
      play.onclick = () => void openPlayer(r.id, r.name, r.size ?? 0);
      acts.append(play);
    }
    const dl = iconBtn("download", t("files.download.aria", { name: r.name }), t("files.download"), "accent");
    dl.dataset.ddn = "download";
    dl.onclick = () =>
      void act(dl, async () => {
        const b = await core.download(r.id);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = r.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      });
    acts.append(dl);
    if (sharesOn) {
      const sh = iconBtn("share", t("files.share.aria", { name: r.name }), t("files.share"));
      sh.dataset.ddn = "share";
      sh.onclick = () =>
        void act(sh, async () => {
          const s = await core.shareFile(r.id, serverUrl);
          ui("share-name").textContent = r.name;
          $<HTMLTextAreaElement>("share-link").value = s.link;
          $<HTMLDialogElement>("share-dialog").showModal();
        });
      acts.append(sh);
    }
  }
  const when = r.kind === "file" && r.modifiedAt ? fmtDate(r.modifiedAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  tr.append(name, h("td", { class: "size" }, r.kind === "folder" ? "" : fmt(r.size)), h("td", { class: "c-date" }, when), h("td", { class: "c-acts" }, acts));
  return tr;
}

/** plain: replace the type badge with the server's thumbnail once it exists (cached per file). */
const thumbs = new Map<string, Promise<string | null>>();
const thumbTries = new Map<string, number>();
async function showThumb(badge: HTMLElement, id: string) {
  let p = thumbs.get(id);
  if (!p) {
    p = core.thumbnail(id).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
    thumbs.set(id, p);
    // Not ready yet (made in the background after the upload): forget the miss and render again soon.
    void p.then((u) => {
      if (u) return;
      const tries = (thumbTries.get(id) ?? 0) + 1;
      thumbTries.set(id, tries);
      if (tries <= 10)
        setTimeout(() => {
          thumbs.delete(id);
          shownList = ""; // no row animation on this refresh
          void render();
        }, 2000 * tries);
    });
  }
  const url = await p;
  if (url && badge.isConnected) badge.replaceWith(Object.assign(h("img", { class: "thumb", alt: "", "data-ddn": "thumb" }), { src: url }));
}

async function openPlayer(id: string, name: string, size: number) {
  const d = ui<HTMLDialogElement>("player-dialog");
  const v = $<HTMLVideoElement>("player");
  ui("player-title").textContent = name;
  // plain: straight from the server (Range on the plaintext); other modes: the service worker decrypts here.
  const direct = features.streaming ? await core.streamUrl(id).catch(() => null) : null;
  v.src = direct ?? `./ddn/file/${encodeURIComponent(id)}?size=${size}`;
  v.dataset.source = direct ? "server" : "sw";
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
        const li = h("li", { title: `ID: ${d.deviceId}` }, icon("phone"), d.name ? h("span", { class: "dname" }, d.name) : h("span", { class: "dname mono" }, short(d.deviceId)));
        li.dataset.ddn = "device";
        if (d.deviceId === myId) li.append(chip(t("dev.me"), "accent"));
        li.append(h("span", { class: "when" }, t("dev.since", { date: fmtDate(d.createdAt) })));
        if (d.deviceId !== myId) {
          const name = d.name ?? short(d.deviceId);
          const rm = h("button", { class: "iconbtn danger", type: "button", "aria-label": t("dev.revoke.aria", { name }), title: t("dev.revoke") }, icon("x"));
          rm.onclick = () =>
            void act(rm, async () => {
              if (!confirm(t("dev.revoke.confirm", { name }))) return;
              await core.revokeDevice(d.deviceId);
              devicesLoaded = false;
              await render();
            });
          li.append(rm);
        } else li.append(h("span", { style: "width:31px", "aria-hidden": "true" }));
        return li;
      }),
    );
  } catch {
    list.replaceChildren(h("li", { class: "empty-row" }, t("dev.loadFail")));
  }
}

async function renderShares() {
  ui("share-state").replaceChildren(document.createTextNode(sharesOn ? t("sh.on") : t("sh.off.state")));
  ui("share-state").className = `chip${sharesOn ? " chip--success" : ""}`;
  ui("share-lead").textContent = sharesOn ? t("sh.lead.on") : t("sh.lead.off");
  if (!sharesOn) {
    $("shares").replaceChildren();
    $("shares").hidden = true;
    ui("shares-empty").hidden = true;
    return;
  }
  const list = await core.shares().catch(() => null);
  if (!list) return;
  const live = list.filter((x) => !x.revoked);
  $("shares").hidden = live.length === 0;
  ui("shares-empty").hidden = live.length > 0;
  $("shares").replaceChildren(
    ...live.map((x) => {
      const name = x.name ?? t("sh.file");
      const li = h("li", {}, icon("share"), h("span", { class: "dname" }, name), h("span", { class: "when" }, fmtDate(x.createdAt, {})));
      const off = h("button", { class: "iconbtn danger", type: "button", "aria-label": t("sh.off.aria", { name }), title: t("sh.off") }, icon("x"));
      off.onclick = () =>
        void act(off, async () => {
          await core.revokeShare(x.shareId);
          await renderShares();
          toast(t("sh.offDone"));
        });
      li.append(off);
      return li;
    }),
  );
}

function renderHooks(wh: Awaited<ReturnType<typeof core.webhooks>>) {
  const a = wh.advice;
  const adv = $("advice");
  adv.textContent = [!a.ok ? t("advice.none") : a.suggestMore ? t("advice.more") : t("advice.ok"), a.sharedChannels.length ? t("advice.shared") : ""].filter(Boolean).join(" ");
  adv.classList.toggle("need", !a.ok || a.sharedChannels.length > 0);
  ui("hook-count").textContent = tn("hooks.channels", a.channels);
  ui("hook-count").className = `chip${a.ok ? " chip--success" : " chip--warning"}`;
  [...ui("slots").children].forEach((s, i) => s.classList.toggle("on", i < a.channels));
  // e2ee/plain: the instance pool (count only, the URLs stay on the server) and removable own channels.
  const pool = wh.pool && wh.pool.channels > 0 && wh.using !== "own" ? [h("li", { class: "pool-row", "data-ddn": "pool" }, icon("hash"), h("span", { class: "ptext" }, tn("hooks.pool", wh.pool.channels)), chip(t("hooks.pool.chip"), "accent"))] : [];
  const removable = typeof wh.using === "string";
  ui("hooks").replaceChildren(
    ...pool,
    ...(wh.webhooks.length
      ? wh.webhooks.map((w) => {
          const li = h("li", {}, icon("hash"), h("span", { class: "dname", title: w.label }, w.label || "webhook"), h("span", { class: "when" }, `#…${String(w.channelId).slice(-6)}`));
          if (removable) {
            const rm = h("button", { class: "iconbtn danger", type: "button", "data-ddn": "remove-webhook", "aria-label": t("hooks.remove"), title: t("hooks.remove") }, icon("x"));
            rm.onclick = () =>
              void act(rm, async () => {
                await core.removeWebhook(w.id);
                await render();
                toast(t("hooks.removed"));
              });
            li.append(rm);
          }
          return li;
        })
      : pool.length
        ? []
        : [h("li", { class: "empty-row" }, t("hooks.none"))]),
  );
}

/** One copy of the channel form: in the onboarding card on the first run, in Settings otherwise. */
function placeHooks(where: "wizard" | "settings") {
  const block = ui("hooks-block");
  const target = where === "wizard" ? ui("wiz-slot") : ui("hooks-slot");
  if (block.parentElement !== target) target.prepend(block);
  ui<HTMLDetailsElement>("howto").open = where === "wizard";
}

function showOnly(view: "signed-out" | "onboarding" | "shell" | "share") {
  $("signed-out").hidden = view !== "signed-out";
  ui("onboarding").hidden = view !== "onboarding";
  $("signed-in").hidden = view !== "shell";
  $("share-view").hidden = view !== "share";
}

let rendering: Promise<void> | null = null;
let again = false;
/** Serialised: a render requested while one runs is coalesced into one more. */
function render(): Promise<void> {
  if (rendering) {
    again = true;
    return rendering;
  }
  rendering = renderNow().finally(() => {
    rendering = null;
    if (again) {
      again = false;
      void render();
    }
  });
  return rendering;
}

/** False until main() has opened the account: an early render would see "signed out" and redirect. */
let booted = false;

async function renderNow() {
  if (shareMode || !booted) return;
  const st = await core.status();
  if (!st.signedIn) {
    showOnly("signed-out");
    if (!SIGNED_OUT_ROUTES.has(route.name) && !(route.name === "files" && route.folder === "root")) return navigate("/", true);
    const screen = route.name === "join" || route.name === "restore" ? route.name : "create";
    all<HTMLElement>("[data-auth]").forEach((el) => (el.hidden = el.dataset.auth !== screen));
    document.title = t("app.title");
    return;
  }
  if (route.name === "join" || route.name === "restore") return navigate("/", true);

  const wh = await core.webhooks();
  channelsOk = wh.advice.ok;
  renderHooks(wh);
  // First run: no channel and no saved kit yet -> onboarding (unless skipped in this tab).
  const firstRun = !wh.advice.ok && !st.kitSaved;
  if (route.name === "files" && route.folder === "root" && firstRun && !sessionStorage.getItem(SKIP_KEY)) return navigate("/welcome", true);
  if (route.name === "welcome" && wh.advice.ok && st.kitSaved && !$<HTMLDialogElement>("kit-dialog").open) return navigate("/", true);
  // The rescue kit is forced once, right after the first channel (wherever that was added).
  if (wh.advice.ok && !st.kitSaved && !$<HTMLDialogElement>("kit-dialog").open) void openKit(true);

  if (route.name === "welcome") {
    showOnly("onboarding");
    const kitStep = wh.advice.ok;
    placeHooks("wizard");
    ui("hooks-block").hidden = kitStep;
    ui("wiz-kit").hidden = !kitStep;
    ui("wiz-h").textContent = t(kitStep ? "wiz.kit.h1" : "wiz.h1");
    ui("wiz-lead").textContent = t(kitStep ? "wiz.kit.lead" : "wiz.lead");
    ui("step-channel").classList.toggle("done", kitStep);
    ui("step-channel").toggleAttribute("aria-current", !kitStep);
    if (!kitStep) ui("step-channel").setAttribute("aria-current", "step");
    ui("step-kit").toggleAttribute("aria-current", kitStep);
    if (kitStep) ui("step-kit").setAttribute("aria-current", "step");
    ui("wiz-skip").hidden = kitStep;
    document.title = `${t("wiz.h1")} · ${t("app.title")}`;
    return;
  }

  showOnly("shell");
  placeHooks("settings");
  ui("hooks-block").hidden = false;
  renderShellStatus(st);
  const page = route.name;
  all<HTMLElement>("[data-page]").forEach((el) => (el.hidden = el.dataset.page !== page));
  all<HTMLAnchorElement>("a[data-nav]").forEach((a) => (a.dataset.nav === page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${t(`page.${page}`)} · ${t("app.title")}`;

  if (page === "devices") {
    if (!devicesLoaded) await renderDevices(st.deviceId);
    return;
  }
  if (page === "settings") {
    ui("acc-id").textContent = st.accountId ?? "-";
    ui("acc-device").textContent = st.deviceName || short(st.deviceId);
    ui("acc-server").textContent = serverUrl;
    ui("about-sync").replaceChildren(document.createTextNode(uploading ? t("status.uploading", { done: uploading.done, total: uploading.total }) : t("status.synced")));
    ui("about-sync").className = "chip chip--success";
    ui("about-sync-t").textContent = t("status.synced.t", { seq: fmtNum(st.headSeq) });
    ui("about-tab").textContent = st.leader ? t("status.main") : t("status.secondary");
    ui("about-tab").className = `chip${st.leader ? "" : " chip--warning"}`;
    ui("about-tab-t").textContent = st.leader ? t("status.main.t") : t("status.secondary.t");
    ui("about-storage").textContent = st.persistent ? t("status.persistent") : t("status.cache");
    ui("about-storage-t").textContent = st.persistent ? t("status.persistent.t") : t("status.cache.t");
    ui("about-device").textContent = st.deviceId ?? "-";
    await renderShares();
    return;
  }

  // Files
  const folder = currentFolder();
  // Recomputed on every render: another device may rename or remove a folder on the path.
  const path = folder === "root" ? [] : await core.folderPath(folder);
  if (!path) {
    toast(t("files.gone"), "err");
    return navigate("/", true);
  }
  renderCrumbs(path);
  ui("folder-title").textContent = path.length ? path.at(-1)!.name : t("files.root");
  if (searchQ) return renderSearch();
  const [stats, pg] = await Promise.all([core.folderStats(folder), core.list(folder, cursorStack.at(-1), PAGE)]);
  ui("folder-meta").textContent = [tn("files.meta.folders", stats.folders), tn("files.meta.files", stats.files), stats.bytes > 0 ? fmt(stats.bytes) : ""].filter(Boolean).join(" · ");
  ui("need-channel").hidden = channelsOk;
  ui("upload-btn").setAttribute("aria-disabled", String(!channelsOk));
  $<HTMLInputElement>("file").disabled = !channelsOk;
  const pageIndex = cursorStack.length - 1;
  // Both kinds of tab (main on OPFS, secondary in memory) page with a (name, id) cursor.
  const rows = pg.rows;
  const listKey = `${folder}|${pageIndex}|${cursorStack.at(-1) ?? ""}`;
  const enter = listKey !== shownList;
  shownList = listKey;
  $("list").replaceChildren(...rows.map((row, i) => fileRow(row, i, enter)));
  ui("empty").hidden = pg.total > 0;
  ui("search-empty").hidden = true;
  const from = pg.total ? pageIndex * PAGE + 1 : 0;
  const to = pageIndex * PAGE + rows.length;
  $("count").textContent = pg.total > PAGE ? t("files.range", { from: fmtNum(from), to: fmtNum(to), total: fmtNum(pg.total) }) : tn("files.count", pg.total);
  // One page only: no pager (the counts are in the heading).
  ui("pager-btns").hidden = pg.total <= PAGE;
  const prev = $<HTMLButtonElement>("prev");
  const next = $<HTMLButtonElement>("next");
  prev.disabled = pageIndex === 0;
  next.disabled = to >= pg.total;
  const toTop = () => {
    if (ui("folder-title").getBoundingClientRect().top < 0) window.scrollTo(0, 0);
  };
  next.onclick = () => {
    if (rows.length && to < pg.total) cursorStack.push(rows.at(-1)!.cursor);
    void render().then(toTop);
  };
  prev.onclick = () => {
    if (cursorStack.length > 1) cursorStack.pop();
    void render().then(toTop);
  };
}

/** plain: results of a server search in the file table (one page, up to 200). */
async function renderSearch() {
  const hits = await core.search(searchQ);
  ui("folder-meta").textContent = tn("search.results", hits.length, { q: searchQ });
  $("list").replaceChildren(...hits.map((x, i) => fileRow({ ...x, cursor: "" } as never, i, false)));
  ui("empty").hidden = true;
  ui("search-empty").hidden = hits.length > 0;
  $("count").textContent = tn("files.count", hits.length);
  ui("pager-btns").hidden = true;
}

function wireSearch() {
  const box = ui<HTMLFormElement>("search");
  box.hidden = !features.search;
  if (!features.search) return;
  const input = $<HTMLInputElement>("search");
  const clear = ui<HTMLButtonElement>("search-clear");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const go = () => {
    clear.hidden = !input.value;
    searchQ = input.value.trim();
    shownList = "";
    void render();
  };
  box.onsubmit = (e) => {
    e.preventDefault();
    go();
  };
  clear.onclick = () => {
    if (timer) clearTimeout(timer);
    input.value = "";
    go();
    input.focus();
  };
  input.oninput = () => {
    clear.hidden = !input.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(go, 300);
  };
}

// ── upload queue (UploadProgress) ───────────────────────────────────
async function uploadAll(files: File[]) {
  if (!files.length) return;
  if (!channelsOk) {
    toast(t("err.need_channel"), "err");
    return;
  }
  const folder = currentFolder();
  const box = ui("queue");
  const list = ui("queue-list");
  const total = files.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  let failed = 0;
  const items = files.map((f) => {
    const state = h("span", { class: "qstate" }, t("queue.wait"));
    const bar = h("i");
    const token = crypto.randomUUID();
    const cancel = h("button", { class: "iconbtn qcancel", type: "button", "data-ddn": "queue-cancel", "aria-label": t("queue.cancel"), title: t("queue.cancel") }, icon("x"));
    const li = h("li", {}, h("span", { class: "qname", title: f.name }, f.name), h("span", { class: "qside" }, cancel, state), h("span", { class: "bar" }, bar), h("span", { class: "qfoot" }, fmt(f.size)));
    li.dataset.ddn = "queue-item";
    list.append(li);
    const item = { f, state, bar, token, cancel, cancelled: false };
    cancel.onclick = () => {
      item.cancelled = true;
      cancel.hidden = true;
      void core.cancelUpload(token);
    };
    return item;
  });
  box.hidden = false;
  ui("queue-close").hidden = true;
  uploading = { done: 0, total: files.length };
  const meta = () => {
    ui("queue-title").textContent = uploading ? t("queue.running", { done: uploading.done, total: uploading.total }) : failed ? t("queue.doneErr", { n: failed }) : t("queue.done");
    ui("queue-meta").textContent = t("queue.meta", { sent: fmt(sent), total: fmt(total) });
  };
  meta();
  for (const item of items) {
    const { f, state, bar, token } = item;
    if (item.cancelled) {
      state.className = "qstate cancel";
      bar.className = "cancel";
      state.textContent = t("queue.cancelled");
      uploading.done++;
      meta();
      continue;
    }
    state.className = "qstate run";
    state.textContent = t("queue.encrypting");
    const base = sent;
    progressHandlers.set(token, (done, tot) => {
      const pct = tot ? Math.floor((done / tot) * 100) : 100;
      state.textContent = `${pct}%`;
      bar.style.width = `${pct}%`;
      sent = base + done;
      meta();
    });
    try {
      await core.upload(f, f.name, folder, token);
      state.className = "qstate done";
      state.textContent = t("queue.ok");
      bar.className = "done";
    } catch (e) {
      // Cancelled is the user's choice, not a failure: muted text and bar like discordrive's CANCELLED.
      state.className = item.cancelled ? "qstate cancel" : "qstate err";
      bar.className = item.cancelled ? "cancel" : "err";
      if (item.cancelled) state.textContent = t("queue.cancelled");
      else {
        failed++;
        state.textContent = t("queue.err");
        state.title = errText(e);
      }
    } finally {
      progressHandlers.delete(token);
      item.cancel.hidden = true;
    }
    sent = base + f.size;
    if (!item.cancelled) bar.style.width = "100%"; // a cancelled bar stays where it stopped
    uploading.done++;
    meta();
    void render();
  }
  uploading = null;
  meta();
  ui("queue-close").hidden = false;
  if (failed) toast(t("queue.failed", { failed, total: files.length }), "err");
  await render();
}

function wireFilesPage() {
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
  // Drop zone + drag over the whole Files page (Dashboard).
  const zone = ui("dropzone");
  const page = document.querySelector<HTMLElement>("[data-page=files]")!;
  let depth = 0;
  const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  page.addEventListener("dragenter", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    if (++depth === 1) zone.classList.add("over");
  });
  page.addEventListener("dragleave", (e) => {
    if (!isFiles(e)) return;
    if (--depth <= 0) ((depth = 0), zone.classList.remove("over"));
  });
  page.addEventListener("dragover", (e) => {
    if (isFiles(e)) e.preventDefault();
  });
  page.addEventListener("drop", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove("over");
    void uploadAll([...(e.dataTransfer?.files ?? [])]);
  });
  zone.onclick = () => {
    if (channelsOk) $<HTMLInputElement>("file").click();
    else toast(t("err.need_channel"), "err");
  };
  zone.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zone.click();
    }
  };
  // New folder (NewFolderModal).
  const d = $<HTMLDialogElement>("folder-dialog");
  const name = $<HTMLInputElement>("folder-name");
  $("new-folder").onclick = () => {
    name.value = "";
    d.showModal();
    name.focus();
  };
  ui("nf-cancel").onclick = () => d.close();
  ui("nf-close").onclick = () => d.close();
  $("mkdir").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      await core.mkdir(name.value.trim() || t("files.defaultFolder"), currentFolder());
      name.value = "";
      d.close();
      await render();
    });
  name.onkeydown = (e) => {
    if (e.key === "Enter") $("mkdir").click();
  };
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Mac/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : t("browser.generic");
  return os ? t("device.on", { browser: br, os }) : br;
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(t("copy.fail"), "err");
  }
}

function qr(el: HTMLElement, text: string) {
  el.innerHTML = renderSVG(text, { border: 2, ecc: "L" });
  el.querySelector("svg")?.setAttribute("role", "img");
  el.querySelector("svg")?.setAttribute("aria-label", t("qr.label"));
}

// ── rescue kit ─────────────────────────────────────────────────────
let kitOpening = false;
let kitConfirmed = false;
async function openKit(forced: boolean) {
  const d = $<HTMLDialogElement>("kit-dialog");
  // Renders come in bursts (upload progress, websocket): open the forced kit once.
  if (d.open || kitOpening || (forced && kitConfirmed)) return;
  kitOpening = true;
  let got: { kit: string; accountId: string };
  try {
    got = await core.rescueKit();
    if (forced && (kitConfirmed || (await core.status()).kitSaved)) return;
  } finally {
    kitOpening = false;
  }
  if (d.open) return;
  const { kit, accountId } = got;
  $<HTMLTextAreaElement>("kit-text").value = kit;
  qr($("kit-qr"), kit);
  const ack = $<HTMLInputElement>("kit-ack");
  ack.checked = !forced;
  ack.closest("label")!.hidden = !forced;
  $<HTMLButtonElement>("kit-done").disabled = forced;
  $("kit-done").dataset.i18n = forced ? "kit.doneForced" : "kit.close";
  $<HTMLButtonElement>("kit-done").textContent = t($("kit-done").dataset.i18n!);
  d.dataset.forced = forced ? "1" : "";
  d.dataset.account = accountId;
  d.showModal();
}
function wireKit() {
  const d = $<HTMLDialogElement>("kit-dialog");
  // A forced kit cannot be dismissed with Esc.
  d.addEventListener("cancel", (e) => {
    if (d.dataset.forced) e.preventDefault();
  });
  $<HTMLInputElement>("kit-ack").onchange = (e) => {
    $<HTMLButtonElement>("kit-done").disabled = !(e.target as HTMLInputElement).checked;
  };
  $("kit-copy").onclick = () => void copy($<HTMLTextAreaElement>("kit-text").value, t("kit.copied"));
  $("kit-download").onclick = () => {
    const text = [
      t("kit.file.title"),
      t("kit.file.account", { id: d.dataset.account ?? "" }),
      t("kit.file.server", { url: serverUrl }),
      t("kit.file.created", { date: fmtDateTime(Date.now()) }),
      "",
      t("kit.file.code"),
      $<HTMLTextAreaElement>("kit-text").value,
      "",
      t("kit.file.how"),
      "",
    ].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = t("kit.file.name");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };
  $("kit-print").onclick = () => window.print();
  $("kit-done").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const forced = !!d.dataset.forced;
      if (forced) {
        kitConfirmed = true;
        await core.confirmKitSaved();
      }
      d.close();
      // First run done: straight to the files.
      if (forced && route.name === "welcome") navigate("/", true);
      else await render();
    });
  $("kit-show").onclick = (e) => void act(e.currentTarget as HTMLElement, () => openKit(false));
  ui("wiz-kit").onclick = (e) => void act(e.currentTarget as HTMLElement, () => openKit(true));
  ui("wiz-skip").onclick = () => {
    sessionStorage.setItem(SKIP_KEY, "1");
  };
}

// ── channels ───────────────────────────────────────────────────────
function wireHooks() {
  const input = $<HTMLInputElement>("webhook-url");
  $("add-webhook").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      if (!input.value.trim()) throw new Error(t("hooks.pasteFirst"));
      await core.addWebhook(input.value);
      input.value = "";
      await render();
      toast(t("hooks.added"));
    });
  // Block body on purpose: an on* handler that returns false cancels the key, so an
  // `e.key === "Enter" && ...` arrow blocked typing and Ctrl+V in this field.
  input.onkeydown = (e) => {
    if (e.key === "Enter") $("add-webhook").click();
  };
}

// ── devices: pairing a new device from this one ────────────────────
function wireDevices() {
  const code = $<HTMLInputElement>("pair-code");
  $("pair").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const r = await core.pairAccept(code.value);
      $("pair-sas").textContent = r.sas;
      ui("sas-box").hidden = false;
      ui("sas-box").scrollIntoView({ block: "nearest" });
      code.value = "";
      devicesLoaded = false;
      await render();
    });
  code.onkeydown = (e) => {
    if (e.key === "Enter") $("pair").click();
  };
}

// ── signed out: create account, join this device (QR + 6 digits), restore from a kit ──
function wireSignedOut(server: () => string) {
  $("create").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      await core.createAccount(server(), $<HTMLInputElement>("device-name").value.trim() || defaultDeviceName(), $<HTMLInputElement>("invite").value);
      await core.open();
      sessionStorage.removeItem(SKIP_KEY);
      navigate("/welcome");
    });

  let polling: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (polling) clearInterval(polling);
    polling = null;
  };
  const reset = () => {
    stop();
    ui("join-offer").hidden = true;
    ui("join-sas-box").hidden = true;
    ui("join-actions").hidden = false;
    ui("join-name-field").hidden = false;
    $<HTMLInputElement>("join-name").value ||= defaultDeviceName();
  };
  resetJoin = () => {
    void core.pairCancel();
    reset();
  };
  $("join-cancel").addEventListener("click", () => {
    stop();
    void core.pairCancel();
  });
  $("join-start").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const r = await core.pairStart(server(), $<HTMLInputElement>("join-name").value.trim() || defaultDeviceName());
      $<HTMLTextAreaElement>("join-offer").value = r.offer;
      qr($("join-qr"), r.link);
      ui("join-offer").hidden = false;
      ui("join-name-field").hidden = true;
      ui("join-actions").hidden = true;
      const t0 = Date.now();
      polling = setInterval(async () => {
        if (Date.now() - t0 > 10 * 60_000) {
          stop();
          toast(t("joinD.expired"), "err");
          reset();
          return;
        }
        try {
          const got = await core.pairPoll();
          if (!got) return;
          stop();
          $("join-sas").textContent = got.sas;
          ui("join-offer").hidden = true;
          ui("join-sas-box").hidden = false;
        } catch (err) {
          stop();
          toast(errText(err), "err");
          reset();
        }
      }, 2000);
    });
  $("join-confirm").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      await core.pairConfirm();
      await core.open();
      navigate("/", true);
      toast(t("dev.paired"));
    });
  $("join-reject").onclick = () => {
    void core.pairCancel();
    reset();
    toast(t("joinD.rejected"), "err");
  };
  $("rescue-go").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      await core.joinWithKit(server(), $<HTMLTextAreaElement>("rescue-text").value, $<HTMLInputElement>("rescue-name").value.trim() || defaultDeviceName());
      $<HTMLTextAreaElement>("rescue-text").value = "";
      await core.open();
      navigate("/", true);
      toast(t("rescueD.done"));
    });
  $<HTMLInputElement>("rescue-name").value ||= defaultDeviceName();
  if (route.name === "join") reset();
}

// ── share link recipient /s/<id>#<key> (SharedFile) ────────────────
async function openShareView(): Promise<boolean> {
  const m = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname);
  if (!m) return false;
  shareMode = true;
  showOnly("share");
  document.title = `${t("shareV.h")} · ${t("app.title")}`;
  document.body.dataset.ready = "1";
  const state = $("share-state");
  const key = location.hash.slice(1);
  if (!key) {
    state.textContent = t("shareV.noKey");
    return true;
  }
  try {
    const meta = await core.shareOpen(location.origin, m[1]!, key);
    $("share-file-name").textContent = meta.name;
    $("share-file-size").textContent = fmt(meta.size);
    $<HTMLButtonElement>("share-get").disabled = false;
    state.textContent = "";
  } catch (e) {
    state.textContent = /not found|revoked/.test(String(e)) ? t("shareV.dead") : /wrong key/.test(String(e)) ? t("shareV.badKey") : errText(e);
    return true;
  }
  onShareProgress = (done, total) => {
    ui("share-bar").style.width = `${total ? (done / total) * 100 : 100}%`;
    state.textContent = t("shareV.progress", { done: fmt(done), total: fmt(total) });
  };
  $("share-get").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const b = await core.shareDownload();
      ui("share-bar").className = "done";
      state.textContent = t("shareV.done");
      document.body.dataset.shareDone = "1";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = $("share-file-name").textContent || t("sh.file");
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
  return true;
}

// ── light / dark / system (cobalt/theme.js, like discordrive's ColorModeToggle) ──
type ThemeMode = "light" | "dark" | "system";
const ddnTheme = () => (window as unknown as { ddnTheme?: { get(): ThemeMode; set(m: ThemeMode): void } }).ddnTheme;
const MODES: [ThemeMode, string][] = [
  ["light", "sun"],
  ["dark", "moon"],
  ["system", "monitor"],
];
function paintModes() {
  const th = ddnTheme();
  if (!th) return;
  const cur = th.get();
  for (const box of all<HTMLElement>("[data-ddn-ui=modes]")) {
    if (!box.childElementCount) {
      box.setAttribute("role", "radiogroup");
      box.append(...MODES.map(([m, ic]) => h("button", { type: "button", role: "radio", "data-mode": m }, icon(ic))));
    }
    box.setAttribute("aria-label", t("theme.label"));
    box.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((b) => {
      const label = t(`theme.${b.dataset.mode}`);
      b.setAttribute("aria-label", label);
      b.title = label;
      b.setAttribute("aria-checked", String(b.dataset.mode === cur));
    });
  }
  const choice = ui("mode-choice");
  if (!choice.childElementCount) choice.append(...MODES.map(([m]) => h("button", { type: "button", role: "radio", "data-mode": m })));
  choice.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((b) => {
    b.textContent = t(`theme.${b.dataset.mode}`);
    b.setAttribute("aria-checked", String(b.dataset.mode === cur));
  });
}
function wireTheme() {
  document.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-ddn-ui=modes] button[data-mode], [data-ddn-ui=mode-choice] button[data-mode]");
    if (b) ddnTheme()?.set(b.dataset.mode as ThemeMode);
  });
  document.addEventListener("ddn-theme", paintModes);
  paintModes();
}

// ── language switch (no reload: static texts re-applied, dynamic parts re-rendered) ──
function markLang() {
  all<HTMLButtonElement>("[data-ddn=lang] [data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === getLang())));
}
function wireLang() {
  markLang();
  all<HTMLButtonElement>("[data-ddn=lang] [data-lang]").forEach((b) => {
    b.onclick = () => {
      const l = b.dataset.lang as Lang;
      if (l === getLang()) return;
      setLang(l);
      storeLang(l);
      applyStatic();
      markLang();
      paintModes();
      document.body.dataset.lang = l;
      if (shareMode) return;
      devicesLoaded = false;
      void render();
    };
  });
  document.body.dataset.lang = getLang();
}

async function main() {
  document.body.dataset.mode = __DDN_MODE__;
  wireLang();
  wireTheme();
  wireLinks();
  wireDrawer();
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("./sw.js").catch(() => {});
  await core.init({ discordApiOrigin: cfg.discordApiOrigin, wasmUrl: new URL("./sqlite3.wasm", document.baseURI).href /* <base href="/">: right on /folder/<id> too */ });
  if (await openShareView()) return;
  $<HTMLInputElement>("server").value = serverUrl;
  // Same-origin instance: the server field is noise; keep it only for a dev setup with a separate API.
  ui("server-field").hidden = serverUrl === location.origin;
  ui("local-note").hidden = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const server = () => $<HTMLInputElement>("server").value.trim().replace(/\/$/, "");
  const info = await core.instance(serverUrl).catch(() => null);
  sharesOn = !!info?.shares;
  ui("invite-field").hidden = info?.signup !== "invite";
  if (info?.signup === "closed") {
    $<HTMLButtonElement>("create").disabled = true;
    $("create").title = t("create.closed");
  }
  const pre = new URLSearchParams(location.search).get("invite");
  if (pre) $<HTMLInputElement>("invite").value = pre;
  features = await core.features();
  wireSearch();
  wireSignedOut(server);
  wireKit();
  wireHooks();
  wireFilesPage();
  wireDevices();
  $("share-copy").onclick = () => void copy($<HTMLTextAreaElement>("share-link").value, t("shareD.copied"));
  $("share-close").onclick = () => $<HTMLDialogElement>("share-dialog").close();
  $<HTMLDialogElement>("share-dialog").addEventListener("close", () => {
    if (route.name === "settings") void renderShares();
  });
  ui("player-close").onclick = () => closePlayer();
  ui<HTMLDialogElement>("player-dialog").addEventListener("close", () => $<HTMLVideoElement>("player").pause());
  if ((await core.status()).hasAccount) await act(null, () => core.open());
  // Link from a QR code scanned by a phone camera: …/#pair=ddn-pair1:…
  const hashPair = location.hash.startsWith("#pair=") ? decodeURIComponent(location.hash.slice(6)) : null;
  if (hashPair) {
    if ((await core.status()).signedIn) {
      history.replaceState(null, "", "/devices");
      route = parseRoute();
      $<HTMLInputElement>("pair-code").value = hashPair;
      toast(t("dev.pairLoaded"), "info");
    } else {
      history.replaceState(null, "", "/");
      toast(t("dev.pairWrongDevice"), "err");
    }
  }
  booted = true;
  await onRoute();
  let seen = -1;
  setInterval(async () => {
    const v = (await core.status()).version;
    if (v !== seen) {
      seen = v;
      void render();
    }
  }, 1000);
  document.body.dataset.ready = "1";
}

void main();
