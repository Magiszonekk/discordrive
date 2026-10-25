// UI layer of the metadata-only browser client. Look: Cobalt (the theme of discordrive, cobalt/README.md);
// layout: discordrive's app-shell (sidebar Files / Devices / Settings, AuthCard screens before sign-in).
// Routing: History API (/, /folder/<id>, /devices, /settings/<tab>, /welcome; signed out: /, /join, /restore;
// share links /s/<id>#<key>); the instance serves index.html for every path without an extension, so a
// reload keeps the page. Texts: i18n.ts (en default, pl); static HTML via data-i18n hooks.
// Every element the tests drive keeps its stable data-ddn attribute; purely visual hooks use data-ddn-ui.
// All logic lives in app-core (worker) behind `core`.
//
// on* handlers: always a block body or `void …`. An on* handler that RETURNS false cancels the event
// (an `e.key === "Enter" && …` arrow blocked typing in the webhook field); check.ts greps for it.
import { uploadResumeKey } from "./resume-idb.js";
import { renderSVG } from "uqr";
import type { CoreEvent, OpOutcome, TrashRow, UiNotice } from "./app-core.js";
import type { SpeedTestProgress, SpeedTestResult } from "@ddv4/metadata-client";
import { applyStatic, fmtDate, fmtDateTime, fmtNum, fmtSize, getLang, isLang, setLang, storeLang, storedLang, t, tn, type Lang } from "./i18n.js";
import { connect } from "./rpc.js";
import { createPreview, type PreviewRow } from "./preview.js";
import { createChannelsUi, storedShowUnavailable } from "./channels-ui.js";
import { createAdminUi } from "./admin-ui.js";
import { SpeedMeter, fmtDuration } from "./speed.js";
import { makePreviews, previewSource } from "./thumbs.js";
import type { UploadStages } from "@ddv4/metadata-client";

/** Mode this bundle was built for (build.ts define). */
declare const __DDN_MODE__: string;
/** Server-side features of this mode (plain: thumbnails, search, streaming). */
let features = { thumbnails: false, search: false, streaming: false };
/** plain: current server search ("" = none). */
let searchQ = "";

const cfg =
  (window as unknown as { DDN_CONFIG?: { discordApiOrigin?: string; serverUrl?: string; language?: string; streamMinBytes?: number; desktop?: { local: boolean; invite: string | null } } }).DDN_CONFIG ?? {};
// Language before the first paint: this browser's choice, else the instance default, else English.
setLang(storedLang() ?? (isLang(cfg.language) ? cfg.language : "en"));
applyStatic();
/** Same-origin instance (served by `discordrive serve`): the API is this origin. */
const serverUrl = cfg.serverUrl ?? location.origin;
/**
 * Desktop app (apps/desktop): its preload exposes `ddnDesktop`, and the core runs in the background agent,
 * reached through a MessagePort; in a browser the core runs in a dedicated worker. Same core, same calls.
 */
interface DesktopBridge {
  platform: string;
  version: number;
  /** Paths of files dropped on the window (a renderer cannot read File.path any more). */
  pathsOf(files: File[]): string[];
  /** Open the system file manager at a file. */
  showInFolder(path: string): void;
  /** Ask for a folder (downloads). */
  pickFolder(): Promise<string | null>;
  /** The built-in instance got its first account (it closes sign-up). */
  firstAccountMade(): Promise<boolean>;
  keystoreRetry?(): Promise<boolean>;
  /** Open a file the app downloaded in the system's default app (older app builds lack it). */
  openFile?(path: string): void;
  /** Copy a text to the system clipboard (the window has no clipboard permission). Older app builds lack it. */
  copyText?(text: string): Promise<boolean>;
  /** The window's back / forward commands (the mouse's side buttons on Windows). */
  onNavigate?(cb: (dir: "back" | "forward") => void): void;
  updates: {
    check(): Promise<{ current: { version: string; build: string; commit: string | null }; available: { build: string; commit: string; publishedAt: string; htmlUrl: string } | null; kind: string }>;
    download(): Promise<{ path: string; hint: string; busy: boolean; inPlace?: boolean; command?: string }>;
    settings(patch?: { checkUpdates?: boolean; autostart?: boolean; downloadsDir?: string; keyring?: "ask" | "file"; vdisk?: boolean; vdiskCacheGb?: number; vdiskWrite?: boolean }): Promise<{
      checkUpdates: boolean;
      autostart: boolean;
      downloadsDir: string;
      keyring?: "ask" | "file";
      platform?: string;
      vdisk?: { on: boolean; write?: boolean; queue?: { left: number; done: number; total: number }; cacheGb: number; mountpoint: string; unavailable: string | null; state: string };
    }>;
    open(path: string): void;
    onProgress?(cb: (p: { done: number; total: number }) => void): void;
    /** Install the downloaded update in place and restart (older app builds do not have it). */
    install?(): Promise<boolean>;
  };
}
const desktop = (window as unknown as { ddnDesktop?: DesktopBridge }).ddnDesktop ?? null;
/** Copy a text: in the desktop app through the app (the window has no clipboard permission), else the web API. */
async function writeClipboard(text: string): Promise<void> {
  if (desktop?.copyText) {
    await desktop.copyText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
/** The agent's port arrives from the preload by a window message; calls made before it are queued. */
function agentEndpoint() {
  let port: MessagePort | null = null;
  const queue: unknown[] = [];
  const ep = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage(m: unknown) {
      if (port) port.postMessage(m);
      else queue.push(m);
    },
  };
  addEventListener("message", (e) => {
    if (e.source !== window || !(e.data as { ddnAgentPort?: boolean })?.ddnAgentPort || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = (ev) => ep.onmessage?.(ev);
    for (const m of queue.splice(0)) port.postMessage(m);
  });
  return ep;
}
const worker = desktop ? agentEndpoint() : new Worker("./w/worker.js", { type: "module" });
const progressHandlers = new Map<string, (done: number, total: number, stages?: UploadStages) => void>();
let onShareProgress: (done: number, total: number) => void = () => {};
function onCoreEvent(e: CoreEvent) {
  if (e.type === "upload-progress" || e.type === "download-progress") progressHandlers.get(e.token)?.(e.done, e.total, e.type === "upload-progress" ? e.stages : undefined);
  else if (e.type === "share-progress") onShareProgress(e.done, e.total);
  else if (e.type === "changed") void render();
  else if (e.type === "notices") showNotices(e.notices);
  else if (e.type === "cleanup" && route.name === "settings") void renderStorage();
  else if (e.type === "backfill") paintBackfillState(e.state);
  // Descriptions fetched in the background: an open search shows the new hits.
  else if (e.type === "descriptions" && searchQ) void render();
  else if (e.type === "channel-move") channelsUi.onMoveEvent(e.status);
  else if (e.type === "net") paintNet(e.state);
  else if (e.type === "net-baseline") storeNet({ baseline: e.data });
  else if (e.type === "net-tune") storeNet({ tune: e.data });
  else if (e.type === "auth-lost") void render();
  else if (e.type === "speed-progress") paintSpeedProgress(e.p);
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
/** Speed in MB/s (10^6 B/s, like the transfer report and the line speed of a provider); Mb/s for the tooltip. */
const fmtRate = (bps: number) => `${fmtNum(bps / 1e6, bps < 10e6 ? 1 : 0)} MB/s`;
const fmtRateBits = (bps: number) => `${fmtNum((bps * 8) / 1e6, 0)} Mb/s`;
/** "12.3 MB/s · 0:42 left" while running (… until the first 0.5 s), "avg 11.8 MB/s · 1:05" when done. */
function speedText(m: SpeedMeter, now = Date.now()): { text: string; title: string } {
  if (m.endedAt !== null) {
    const avg = m.average(now);
    return { text: t("speed.done", { rate: fmtRate(avg), time: fmtDuration(m.durationMs(now)) }), title: fmtRateBits(avg) };
  }
  const r = m.rate(now);
  if (r === null) return { text: "", title: "" };
  const eta = m.etaMs(now);
  return { text: eta === null ? fmtRate(r) : t("speed.run", { rate: fmtRate(r), eta: fmtDuration(eta) }), title: fmtRateBits(r) };
}
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
const KNOWN_ERRORS = ["channel_critical", "need_other_channel", "file_unavailable", "main_tab_only", "move_running", "bad_password", "login_taken", "bad_login", "password_too_short", "invalid_name", "invite_required", "signup_closed", "rate_limited", "unauthorized", "body_too_large", "need_channel", "pointer_hook_gone", "instance_busy", "discord_blocked", "webhook_in_use", "too_many_channels", "account_blocked", "not_admin", "last_admin", "self_target"];
/** Readable text for an error: no technical codes in the message (the raw one goes to the console). */
const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  console.warn("ddn:", m);
  if (isOldCryptoError(m)) return `${t("old.h")} ${t("old.t")}`;
  if (/fetch|network/i.test(m)) return t("err.network");
  if (/not a pairing code|bad pairing code/i.test(m)) return t("err.pairCode");
  const code = KNOWN_ERRORS.find((c) => m.includes(c));
  if (code) return t(`err.${code}`);
  if (/webhook/i.test(m)) return t("err.webhook");
  return /^[A-Z]/.test(m) && !/[_{}]/.test(m) ? m : t("err.generic", { msg: m.replace(/^[a-z_]+:\s*/, "") });
};
/** WebCrypto without Ed25519 (Chromium before 137, Firefox before 129, Safari before 17). */
const isOldCryptoError = (m: string) => /Unrecognized name|Algorithm: Unrecognized|Ed25519.*(not supported|unsupported)|NotSupportedError.*Ed25519/i.test(m);
/**
 * Can this browser make the device key (Ed25519 in WebCrypto)? Every way in (create, join, rescue kit,
 * password) makes one; without it the sign-up cards say "this browser is too old" instead of a raw error.
 */
async function ed25519Supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" } as Algorithm, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}
function showOldBrowser() {
  document.body.dataset.oldBrowser = "1";
  const tpl = ui<HTMLTemplateElement>("old-browser-tpl");
  // Not on the "signed out by the server" and "keyring locked" cards: they make no keys.
  for (const card of document.querySelectorAll<HTMLElement>("[data-ddn=signed-out] .auth-card:not([data-auth=lost]):not([data-auth=locked])")) {
    if (card.querySelector("[data-ddn=old-browser]")) continue;
    const note = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    applyStatic(note);
    card.querySelector(".auth-body")?.before(note);
    for (const b of card.querySelectorAll<HTMLButtonElement>(".auth-body button")) b.disabled = true;
  }
}

/** Most toasts on screen at once: older ones leave first, so a burst of operations never covers the page. */
const MAX_TOASTS = 3;
function toast(text: string, kind: "ok" | "err" | "info" = "ok", action?: { label: string; run: () => Promise<unknown> }) {
  const ms = action ? 8000 : kind === "err" ? 7000 : 3500;
  const el = h("div", { class: `toast ${kind}${action ? " has-act" : ""}`, role: kind === "err" ? "alert" : "status", style: `--toast-ms:${ms}ms` }, icon(kind === "err" ? "alert" : kind === "info" ? "info" : "check-circle"), h("span", {}, text));
  if (action) {
    const b = h("button", { class: "toast-act", type: "button", "data-ddn": "toast-undo" }, icon("restore"), action.label);
    b.onclick = () => {
      el.remove();
      void act(null, action.run);
    };
    el.append(b);
  }
  const box = ui("toasts");
  box.append(el);
  const all = box.querySelectorAll(".toast");
  for (let i = 0; i < all.length - MAX_TOASTS; i++) all[i]!.remove();
  setTimeout(() => el.remove(), ms);
}

/** Rule notices (sync-core) as toasts; silent ones never reach the UI (app-core drops them). */
function noticeText(n: UiNotice): string | null {
  const name = n.name ?? t("notice.item");
  const other = n.other ?? "";
  switch (n.code) {
    case "name_suffixed":
      return t("notice.suffixed", { name, wanted: other });
    case "move_target_in_trash":
    case "move_target_purged":
      return t("notice.moveTrash", { name });
    case "move_cycle":
      return t("notice.moveCycle", { name });
    case "rename_overrode_unseen":
      return t("notice.renameOver", { name, other });
    case "unseen_trashed_with_folder":
      return t("notice.trashedWithFolder", { name, folder: other || t("notice.item") });
    case "purge_kept_unseen":
      return tn("notice.keptUnseen", n.count);
    case "purge_not_in_trash":
      return t("notice.notInTrash", { name });
    case "moved_to_recovered":
      return t("notice.recovered", { name });
    case "node_purged":
      return t("notice.purged", { name });
    case "restored_by_new_content":
      return t("notice.restoredByContent", { name });
    case "content_conflict":
      return t("notice.conflict", { name });
    case "group_rolled_back":
    case "invalid_op":
      return t("notice.invalid");
    default:
      return null;
  }
}
function showNotices(ns: UiNotice[]) {
  const seen = new Set<string>();
  for (const n of ns) {
    const text = noticeText(n);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    toast(text, n.code === "name_suffixed" || n.code === "moved_to_recovered" ? "info" : "err");
  }
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
  | { name: "trash" }
  | { name: "devices" }
  | { name: "settings"; tab: SettingsTab | null }
  | { name: "admin" }
  | { name: "welcome" }
  | { name: "create" }
  | { name: "join" }
  | { name: "restore" }
  | { name: "signin" };
const SIGNED_OUT_ROUTES = new Set(["create", "join", "restore", "signin"]);
/** Settings tabs, each an address (/settings/<tab>); the sections carry data-tab. */
const SETTINGS_TABS = ["channels", "account", "storage", "network", "appearance", "app"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const isSettingsTab = (x: string): x is SettingsTab => (SETTINGS_TABS as readonly string[]).includes(x);
/** The old one-page anchors (/settings#network, …) and the section ids, mapped to their tab. */
const SECTION_TAB: Record<string, SettingsTab> = {
  channels: "channels", account: "account", rescue: "account", security: "account", sharing: "account",
  storage: "storage", network: "network", appearance: "appearance", diagnostics: "app", "desktop-app": "app", browser: "app",
};
const SETTINGS_TAB_KEY = "ddn.settings.tab";
function parseRoute(path = location.pathname): Route {
  const p = path.replace(/\/+$/, "") || "/";
  const f = /^\/folder\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (f) return { name: "files", folder: f[1]! };
  if (p === "/trash") return { name: "trash" };
  if (p === "/devices") return { name: "devices" };
  if (p === "/settings") return { name: "settings", tab: null };
  const st = /^\/settings\/([a-z-]{1,24})$/.exec(p);
  if (st) return { name: "settings", tab: isSettingsTab(st[1]!) ? st[1]! : null };
  if (p === "/admin") return { name: "admin" };
  if (p === "/welcome") return { name: "welcome" };
  if (p === "/join") return { name: "join" };
  if (p === "/restore") return { name: "restore" };
  if (p === "/signin") return { name: "signin" };
  return { name: "files", folder: "root" };
}
const hrefOf = (r: Route) =>
  r.name === "files" ? (r.folder === "root" ? "/" : `/folder/${r.folder}`) : r.name === "create" ? "/" : r.name === "settings" && r.tab ? `/settings/${r.tab}` : `/${r.name}`;
let route: Route = parseRoute();
let routeSeq = 0;
/** Go to a page (pushState). `replace` for redirects, so Back does not bounce. */
function navigate(href: string, replace = false) {
  const u = settingsAnchorToTab(new URL(href, location.origin));
  if (u.pathname + u.hash !== location.pathname + location.hash) history[replace ? "replaceState" : "pushState"](null, "", u.pathname + u.search + u.hash);
  void onRoute();
}
/** /settings#network (the one-page anchors) → /settings/network: links and bookmarks from before the tabs. */
function settingsAnchorToTab(u: URL): URL {
  const key = decodeURIComponent(u.hash.slice(1));
  if (u.pathname.replace(/\/+$/, "") === "/settings" && SECTION_TAB[key]) {
    u.pathname = `/settings/${SECTION_TAB[key]}`;
    if (SECTION_TAB[key] === key) u.hash = "";
  }
  return u;
}
async function onRoute() {
  {
    const u = settingsAnchorToTab(new URL(location.href));
    if (u.href !== location.href) history.replaceState(null, "", u.pathname + u.search + u.hash);
  }
  const prev = route;
  route = parseRoute();
  const seq = ++routeSeq;
  if (prev.name !== route.name || (prev.name === "files" && route.name === "files" && prev.folder !== route.folder)) {
    cursorStack = [undefined];
    selected.clear();
    if (route.name === "devices") devicesLoaded = false;
    if (route.name === "join") resetJoin?.();
  }
  closeDrawer();
  await render();
  if (seq !== routeSeq) return;
  const anchor = location.hash.length > 1 && !location.hash.startsWith("#pair=") ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (anchor) anchor.scrollIntoView({ block: "start" });
  else if (prev.name !== route.name || (prev.name === "settings" && route.name === "settings" && prev.tab !== route.tab) || (prev.name === "files" && route.name === "files" && prev.folder !== route.folder)) window.scrollTo(0, 0);
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
  // Backspace: one folder up (not while typing, not in a dialog or a menu).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (typingIn(e.target) || document.querySelector("dialog[open]") || !$("row-menu").hidden) return;
    if (route.name !== "files" || searchQ || !upHref) return;
    e.preventDefault();
    goUp();
  });
  // Enter with nothing focused and exactly one folder selected: open it (Enter on a row's checkbox too, in fileRow).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || route.name !== "files") return;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (document.querySelector("dialog[open]") || !$("row-menu").hidden || selected.size !== 1) return;
    const [[id, s]] = [...selected];
    if (s.kind !== "folder") return;
    e.preventDefault();
    openFolder(id);
  });
  if (!desktop) return; // a browser goes back / forward by itself (Alt+arrows, the mouse's side buttons)
  // Desktop app: Electron has no built-in history keys or mouse buttons. Alt+←/→ and the mouse's side
  // buttons (Linux, macOS: mouseup button 3/4 here; Windows: the window's app-command, sent by the main
  // process) walk the history. The two paths can both fire for one press on Windows: one step per 400 ms.
  let lastNav = 0;
  const walk = (dir: "back" | "forward") => {
    if (Date.now() - lastNav < 400) return;
    lastNav = Date.now();
    if (dir === "back") history.back();
    else history.forward();
  };
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight") || typingIn(e.target)) return;
    e.preventDefault();
    walk(e.key === "ArrowLeft" ? "back" : "forward");
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    walk(e.button === 3 ? "back" : "forward");
  });
  desktop.onNavigate?.((dir) => walk(dir));
}
/** A text field, editable area or select has the focus (keys belong to it). */
function typingIn(t: EventTarget | null) {
  const el = t instanceof Element ? t : null;
  if (!el) return false;
  if (el.closest("textarea, select, [contenteditable]:not([contenteditable=false])")) return true;
  const i = el.closest("input");
  return !!i && !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(i.type);
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
// View (List / Tiles) and sort of the file list, remembered per device.
type View = "list" | "tiles";
type SortBy = "name" | "size" | "date";
const VIEW_KEY = "ddn.view";
const SORT_KEY = "ddn.sort";
let view: View = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === "tiles" ? "tiles" : "list";
  } catch {
    return "list";
  }
})();
let sort: { by: SortBy; desc: boolean } = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as { by?: unknown; desc?: unknown } | null;
    if (s && (s.by === "name" || s.by === "size" || s.by === "date")) return { by: s.by, desc: s.desc === true };
  } catch {
    /* default */
  }
  return { by: "name", desc: false };
})();
function paintView() {
  for (const w of all<HTMLElement>(".ftable-wrap")) w.dataset.view = view;
  for (const b of all<HTMLButtonElement>("[data-ddn=view] [data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
}
function setView(v: View) {
  view = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private mode: this tab only */
  }
  paintView();
}
function paintSort() {
  for (const b of all<HTMLButtonElement>("[data-ddn=sort]")) {
    const on = b.dataset.sort === sort.by;
    b.closest("th")!.setAttribute("aria-sort", on ? (sort.desc ? "descending" : "ascending") : "none");
    b.dataset.dir = on ? (sort.desc ? "desc" : "asc") : "";
  }
}
function setSort(by: SortBy, desc: boolean) {
  sort = { by, desc };
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    /* this tab only */
  }
  cursorStack = [undefined]; // keyset cursors belong to one order
  shownList = "";
  paintSort();
  void render();
}
/** Selected rows of the current folder (cleared on navigation): id -> what the bulk actions need. */
const selected = new Map<string, { name: string; kind: "file" | "folder" }>();
/** The open folder lives under „Recovered” (rule 4): set by render from the path. */
let underRecovered = false;
const inRecovered = () => underRecovered;
const DRAG_TYPE = "application/x-ddn-nodes";
const openFolder = (id: string) => navigate(id === "root" ? "/" : `/folder/${id}`);

/** Where "Up" (button, Backspace) goes from the open folder: its parent's address, or null at the top. */
let upHref: string | null = null;
/** One level up (the Up button and Backspace): a normal navigation, so Back returns here. */
function goUp() {
  if (route.name === "files" && upHref) navigate(upHref);
}
/** Breadcrumb links are drop targets too (drag rows onto a parent folder). */
function crumbLink(id: string, label: string) {
  const a = h("a", { href: id === "root" ? "/" : `/folder/${id}`, "data-link": "", title: label, "data-drop": id }, label);
  return a;
}

function renderCrumbs(fullPath: { id: string; name: string }[]) {
  const nav = ui("crumbs");
  const kids: (Node | string)[] = [];
  // Under „Recovered” (rule 4) the path starts at that system folder instead of Files.
  const rec = fullPath[0]?.id === "recovered";
  const rootId = rec ? "recovered" : "root";
  const rootLabel = rec ? t("nav.recovered") : t("files.root");
  const path = rec ? fullPath.slice(1) : fullPath;
  // Mobile: back arrow to the parent (FolderBreadcrumb); desktop: the full path.
  const back = h("span", { class: "back" });
  if (path.length) {
    const parent = path.at(-2);
    const a = h("a", { href: parent ? `/folder/${parent.id}` : rec ? "/folder/recovered" : "/", "data-link": "" }, icon("left"), parent ? parent.name : rootLabel);
    back.append(a);
  } else back.append(h("span", { "aria-current": "page" }, rootLabel));
  kids.push(back);
  // Up: the parent folder (also a drop target: move the dragged rows there). Not shown at the top.
  const parentId = path.length ? (path.at(-2)?.id ?? rootId) : null;
  const parentLabel = path.length ? (path.at(-2)?.name ?? rootLabel) : "";
  upHref = parentId ? (parentId === "root" ? "/" : `/folder/${parentId}`) : null;
  const up = h("button", { class: "iconbtn up", type: "button", "data-ddn": "up", "aria-label": t("files.up"), title: t("files.up") }, icon("up"));
  up.onclick = () => goUp();
  if (parentId) {
    up.dataset.drop = parentId;
    up.dataset.dropName = parentLabel;
  } else up.hidden = true;
  kids.push(up);
  const desk = h("span", { class: "desk crumbs" });
  desk.append(path.length ? crumbLink(rootId, rootLabel) : h("span", { "aria-current": "page" }, rootLabel));
  path.forEach((p, i) => {
    desk.append(icon("right"));
    desk.append(i === path.length - 1 ? h("span", { "aria-current": "page", title: p.name }, p.name) : crumbLink(p.id, p.name));
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
      ? chip(t("status.uploading", { done: uploading.done, total: uploading.total }), "accent", t(desktop ? "status.uploadingDesktop.t" : "status.uploading.t"))
      : chip(t("status.synced"), "success", t("status.synced.t", { seq: fmtNum(st.headSeq) })),
  );
  const me = ui("me-name");
  me.textContent = st.deviceName || short(st.deviceId);
  me.title = st.deviceId ?? "";
}

/** Folder + page of the list shown last: the row stagger (.reveal) plays only when that changes, like
 * discordrive's one-shot load (render() also runs after every upload and sync, and the rows must not fade again). */
let shownList = "";
/**
 * Where the focus is inside a list (row ID + the element's data-ddn), so it can be put back after the rows
 * were rebuilt (every render replaces them: sync, upload, rename) or the menu's origin was replaced.
 */
function focusKey(el: Element | null): { row: string; ddn: string } | null {
  const row = el?.closest<HTMLElement>("[data-ddn=row], [data-ddn=trash-row]");
  const ddn = el?.getAttribute("data-ddn");
  return row?.dataset.id && ddn ? { row: row.dataset.id, ddn } : null;
}
function refocus(k: { row: string; ddn: string } | null) {
  if (!k) return;
  const row = document.querySelector(`[data-ddn=row][data-id="${CSS.escape(k.row)}"], [data-ddn=trash-row][data-id="${CSS.escape(k.row)}"]`);
  row?.querySelector<HTMLElement>(`[data-ddn="${CSS.escape(k.ddn)}"]`)?.focus({ preventScroll: true });
}
/** Row element -> its data (the context menu of a row). */
const rowData = new WeakMap<HTMLElement, { id: string; name: string; kind: "file" | "folder"; size: number | null; unavailable?: string[] }>();
const trashData = new WeakMap<HTMLElement, TrashRow>();
/** Removed channels by webhook ID (label + channel), for the "unavailable" explanation in the file list. */
const removedLabels = new Map<string, string>();
const channelName = (id: string) => removedLabels.get(id) ?? `#…${id.slice(-6)}`;

function fileRow(r: { id: string; name: string; kind: "file" | "folder"; size: number | null; modifiedAt?: number | null; unavailable?: string[] }, i: number, enter = false) {
  const tr = enter ? h("tr", { class: "reveal", style: `--i:${Math.min(i, 12)}` }) : h("tr");
  tr.dataset.ddn = "row";
  tr.dataset.id = r.id;
  tr.dataset.kind = r.kind;
  rowData.set(tr, r);
  if (r.unavailable?.length) {
    tr.classList.add("unavail");
    tr.dataset.unavailable = r.unavailable.join(",");
  }
  const box = h("input", { type: "checkbox", "data-ddn": "select", "aria-label": t("bulk.one", { name: r.name }) }) as HTMLInputElement;
  box.checked = selected.has(r.id);
  box.onchange = () => {
    if (box.checked) selected.set(r.id, { name: r.name, kind: r.kind });
    else selected.delete(r.id);
    tr.classList.toggle("sel", box.checked);
    paintBulk();
  };
  tr.classList.toggle("sel", box.checked);
  const sel = h("td", { class: "c-sel" }, box);
  if (!searchQ && FINE_POINTER) {
    // Drag a row onto a folder row or a breadcrumb link to move it (with the rest of the selection).
    // Not on touch: there a long press opens the menu (Chrome on Android would start a drag instead).
    tr.draggable = true;
    tr.ondragstart = (e) => {
      const ids = selected.has(r.id) ? [...selected.keys()] : [r.id];
      e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(ids));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    };
    if (r.kind === "folder") tr.dataset.drop = r.id;
  }
  const name = h("td", { class: "c-name" });
  const acts = h("span", { class: "acts" });
  const iconBtn = (ic: string, label: string, title: string, tone = "") => h("button", { class: `iconbtn${tone ? ` ${tone}` : ""}`, type: "button", "aria-label": label, title }, icon(ic));
  // Move to trash right next to Download: no question (the trash can be
  // undone), the toast offers Undo. Phone list cards keep it in the menu (CSS), there is no room.
  const trashBtn = () => {
    const b = iconBtn("trash", t("act.trash.aria", { name: r.name }), t("act.trash"), "danger quiet row-trash");
    b.dataset.ddn = "row-trash";
    b.onclick = () => void act(b, () => trashItems([r]));
    return b;
  };
  if (r.kind === "folder") {
    name.append(h("span", { class: "nm" }, icon("folder"), h("a", { href: `/folder/${r.id}`, "data-link": "", title: r.name }, r.name)), h("span", { class: "sub" }, t("files.folder")));
    const go = iconBtn("right", t("files.open", { name: r.name }), t("files.open", { name: r.name }));
    go.onclick = () => openFolder(r.id);
    acts.append(go, trashBtn());
    // A click anywhere on a folder row (not on its buttons / checkbox / name link) opens it, like the
    // preview of a file row; Enter on the row or on its checkbox too (the name link handles its own Enter).
    tr.classList.add("open-row");
    tr.onclick = (e) => {
      if (!(e.target as Element | null)?.closest("button, input, a, label, .c-sel")) openFolder(r.id);
    };
    tr.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.target !== tr && e.target !== box) return;
      e.preventDefault();
      openFolder(r.id);
    });
  } else {
    const [, label, tone] = typeOf(r.name);
    const badge = h("span", { class: `badge ${tone}` }, label);
    if (tone === "media" && !r.unavailable?.length) showThumb(badge, r.id, r.modifiedAt ?? 0);
    const open = h("span", { title: r.name, role: "button", tabindex: "0", "data-ddn": "preview-open", "aria-label": t("pv.open.aria", { name: r.name }) }, r.name);
    open.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        previewFile(r);
      }
    };
    name.append(h("span", { class: "nm" }, badge, open), h("span", { class: "sub" }, [fmt(r.size), r.modifiedAt ? fmtDate(r.modifiedAt) : ""].filter(Boolean).join(" · ")));
    if (r.unavailable?.length) {
      // Shown only with "Show unavailable files" on: why, and what to do (paste the webhook again / delete).
      const why = t("un.why", { ch: r.unavailable.map(channelName).join(", ") });
      name.querySelector(".nm")!.append(chip(t("un.chip"), "warning", why));
      name.querySelector(".nm")!.lastElementChild!.setAttribute("data-ddn", "unavailable-chip");
      name.append(h("span", { class: "unav-why", "data-ddn": "unavailable-why" }, why));
      const del = iconBtn("trash", t("un.delete"), t("un.delete"), "danger");
      del.dataset.ddn = "unavailable-delete";
      del.onclick = () =>
        void act(del, async () => {
          if (!(await confirmDanger(t("un.delete"), why, t("un.delete")))) return;
          await core.trash([r.id]);
          await core.purge([r.id]);
          toast(t("un.deleted"));
          await render();
        });
      acts.append(del);
    }
    // A click anywhere on a file row (not on its buttons / checkbox) opens the preview.
    tr.classList.add("pv-row");
    tr.onclick = (e) => {
      if (!(e.target as Element | null)?.closest("button, input, a, label, .c-sel")) previewFile(r);
    };
    if (VIDEO.test(r.name) && !r.unavailable?.length) {
      const play = iconBtn("play", t("files.play.aria", { name: r.name }), t("files.play"));
      play.dataset.ddn = "play";
      play.onclick = () => void openPlayer(r.id, r.name, r.size ?? 0);
      acts.append(play);
    }
    const dl = iconBtn("download", t("files.download.aria", { name: r.name }), t("files.download"), "accent");
    dl.dataset.ddn = "download";
    if (r.unavailable?.length) dl.hidden = true; // a piece is on a removed channel: the download could not finish
    // Progress, speed and time left in the downloads panel above the list.
    dl.onclick = () => void act(dl, () => download(r.id, r.name));
    acts.append(dl);
    if (!r.unavailable?.length) acts.append(trashBtn()); // unavailable: its own delete button above
    if (sharesOn && !inRecovered() && !r.unavailable?.length) {
      const sh = iconBtn("share", t("files.share.aria", { name: r.name }), t("files.share"));
      sh.dataset.ddn = "share";
      sh.onclick = () => void act(sh, () => shareRow(r));
      acts.append(sh);
    }
  }
  const more = iconBtn("more", t("act.menu", { name: r.name }), t("act.more"));
  more.dataset.ddn = "row-more";
  more.setAttribute("aria-haspopup", "menu");
  more.onclick = (e) => {
    e.stopPropagation();
    openRowMenu(more, r);
  };
  acts.append(more);
  const when = r.kind === "file" && r.modifiedAt ? fmtDate(r.modifiedAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  tr.append(sel, name, h("td", { class: "size" }, r.kind === "folder" ? "" : fmt(r.size)), h("td", { class: "c-date" }, when), h("td", { class: "c-acts" }, acts));
  return tr;
}

async function shareRow(r: { id: string; name: string }) {
  const s = await core.shareFile(r.id, serverUrl);
  ui("share-name").textContent = r.name;
  $<HTMLTextAreaElement>("share-link").value = s.link;
  $<HTMLDialogElement>("share-dialog").showModal();
}
const canShare = (r: { kind: string; unavailable?: string[] }) => r.kind === "file" && sharesOn && !inRecovered() && !r.unavailable?.length;
const FINE_POINTER = matchMedia("(pointer: fine)").matches;

/**
 * Replace a media file's type badge with its thumbnail: the encrypted one stored with the file (every
 * mode), else plain's server thumbnail. Loaded only when the row is near the screen; kept per file for
 * this page (blob URL) and in the browser's cache storage across reloads (thumbs-cache below).
 */
const thumbs = new Map<string, Promise<string | null>>();
const thumbTries = new Map<string, number>();
const thumbSeen = new IntersectionObserver(
  (es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      thumbSeen.unobserve(e.target);
      const id = (e.target as HTMLElement).dataset.thumbFor;
      if (id) void loadThumb(e.target as HTMLElement, id);
    }
  },
  { rootMargin: "400px" },
);
/** `id@version time`: a new version of the file (same node) is another picture. */
function showThumb(badge: HTMLElement, id: string, at: number) {
  badge.dataset.thumbFor = `${id}@${at}`;
  thumbSeen.observe(badge);
}
async function loadThumb(badge: HTMLElement, key: string) {
  const id = key.slice(0, key.lastIndexOf("@"));
  let p = thumbs.get(key);
  if (!p) {
    p = cachedThumb(key).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
    thumbs.set(key, p);
    // plain: the server makes its own in the background after the upload; ask again a few times.
    void p.then((u) => {
      if (u || !features.thumbnails) return;
      const tries = (thumbTries.get(id) ?? 0) + 1;
      thumbTries.set(id, tries);
      if (tries <= 10)
        setTimeout(() => {
          thumbs.delete(key);
          shownList = ""; // no row animation on this refresh
          void render();
        }, 2000 * tries);
    });
  }
  const url = await p;
  if (url && badge.isConnected) badge.replaceWith(Object.assign(h("img", { class: "thumb", alt: "", "data-ddn": "thumb" }), { src: url }));
}
/** Thumbnails kept by the browser (Cache Storage of this origin; the desktop window has its own). */
const THUMB_CACHE = "ddn-thumbs-v1";
async function cachedThumb(idAt: string): Promise<Blob | null> {
  const id = idAt.includes("@") ? idAt.slice(0, idAt.lastIndexOf("@")) : idAt;
  const key = `/__thumb/${encodeURIComponent(myAccount ?? "")}/${encodeURIComponent(idAt)}`;
  // Cache Storage needs a secure origin with a scheme it supports (the desktop's app:// may not have it).
  const c = typeof caches !== "undefined" ? await caches.open(THUMB_CACHE).catch(() => null) : null;
  const hit = await c?.match(key).catch(() => undefined);
  if (hit) return hit.blob();
  const b = await core.preview(id, "t");
  if (b && c) void c.put(key, new Response(b, { headers: { "content-type": b.type } })).catch(() => {});
  return b;
}

/** No data at all within this long: the player says so instead of an endless spinner. */
const PLAYER_STALL_MS = 45_000;
let playerWatch = 0;
async function openPlayer(id: string, name: string, size: number) {
  const d = ui<HTMLDialogElement>("player-dialog");
  const v = $<HTMLVideoElement>("player");
  const msg = $("player-msg");
  ui("player-title").textContent = name;
  msg.hidden = true;
  v.hidden = false;
  const my = ++playerWatch;
  // Why it does not play, in words, with a way out (download; the desktop app opens it in the system player).
  const fail = (why: "codec" | "decode" | "network" | "slow") => {
    if (my !== playerWatch) return;
    v.pause();
    v.hidden = true;
    $("player-why").textContent = t(`player.why.${why}`, { s: Math.round(PLAYER_STALL_MS / 1000) });
    const b = $<HTMLButtonElement>("player-download");
    b.textContent = desktop ? t("player.dlOpen") : t("player.dl");
    b.disabled = false;
    b.onclick = () =>
      void act(b, async () => {
        if (!desktop) return download(id, name);
        b.disabled = true;
        $("player-why").textContent = t("player.opening");
        const r = await core.downloadToDisk(id, undefined, crypto.randomUUID());
        desktop.openFile?.(r.path);
        closePlayer();
      });
    msg.hidden = false;
  };
  v.onerror = () => {
    const c = v.error?.code;
    fail(c === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? (codecLikelyMissing(name) ? "codec" : "decode") : c === MediaError.MEDIA_ERR_DECODE ? "decode" : "network");
  };
  // A stream the player cannot decode can still load its metadata with no picture (e.g. HEVC with audio):
  // no video track after loadedmetadata = no decoder.
  v.onloadedmetadata = () => {
    if (my === playerWatch && v.videoWidth === 0 && /\.(mp4|m4v|mov|mkv|webm)$/i.test(name) && codecLikelyMissing(name)) fail("codec");
  };
  setTimeout(() => {
    if (my === playerWatch && d.open && v.readyState < 1 && !v.error) fail("slow");
  }, PLAYER_STALL_MS);
  // plain: straight from the server (Range on the plaintext); other modes: the service worker decrypts here.
  const direct = features.streaming ? await core.streamUrl(id).catch(() => null) : null;
  v.src = direct ?? `./ddn/file/${encodeURIComponent(id)}?size=${size}`;
  v.dataset.source = direct ? "server" : "sw";
  if (!d.open) d.showModal();
  void v.play().catch(() => {});
}
/** HEVC is the usual case of "the format exists but this platform has no decoder" (phones record it). */
function codecLikelyMissing(name: string): boolean {
  const v = document.createElement("video");
  return /\.(mp4|m4v|mov|mkv)$/i.test(name) && !v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
}
// File preview: logic in preview.ts; ←/→ walk the open folder
// (or the search hits in plain).
let searchRows: PreviewRow[] = [];
const channelsUi = createChannelsUi({
  core,
  mode: __DDN_MODE__,
  h,
  icon,
  chip,
  act,
  toast,
  render: () => render(),
  openKit: (forced) => openKit(forced),
});
const adminUi = createAdminUi({
  core,
  mode: __DDN_MODE__,
  h,
  icon,
  chip,
  act,
  toast,
  confirmDanger: (title, text, yes) => confirmDanger(title, text, yes),
  copy: (text) => writeClipboard(text),
  me: () => myAccount,
});
/** This account, and whether it has the admin flag (asked from the server; the server checks again on every admin call). */
let myAccount: string | null = null;
let isAdmin = false;
const preview = createPreview({
  // The preview asks for the low-resolution picture first: the encrypted one stored with the file, else
  // (plain) the server's thumbnail.
  core: {
    list: (folder, after, limit, sort) => core.list(folder, after, limit, sort),
    readRange: (id, a, b) => core.readRange(id, a, b),
    download: (id) => core.download(id),
    thumbnail: (id) => core.preview(id, "p").then((b) => b ?? core.preview(id, "t")),
    streamUrl: (id) => core.streamUrl(id),
  },
  features: () => ({ ...features, thumbnails: true }),
  download: (id, name) => download(id, name),
  error: (e) => toast(errText(e), "err"),
});
function previewFile(r: PreviewRow) {
  preview.open(r, searchQ ? { rows: searchRows } : { folder: currentFolder(), sort });
}
function closePlayer() {
  playerWatch++;
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
  // Own channels with stats, Critical / Retired chips and the remove dialog (channels-ui.ts).
  const rows = channelsUi.paint(wh, route.name === "welcome");
  ui("hooks").replaceChildren(...pool, ...(rows.length ? rows : pool.length ? [] : [h("li", { class: "empty-row" }, t("hooks.none"))]));
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
  rendering = renderNow()
    .catch(async (e: unknown) => {
      // Blocked or deleted account / revoked device, noticed by a call of this render before the
      // notification socket said so: show the "signed out by the server" screen instead of an error.
      if (await core.authProblem(String((e as Error)?.message ?? e))) again = true;
      else throw e;
    })
    .finally(() => {
    rendering = null;
    if (again) {
      again = false;
      void render();
    }
  });
  return rendering;
}

/** The admin page was painted since it was entered (renders after every sync must not refetch it). */
let adminShown = false;
/** False until main() has opened the account: an early render would see "signed out" and redirect. */
let booted = false;

async function renderNow() {
  if (shareMode || !booted) return;
  const st = await core.status();
  if (st.authLost) {
    // The server refused this device: blocked account, or deleted / this device revoked.
    for (const d of all<HTMLDialogElement>("dialog[open]")) d.close();
    showOnly("signed-out");
    all<HTMLElement>("[data-auth]").forEach((el) => (el.hidden = el.dataset.auth !== "lost"));
    const blocked = st.authLost === "blocked";
    ui("lost-h").textContent = t(blocked ? "lost.blocked.h" : "lost.gone.h");
    $("auth-lost-text").textContent = t(blocked ? "lost.blocked.t" : "lost.gone.t");
    ui("lost-hint").textContent = t(blocked ? "lost.blocked.hint" : "lost.gone.hint");
    $("auth-lost-retry").hidden = !blocked;
    document.title = `${t(blocked ? "lost.blocked.h" : "lost.gone.h")} · ${t("app.title")}`;
    return;
  }
  if (st.keysLocked && route.name !== "restore") {
    showOnly("signed-out");
    all<HTMLElement>("[data-auth]").forEach((el) => (el.hidden = el.dataset.auth !== "locked"));
    $("keys-locked-why").textContent = st.keysLocked;
    document.title = `${t("locked.h")} · ${t("app.title")}`;
    return;
  }
  if (!st.signedIn) {
    showOnly("signed-out");
    if (!SIGNED_OUT_ROUTES.has(route.name) && !(route.name === "files" && route.folder === "root")) return navigate("/", true);
    const screen = route.name === "join" || route.name === "restore" || route.name === "signin" ? route.name : "create";
    all<HTMLElement>("[data-auth]").forEach((el) => (el.hidden = el.dataset.auth !== screen));
    document.title = t("app.title");
    return;
  }
  if (route.name === "join" || route.name === "restore" || route.name === "signin") return navigate("/", true);

  const wh = await core.webhooks(route.name === "settings");
  removedLabels.clear();
  for (const x of wh.removed) removedLabels.set(x.id, `${x.label || "webhook"} (#…${String(x.channelId).slice(-6)})`);
  channelsOk = wh.advice.ok;
  renderHooks(wh);
  // First run: no channel and no saved kit yet -> onboarding (unless skipped in this tab).
  const firstRun = !wh.advice.ok && !st.kitSaved;
  if (route.name === "files" && route.folder === "root" && firstRun && !sessionStorage.getItem(SKIP_KEY)) return navigate("/welcome", true);
  if (route.name === "welcome" && wh.advice.ok && st.kitSaved && !$<HTMLDialogElement>("kit-dialog").open) return navigate("/", true);
  // The rescue kit is forced once, right after the first channel (wherever that was added).
  if (wh.advice.ok && !st.kitSaved && !$<HTMLDialogElement>("kit-dialog").open) void openKit(true);
  // A kit saved in an older format that no longer restores the whole account: asked once per device.
  else if (wh.advice.ok && st.kitSaved && !kitReminded && !$<HTMLDialogElement>("kit-dialog").open) {
    kitReminded = true;
    void core.kitReminder().then((ask) => (ask ? openKit(false, true) : undefined)).catch(() => {});
  }

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
  if (myAccount !== st.accountId) {
    myAccount = st.accountId;
    isAdmin = (await core.accountInfo()).admin;
  }
  $("nav-admin").hidden = !isAdmin;
  if (route.name === "admin" && !isAdmin) return navigate("/", true);
  const page = route.name;
  const navKey = page === "files" && route.name === "files" && route.folder === "recovered" ? "recovered" : page;
  all<HTMLElement>("[data-page]").forEach((el) => (el.hidden = el.dataset.page !== page));
  all<HTMLAnchorElement>("a[data-nav]").forEach((a) => (a.dataset.nav === navKey ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${t(`page.${page}`)} · ${t("app.title")}`;

  ui("nav-recovered").hidden = (await core.recoveredCount()) === 0;
  if (page === "trash") return renderTrash();
  trashShown = false;
  if (page === "admin") {
    if (!adminShown) {
      adminShown = true;
      await adminUi.render().catch((e) => toast(errText(e), "err"));
    }
    return;
  }
  adminShown = false;
  if (page === "devices") {
    if (!devicesLoaded) await renderDevices(st.deviceId);
    return;
  }
  if (page === "settings") {
    if (route.name === "settings" && !route.tab) {
      // /settings: no channel yet → Channels (first run); otherwise the tab opened last on this device.
      const last = (() => {
        try {
          return localStorage.getItem(SETTINGS_TAB_KEY);
        } catch {
          return null;
        }
      })();
      const tab: SettingsTab = !wh.advice.ok && wh.webhooks.length === 0 ? "channels" : last && isSettingsTab(last) ? last : "channels";
      return navigate(`/settings/${tab}${location.hash}`, true);
    }
    const tab = (route as { tab: SettingsTab }).tab;
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, tab);
    } catch {
      /* private mode */
    }
    $("settings-sections").dataset.active = tab;
    all<HTMLElement>("[data-page=settings] [data-tab]").forEach((el) => {
      if (el.matches("a[data-ddn=settings-tab]")) el.dataset.tab === tab ? el.setAttribute("aria-current", "page") : el.removeAttribute("aria-current");
      else el.classList.toggle("tab-off", el.dataset.tab !== tab);
    });
    // A phone shows the tab row scrolled sideways: keep the current tab in view (only the row scrolls).
    document.querySelector<HTMLElement>("[data-ddn=settings-tab][aria-current=page]")?.scrollIntoView({ inline: "nearest", block: "nearest" });
    document.title = `${t(`set.tab.${tab}`)} · ${t("page.settings")} · ${t("app.title")}`;
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
    await Promise.all([renderShares(), renderStorage(), renderSecurity(), renderAi(), renderDiagnostics(), renderDesktopApp(), channelsUi.paintStorage(wh)]);
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
  underRecovered = path[0]?.id === "recovered";
  renderCrumbs(path);
  ui("folder-title").textContent = path.length ? (path.at(-1)!.id === "recovered" ? t("nav.recovered") : path.at(-1)!.name) : t("files.root");
  if (searchQ) return renderSearch();
  const [stats, pg] = await Promise.all([core.folderStats(folder), core.list(folder, cursorStack.at(-1), PAGE, sort)]);
  ui("folder-meta").textContent = [tn("files.meta.folders", stats.folders), tn("files.meta.files", stats.files), stats.bytes > 0 ? fmt(stats.bytes) : ""].filter(Boolean).join(" · ");
  ui("need-channel").hidden = channelsOk;
  ui("upload-btn").setAttribute("aria-disabled", String(!channelsOk));
  $<HTMLInputElement>("file").disabled = !channelsOk;
  const pageIndex = cursorStack.length - 1;
  // Both kinds of tab (main on OPFS, secondary in memory) page with a (name, id) cursor.
  const rows = pg.rows;
  const listKey = `${folder}|${pageIndex}|${cursorStack.at(-1) ?? ""}|${sort.by}${sort.desc ? "-" : "+"}`;
  const enter = listKey !== shownList;
  shownList = listKey;
  // Selection survives re-renders (sync, uploads) but only for rows that still exist here.
  const here = new Set(rows.map((x) => x.id));
  for (const id of [...selected.keys()]) if (!here.has(id)) selected.delete(id);
  const hadFocus = $("list").contains(document.activeElement) ? focusKey(document.activeElement) : null;
  $("list").replaceChildren(...rows.map((row, i) => fileRow(row, i, enter)));
  refocus(hadFocus);
  paintBulk();
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

/** Search results in the file table (one page, up to 500), best first. */
async function renderSearch() {
  const hits = await core.search(searchQ);
  searchRows = hits.map((x: PreviewRow) => ({ id: x.id, name: x.name, kind: x.kind, size: x.size }));
  const ds = await core.descState();
  ui("folder-meta").textContent = [tn("search.results", hits.length, { q: searchQ }), ds.described ? tn("search.described", ds.described) : ""].filter(Boolean).join(" · ");
  $("list").replaceChildren(...hits.map((x, i) => fileRow({ ...x, cursor: "" } as never, i, false)));
  ui("empty").hidden = true;
  ui("search-empty").hidden = hits.length > 0;
  $("count").textContent = tn("files.count", hits.length);
  ui("pager-btns").hidden = true;
}

function wireSearch() {
  // Every mode: names, dates and AI descriptions from the local index (plain adds the server's name search).
  const box = ui<HTMLFormElement>("search");
  box.hidden = false;
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
// The transfer panels (uploads, downloads) close themselves when they are done: 5 s when everything went
// fine, 12 s after a failure or a cancel (time to read it). A bar at the bottom of the panel shrinks to zero
// meanwhile (accent; error / warning colour after a failure / cancel); hover or focus pauses it where it
// is, leaving continues from there, × closes at once, a new transfer cancels it. With reduced motion the
// bar does not move: a text says in how many seconds the panel closes. Files that failed to upload stay
// in the warning bar (Details, Retry).
const CLOSE_OK_MS = 5000;
const CLOSE_PROBLEM_MS = 12000;
type Closer = { start(result: "ok" | "err" | "cancel"): void; stop(): void };
function panelCloser(box: HTMLElement, close: () => void): Closer {
  const bar = h("span", { class: "closebar", "data-ddn": "close-bar", "aria-hidden": "true" });
  const text = h("span", { class: "closein", "data-ddn": "close-in", hidden: "" });
  box.append(bar);
  box.querySelector(".uploads-h .t")?.append(text);
  let anim: Animation | null = null;
  let tick = 0;
  let held = false;
  const paintText = () => {
    if (!anim) return;
    const total = Number(anim.effect?.getTiming().duration ?? 0);
    const left = Math.max(0, total - Number(anim.currentTime ?? 0));
    text.textContent = t("panel.closesIn", { s: Math.max(1, Math.ceil(left / 1000)) });
  };
  const stop = () => {
    anim?.cancel();
    anim = null;
    clearInterval(tick);
    text.hidden = true;
    delete box.dataset.closing;
    delete box.dataset.paused;
    delete box.dataset.result;
  };
  const hold = (on: boolean) => {
    held = on;
    if (!anim) return;
    if (on) {
      anim.pause();
      box.dataset.paused = "1";
    } else {
      anim.play();
      delete box.dataset.paused;
    }
  };
  box.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "touch") hold(true);
  });
  box.addEventListener("pointerleave", () => hold(box.contains(document.activeElement)));
  box.addEventListener("focusin", () => hold(true));
  box.addEventListener("focusout", (e) => hold(box.contains(e.relatedTarget as Node | null) || box.matches(":hover")));
  return {
    stop,
    start(result) {
      stop();
      const ms = result === "ok" ? CLOSE_OK_MS : CLOSE_PROBLEM_MS;
      box.dataset.result = result;
      box.dataset.closing = "1";
      // The animation is the clock: pausing it pauses the closing, its end closes the panel.
      const a = bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: ms, easing: "linear", fill: "forwards" });
      anim = a;
      void a.finished.then(
        () => {
          if (anim === a) {
            stop();
            close();
          }
        },
        () => {},
      );
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        text.hidden = false;
        paintText();
        tick = window.setInterval(paintText, 250);
      }
      // Already under the pointer (not a stale touch :hover) or holding the focus: starts paused.
      hold((held && box.matches(":hover")) || box.contains(document.activeElement));
    },
  };
}

let queueBatches = 0;
let queueProblem: "" | "err" | "cancel" = "";
let queueCloser: Closer | null = null;
const failedUploads: { file: File; folder: string; why: string }[] = [];
function closeQueue() {
  queueCloser?.stop();
  queueProblem = "";
  ui("queue").hidden = true;
  ui("queue-list").replaceChildren();
}
function wireQueue() {
  queueCloser = panelCloser(ui("queue"), closeQueue);
  dlCloser = panelCloser($("downloads"), closeDownloads);
  ui("queue-close").onclick = () => closeQueue();
  const bar = $("upload-failed");
  const list = $("upload-failed-list");
  const show = $("upload-failed-show");
  show.onclick = () => {
    list.hidden = !list.hidden;
    show.setAttribute("aria-expanded", String(!list.hidden));
    show.textContent = t(list.hidden ? "upf.show" : "upf.hide");
  };
  $("upload-failed-close").onclick = () => {
    failedUploads.length = 0;
    paintFailed();
  };
  $("upload-retry").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const again = failedUploads.splice(0);
      paintFailed();
      const byFolder = new Map<string, File[]>();
      for (const x of again) (byFolder.get(x.folder) ?? byFolder.set(x.folder, []).get(x.folder)!).push(x.file);
      for (const [folder, files] of byFolder) await uploadAll(files, folder);
    });
  bar.hidden = true;
}
function paintFailed() {
  const bar = $("upload-failed");
  bar.hidden = failedUploads.length === 0;
  $("upload-failed-count").textContent = tn("upf.count", failedUploads.length);
  $("upload-failed-list").replaceChildren(...failedUploads.map((x) => h("li", { "data-ddn": "upload-failed-item" }, h("span", { class: "n", title: x.file.name }, x.file.name), h("span", { class: "why", title: x.why }, x.why))));
}

/**
 * One file of an upload batch: picked in the browser (a File), or a path on this computer (desktop app:
 * the agent reads it from disk; `folder` = the subfolders it goes into, for a dropped folder).
 */
type UploadItem = { kind: "file"; f: File; name: string; size: number } | { kind: "path"; path: string; folder: string[]; name: string; size: number; file?: File };

async function uploadAll(files: File[], into?: string) {
  return uploadItems(files.map((f) => ({ kind: "file" as const, f, name: f.name, size: f.size })), into);
}

async function uploadItems(files: UploadItem[], into?: string) {
  if (!files.length) return;
  if (!channelsOk) {
    toast(t("err.need_channel"), "err");
    return;
  }
  const folder = into ?? currentFolder();
  queueCloser?.stop(); // a new upload cancels the closing
  queueBatches++;
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
    const speed = h("span", { "data-ddn": "queue-speed" });
    const label = f.kind === "path" && f.folder.length ? `${f.folder.join("/")}/${f.name}` : f.name;
    const li = h("li", {}, h("span", { class: "qname", title: label }, label), h("span", { class: "qside" }, cancel, state), h("span", { class: "bar" }, bar), h("span", { class: "qfoot" }, fmt(f.size), speed));
    li.dataset.ddn = "queue-item";
    list.append(li);
    const item = { f, state, bar, token, cancel, cancelled: false, speed };
    cancel.onclick = () => {
      item.cancelled = true;
      cancel.hidden = true;
      void core.cancelUpload(token);
    };
    return item;
  });
  box.hidden = false;
  void paintLean();
  ui("queue-close").hidden = true;
  uploading = { done: 0, total: files.length };
  $("unfinished").hidden = true; // painted again when the queue ends (what is left unfinished then)
  // The whole batch: speed / time left over every byte of it (waits between files count too).
  const batch = new SpeedMeter(total, Date.now());
  const meta = () => {
    ui("queue-title").textContent = uploading ? t("queue.running", { done: uploading.done, total: uploading.total }) : failed ? t("queue.doneErr", { n: failed }) : t("queue.done");
    batch.add(sent, Date.now());
    const sp = speedText(batch);
    const m = ui("queue-meta");
    m.textContent = t("queue.meta", { sent: fmt(sent), total: fmt(total) }) + (sp.text ? ` · ${sp.text}` : "");
    m.title = sp.title;
    m.dataset.ddn = "queue-meta";
  };
  meta();
  for (const item of items) {
    const { f, state, bar, token } = item;
    if (item.cancelled) {
      queueProblem ||= "cancel";
      state.className = "qstate cancel";
      bar.className = "cancel";
      state.textContent = t("queue.cancelled");
      uploading.done++;
      meta();
      continue;
    }
    state.className = "qstate run";
    state.textContent = t("queue.preparing");
    const base = sent;
    const meter = new SpeedMeter(f.size, Date.now());
    const paintSpeed = (stages?: UploadStages) => {
      const sp = speedText(meter);
      // metadata only / e2ee: which stage the fragments are in (encrypting in this tab vs on the wire).
      const st = stages && meter.endedAt === null && (stages.enc || stages.net) ? t("queue.stages", { enc: stages.enc, net: stages.net }) : "";
      item.speed.textContent = [sp.text, st].filter(Boolean).map((x) => ` · ${x}`).join("");
      item.speed.title = sp.title;
    };
    const tick = window.setInterval(() => paintSpeed(), 1000);
    let lastStages: UploadStages | undefined;
    progressHandlers.set(token, (done, tot, stages) => {
      const pct = tot ? Math.floor((done / tot) * 100) : 100;
      state.textContent = `${pct}%`;
      bar.style.width = `${pct}%`;
      sent = base + done;
      meter.add(done, Date.now());
      lastStages = stages ?? lastStages;
      paintSpeed(lastStages);
      meta();
    });
    try {
      // Thumbnail + preview made here from the picked file while its fragments go out (never blocks it).
      const src = f.kind === "file" ? f.f : f.file;
      const pv = !!src && !!previewSource(f.name);
      if (pv) void makePreviews(src!, f.name).then((imgs) => core.uploadPreviews(token, imgs), () => core.uploadPreviews(token, null));
      const r = f.kind === "file" ? await core.upload(f.f, f.name, folder, token, uploadResumeKey(folder, f.f), pv) : await core.uploadPath(f.path, f.folder, folder, token, pv);
      state.className = "qstate done";
      state.textContent = t("queue.ok");
      if (r.resumed) state.title = t("queue.resumed", { n: r.resumed });
      bar.className = "done";
    } catch (e) {
      // Cancelled is the user's choice, not a failure: muted text and bar like discordrive's CANCELLED.
      state.className = item.cancelled ? "qstate cancel" : "qstate err";
      bar.className = item.cancelled ? "cancel" : "err";
      queueProblem = item.cancelled ? queueProblem || "cancel" : "err";
      if (item.cancelled) state.textContent = t("queue.cancelled");
      else {
        failed++;
        state.textContent = t("queue.err");
        // A file changed on disk after it was picked cannot be read again from this selection.
        const why = /NotReadable|could not be read/i.test(String((e as Error)?.message ?? e)) ? t("upf.gone", { name: f.name }) : errText(e);
        state.title = why;
        if (f.kind === "file") failedUploads.push({ file: f.f, folder, why });
      }
    } finally {
      progressHandlers.delete(token);
      item.cancel.hidden = true;
      clearInterval(tick);
      meter.finish(Date.now());
      if (state.className === "qstate done") paintSpeed();
      else item.speed.textContent = "";
    }
    sent = base + f.size;
    if (!item.cancelled) bar.style.width = "100%"; // a cancelled bar stays where it stopped
    uploading.done++;
    meta();
    void render();
  }
  queueBatches--;
  if (queueBatches > 0) return void render(); // another batch still runs in the same panel
  uploading = null;
  batch.finish(Date.now());
  meta();
  ui("queue-close").hidden = false;
  if (failed) toast(t("queue.failed", { failed, total: files.length }), "err");
  paintFailed();
  void paintUnfinished();
  queueCloser?.start(queueProblem || "ok");
  await render();
}

function wireFilesPage() {
  $<HTMLInputElement>("file").onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    // Desktop: the agent reads the picked files from disk (resumable after a restart, nothing copied here).
    const paths = desktop ? desktop.pathsOf(files) : [];
    if (desktop && paths.length === files.length) await uploadPathsFromDrop(paths, files);
    else await uploadAll(files);
  };
  wireQueue();
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
    const files = [...(e.dataTransfer?.files ?? [])];
    // Desktop: files and whole folders straight from disk (the agent reads them; nothing is copied here).
    if (desktop) void uploadPathsFromDrop(desktop.pathsOf(files), files);
    else void uploadAll(files);
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
  // List / Tiles (both pages) and the sort from the column heads (click again = the other direction).
  for (const b of all<HTMLButtonElement>("[data-ddn=view] [data-view]")) {
    b.onclick = () => {
      setView(b.dataset.view === "tiles" ? "tiles" : "list");
    };
  }
  for (const b of all<HTMLButtonElement>("[data-ddn=sort]")) {
    b.onclick = () => {
      const by = b.dataset.sort as SortBy;
      setSort(by, sort.by === by ? !sort.desc : by !== "name"); // size / date: biggest / newest first
    };
  }
  paintView();
  paintSort();
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


// ── network state, save data, stuck-connection guard, unfinished uploads ──
const NET_KEY = "ddn.net";
type NetPrefs = { saveData?: boolean; guard?: boolean; baseline?: unknown; tune?: { up?: number; down?: number } };
function storedNet(): NetPrefs {
  try {
    return JSON.parse(localStorage.getItem(NET_KEY) ?? "{}") as NetPrefs;
  } catch {
    return {};
  }
}
function storeNet(p: NetPrefs) {
  try {
    localStorage.setItem(NET_KEY, JSON.stringify({ ...storedNet(), ...p }));
  } catch {
    /* private mode */
  }
}
let netState = "ok";
let netResumeTimer = 0;
/** One line in both transfer panels, in words (no codes): weak link / waiting for the network / resumed. */
function paintNet(state: string) {
  netState = state;
  clearTimeout(netResumeTimer);
  for (const id of ["queue-net", "dl-net"]) {
    const el = $(id);
    el.hidden = state === "ok";
    el.dataset.state = state;
    el.textContent = state === "weak" ? t("net.weak") : state === "offline" ? t("net.offline") : state === "resumed" ? t("net.resumed") : "";
  }
  if (state === "resumed") netResumeTimer = window.setTimeout(() => netState === "resumed" && paintNet("ok"), 5000);
}
/** Second CDN connection: lane.html in a hidden sandboxed iframe (opaque origin = its own connection). */
function startLane() {
  if (document.querySelector("[data-ddn=lane-frame]")) return;
  const f = document.createElement("iframe");
  f.hidden = true;
  f.dataset.ddn = "lane-frame";
  f.setAttribute("sandbox", "allow-scripts");
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.src = "/lane.html";
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow || !(e.data as { ddnLaneReady?: number })?.ddnLaneReady) return;
    const ch = new MessageChannel();
    f.contentWindow!.postMessage({ ddnLane: 1 }, "*", [ch.port1]);
    worker.postMessage({ ddnLane: 1 }, [ch.port2]);
  });
  document.body.append(f);
}
function wireNet() {
  addEventListener("online", () => void core.setOnline(true));
  addEventListener("offline", () => void core.setOnline(false));
  if (!navigator.onLine) void core.setOnline(false);
  const p = storedNet();
  // Desktop: the agent keeps the reference speed and the automatic values itself (it runs without a window).
  void core.setNetPrefs({ saveData: !!p.saveData, guard: p.guard !== false, ...(desktop ? {} : { baseline: p.baseline ?? null, tune: p.tune ?? null }) }).then(paintNetSettings);
  const save = $<HTMLInputElement>("net-savedata");
  const guard = $<HTMLInputElement>("net-guard");
  save.onchange = () =>
    void act(null, async () => {
      storeNet({ saveData: save.checked });
      paintNetSettings(await core.setNetPrefs({ saveData: save.checked }));
      await paintConcurrency();
    });
  guard.onchange = () =>
    void act(null, async () => {
      storeNet({ guard: guard.checked });
      paintNetSettings(await core.setNetPrefs({ guard: guard.checked }));
    });
  // Desktop: the agent has its own connections (a second one for the guard included); no iframe lane.
  if (!desktop) startLane();
  $("unfinished-pick").onclick = () => $<HTMLInputElement>("file").click();
  $("unfinished-forget").onclick = () =>
    void act(null, async () => {
      for (const u of await core.unfinishedUploads()) await core.forgetUnfinished(u.key);
      await paintUnfinished();
    });
}
type NetStatus = Awaited<ReturnType<typeof core.netStatus>>;
/**
 * Save data is on (the switch, a metered link, a phone): both transfer panels say so, with the reason and
 * a link to the setting (otherwise a slow transfer looks like a slow line).
 */
function paintLeanWith(st: NetStatus | null) {
  const why = st?.leanWhy ?? null;
  for (const id of ["queue", "dl"]) {
    const el = $(`${id}-lean`);
    el.hidden = !why;
    if (why) {
      el.dataset.why = why;
      ui(`${id}-lean-t`).textContent = t("lean.t", { why: t(`lean.why.${why}`) });
    }
  }
}
async function paintLean() {
  paintLeanWith(await core.netStatus().catch(() => null));
}
function paintNetSettings(st: NetStatus | null) {
  if (!st) return;
  paintLeanWith(st);
  $("net-state").textContent = st.leanWhy ? t("netS.chip.lean") : "";
  $("net-state").className = `chip${st.leanWhy ? " chip--accent" : ""}`;
  $("net-state").hidden = !st.leanWhy;
  const save = $<HTMLInputElement>("net-savedata");
  save.checked = st.saveData || st.browserMetered;
  save.disabled = st.browserMetered;
  $("net-savedata-t").textContent = st.browserMetered ? `${t("net.save.t")} ${t("net.save.auto")}` : t("net.save.t");
  const guard = $<HTMLInputElement>("net-guard");
  guard.checked = st.guard;
  guard.disabled = st.metered;
  const r = (v: number | null) => (v ? fmtRate(v) : t("net.info.none"));
  $("net-info").textContent = t("net.info", { down: r(st.baseline.down), up: r(st.baseline.up), lanes: st.lanes, sw: st.guardStats.switches, probes: st.guardStats.probes });
}
async function paintUnfinished() {
  const list = await core.unfinishedUploads().catch(() => []);
  const box = $("unfinished");
  box.hidden = list.length === 0 || !!uploading;
  if (box.hidden) return;
  $("unfinished-count").textContent = tn("unf.count", list.length);
  $("unfinished-list").replaceChildren(
    ...list.map((u) => h("li", { "data-ddn": "unfinished-item" }, h("span", { class: "n", title: u.name }, t("unf.item", { name: u.name, have: u.have, n: u.n })))),
    h("li", {}, h("span", { class: "why" }, t("unf.t"))),
  );
}

// ── downloads panel: progress, speed, time left, cancel ──
let dlRunning = 0;
let dlCloser: Closer | null = null;
function dlMeta() {
  const items = all<HTMLElement>("[data-ddn=dl-item]");
  const failed = items.filter((li) => li.dataset.state === "err").length;
  ui("dl-title").textContent = dlRunning ? t("dl.running", { n: dlRunning }) : failed ? t("dl.doneErr", { n: failed }) : t("dl.done");
  $("dl-close").hidden = dlRunning > 0;
}
function closeDownloads() {
  dlCloser?.stop();
  $("downloads").hidden = true;
  $("dl-list").replaceChildren();
}
/**
 * Desktop: dropped files and folders are uploaded by the agent straight from disk, in the same queue panel
 * as files picked in the browser (one row per file, its progress, speed and cancel).
 */
async function uploadPathsFromDrop(paths: string[], files: File[] = []) {
  if (!paths.length) return;
  try {
    const list = await core.listPaths(paths);
    // A dropped / picked file (not a folder's content) is also here as a File: previews are made from it.
    const byPath = new Map(paths.map((p, i) => [p, files[i]] as const));
    await uploadItems(list.map((x) => ({ kind: "path" as const, ...x, file: byPath.get(x.path) })));
  } catch (e) {
    toast(errText(e), "err");
  }
}

function download(id: string, name: string) {
  const box = $("downloads");
  const list = $("dl-list");
  dlCloser?.stop(); // a new download cancels the closing
  const token = crypto.randomUUID();
  const state = h("span", { class: "qstate run" }, "0%");
  const bar = h("i");
  const speed = h("span", { "data-ddn": "dl-speed" });
  const size = h("span", {}, "");
  const cancel = h("button", { class: "iconbtn qcancel", type: "button", "data-ddn": "dl-cancel", "aria-label": t("queue.cancel"), title: t("queue.cancel") }, icon("x"));
  const li = h("li", { "data-ddn": "dl-item" }, h("span", { class: "qname", title: name }, name), h("span", { class: "qside" }, cancel, state), h("span", { class: "bar" }, bar), h("span", { class: "qfoot" }, size, speed));
  list.prepend(li);
  box.hidden = false;
  void paintLean();
  dlRunning++;
  dlMeta();
  let meter: SpeedMeter | null = null;
  let cancelled = false;
  cancel.onclick = () => {
    cancelled = true;
    void core.cancelDownload(token);
  };
  const paint = () => {
    if (!meter) return;
    const sp = speedText(meter);
    speed.textContent = sp.text ? ` · ${sp.text}` : "";
    speed.title = sp.title;
  };
  const tick = window.setInterval(paint, 1000);
  progressHandlers.set(token, (done, total) => {
    meter ??= new SpeedMeter(total, Date.now());
    meter.add(done, Date.now());
    const pct = total ? Math.floor((done / total) * 100) : 100;
    state.textContent = `${pct}%`;
    bar.style.width = `${pct}%`;
    size.textContent = t("queue.meta", { sent: fmt(done), total: fmt(total) });
    paint();
  });
  const end = (ok: boolean, why?: string) => {
    progressHandlers.delete(token);
    clearInterval(tick);
    cancel.hidden = true;
    dlRunning--;
    meter?.finish(Date.now());
    li.dataset.state = ok ? "done" : cancelled ? "cancel" : "err";
    state.className = `qstate ${ok ? "done" : cancelled ? "cancel" : "err"}`;
    state.textContent = ok ? t("queue.ok") : cancelled ? t("queue.cancelled") : t("queue.err");
    bar.className = ok ? "done" : cancelled ? "cancel" : "err";
    if (ok) bar.style.width = "100%";
    if (why) state.title = why;
    if (ok) paint();
    else speed.textContent = "";
    dlMeta();
    // When the last one ended: closes itself like the upload queue (longer after a failure or a cancel).
    if (!dlRunning) {
      const states = all<HTMLElement>("[data-ddn=dl-item]").map((x) => x.dataset.state);
      dlCloser?.start(states.includes("err") ? "err" : states.includes("cancel") ? "cancel" : "ok");
    }
  };
  // Desktop: the agent writes the file straight to the downloads folder (at offsets, resumable).
  const toDisk = async () => {
    const r = await core.downloadToDisk(id, undefined, token);
    state.title = r.path;
    li.dataset.path = r.path;
    // "Show in folder": the name of a finished download opens the system file manager at the file.
    const nameEl = li.querySelector<HTMLElement>(".qname");
    if (nameEl && desktop) {
      nameEl.dataset.ddn = "dl-show";
      nameEl.classList.add("qshow");
      nameEl.title = t("dl.show");
      nameEl.setAttribute("role", "button");
      nameEl.tabIndex = 0;
      nameEl.onclick = () => desktop.showInFolder(r.path);
      nameEl.onkeydown = (e) => void ((e.key === "Enter" || e.key === " ") && (e.preventDefault(), desktop.showInFolder(r.path)));
      // A visible button too: the name alone did not say it could be clicked.
      const b = h("button", { class: "btn sm", type: "button", "data-ddn": "dl-show-btn" }, icon("folder"), t("dl.show"));
      b.onclick = () => desktop.showInFolder(r.path);
      li.querySelector(".qfoot")?.after(b) ?? li.append(b);
    }
  };
  const viaBlob = () =>
    core.download(id, token).then((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
  return (async () => {
    if (desktop) return toDisk();
    const info = await core.fileInfo(id);
    // Big files stream to disk through the service worker (the tab never holds the whole file);
    // small ones, or without a service worker, through a Blob.
    const sw = navigator.serviceWorker?.controller;
    if (info && sw && info.size > STREAM_MIN_BYTES) {
      try {
        await streamDownload(sw, id, token, name, info);
        return;
      } catch (e) {
        if (!/stream_not_started|stream_no_port/.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
    await viaBlob();
  })().then(
    () => end(true),
    (e) => {
      end(false, cancelled ? undefined : errText(e));
      if (!cancelled) throw e;
    },
  );
}

/** Files above this go straight to disk (sw.ts); below it a Blob is cheaper and works everywhere. Tests lower it (config). */
const STREAM_MIN_BYTES = typeof cfg.streamMinBytes === "number" ? cfg.streamMinBytes : 32 * 1024 * 1024;
async function streamDownload(sw: ServiceWorker, id: string, token: string, name: string, info: { size: number; mime: string }) {
  const ch = new MessageChannel();
  sw.postMessage({ ddn: "dl", token, name, size: info.size, mime: info.mime }, [ch.port1]);
  worker.postMessage({ ddnPort: token }, [ch.port2]);
  // A hidden frame opens the streamed URL: the response is an attachment, so the browser saves it.
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.dataset.ddn = "dl-frame";
  frame.src = `/ddn/download/${encodeURIComponent(token)}`;
  document.body.append(frame);
  // The service worker may be stopped by the browser when idle for ~30 s: keep it busy while we stream.
  const ping = window.setInterval(() => sw.postMessage({ ddn: "ping" }), 10_000);
  try {
    await core.downloadStream(id, token);
  } finally {
    clearInterval(ping);
    setTimeout(() => frame.remove(), 60_000);
  }
}

// ── selection, row menu, rename, move, trash (discordrive FileTable patterns) ──

function paintBulk() {
  const n = selected.size;
  $("bulk").hidden = n === 0;
  $("bulk-count").textContent = tn("bulk.count", n);
  // Download is for files only (folders would need a ZIP, not in this app yet).
  $<HTMLButtonElement>("bulk-download").hidden = ![...selected.values()].some((x) => x.kind === "file");
  const all = $<HTMLInputElement>("select-all");
  const rows = all.closest("table")!.querySelectorAll<HTMLInputElement>("tbody [data-ddn=select]");
  const on = [...rows].filter((b) => b.checked).length;
  all.checked = rows.length > 0 && on === rows.length;
  all.indeterminate = on > 0 && on < rows.length;
}

/** Summary toast of an operation: rule notices first, else the plain success text (with Undo when given). */
function report(r: OpOutcome, ok: string, undo?: () => Promise<unknown>) {
  const shown = r.notices.filter((n) => noticeText(n));
  if (shown.length) showNotices(shown);
  if (r.outcome === "applied") toast(ok, "ok", undo ? { label: t("act.undo"), run: undo } : undefined);
}

async function trashItems(items: { id: string; name: string }[]) {
  const ids = items.map((x) => x.id);
  const r = await core.trash(ids);
  selected.clear();
  await render();
  report(r, items.length === 1 ? t("act.trashed", { name: items[0]!.name }) : tn("act.trashedN", items.length), async () => {
    showNotices((await core.restore(ids)).notices);
    await render();
  });
}

async function moveItems(ids: string[], target: string, targetName: string, firstName = "") {
  const r = await core.move(ids, target);
  selected.clear();
  await render();
  report(r, ids.length === 1 ? t("act.moved", { name: firstName, folder: targetName }) : tn("act.movedN", ids.length, { folder: targetName }), async () => {
    showNotices((await core.moveBack(r.from)).notices);
    await render();
  });
}

// ── menus: the row menu (⋯) and the context menu (right click, Menu key / Shift+F10, long press) ──
// One floating menu ([data-ddn=row-menu]) for all of them. Under a button
// (⋯) or at the pointer; arrows / Home / End move, Esc closes, focus goes back to where it came from.
type MenuRow = { id: string; name: string; kind: "file" | "folder"; size: number | null; unavailable?: string[] };
type MenuEntry = { ic: string; label: string; key: string; run: () => void; danger?: boolean; checked?: boolean } | "sep" | { group: string };
let menuFor: HTMLElement | null = null;
let menuAt: { x: number; y: number } | null = null;
let menuBack: HTMLElement | null = null;
let menuBackKey: { row: string; ddn: string } | null = null;
let menuOpenedAt = 0;
function closeRowMenu(doRefocus = true) {
  const m = $("row-menu");
  if (m.hidden) return;
  m.hidden = true;
  menuFor?.setAttribute("aria-expanded", "false");
  const back = menuBack;
  const key = menuBackKey;
  menuFor = menuAt = menuBack = menuBackKey = null;
  if (!doRefocus) return;
  if (back?.isConnected) back.focus({ preventScroll: true });
  else refocus(key); // the row was rebuilt meanwhile: the same control in the new row
}
function openMenu(entries: MenuEntry[], where: { button: HTMLElement } | { x: number; y: number; back: HTMLElement | null }, kind: string) {
  const m = $("row-menu");
  if (!m.hidden) closeRowMenu(false);
  const kids: HTMLElement[] = [];
  for (const e of entries) {
    if (e === "sep") {
      if (kids.length && !kids.at(-1)!.classList.contains("menu-sep")) kids.push(h("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if ("group" in e) {
      kids.push(h("div", { class: "menu-label", role: "presentation" }, e.group));
      continue;
    }
    const radio = e.checked !== undefined;
    const b = h("button", { type: "button", role: radio ? "menuitemradio" : "menuitem", class: e.danger ? "danger" : "", "data-ddn": `menu-${e.key}`, tabindex: "-1" }, icon(radio ? (e.checked ? "check" : "none") : e.ic), e.label);
    if (radio) b.setAttribute("aria-checked", String(e.checked));
    if (e.danger && kids.length && !kids.at(-1)!.classList.contains("menu-sep")) kids.push(h("div", { class: "menu-sep", role: "separator" }));
    b.onclick = () => {
      closeRowMenu();
      e.run();
    };
    kids.push(b);
  }
  m.replaceChildren(...kids);
  m.dataset.for = kind;
  m.hidden = false;
  menuOpenedAt = Date.now();
  if ("button" in where) {
    menuFor = menuBack = where.button;
    where.button.setAttribute("aria-expanded", "true");
  } else {
    menuAt = { x: where.x, y: where.y };
    menuBack = where.back;
  }
  menuBackKey = focusKey(menuBack);
  placeRowMenu();
  m.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
}
function placeRowMenu() {
  const m = $("row-menu");
  const w = m.offsetWidth;
  const hgt = m.offsetHeight;
  let top: number;
  let left: number;
  if (menuFor) {
    const b = menuFor.getBoundingClientRect();
    top = b.bottom + 4 + hgt > window.innerHeight ? Math.max(8, b.top - 4 - hgt) : b.bottom + 4;
    left = b.right - w;
  } else if (menuAt) {
    top = menuAt.y + hgt + 8 > window.innerHeight ? Math.max(8, menuAt.y - hgt) : menuAt.y;
    left = menuAt.x + w + 8 > window.innerWidth ? menuAt.x - w : menuAt.x;
  } else return;
  m.style.top = `${Math.max(8, top)}px`;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, left))}px`;
}
function openRowMenu(btn: HTMLElement, r: MenuRow) {
  const m = $("row-menu");
  if (!m.hidden && menuFor === btn) return closeRowMenu();
  openMenu(rowEntries(r), { button: btn }, "row");
}

/** Actions of one row (the ⋯ menu and the right click); several selected rows -> the bulk actions. */
function rowEntries(r: MenuRow): MenuEntry[] {
  if (selected.size > 1 && selected.has(r.id)) {
    const n = selected.size;
    const files = [...selected.values()].some((x) => x.kind === "file");
    return [
      { group: tn("bulk.count", n) },
      ...(files ? [{ ic: "download", label: t("files.download"), key: "download", run: () => void act(null, bulkDownload) }] : []),
      { ic: "move", label: t("act.move"), key: "move", run: bulkMove },
      { ic: "x", label: t("bulk.clear"), key: "clear", run: clearSelection },
      { ic: "trash", label: t("act.trash"), key: "trash", run: () => void act(null, bulkTrash), danger: true },
    ];
  }
  const un = !!r.unavailable?.length;
  return [
    ...(r.kind === "folder"
      ? [{ ic: "folder", label: t("act.open"), key: "open", run: () => openFolder(r.id) }]
      : [{ ic: "eye", label: t("pv.action"), key: "preview", run: () => previewFile(r) }, ...(un ? [] : [{ ic: "download", label: t("files.download"), key: "download", run: () => void act(null, () => download(r.id, r.name)) }])]),
    ...(canShare(r) ? [{ ic: "share", label: t("files.share"), key: "share", run: () => void act(null, () => shareRow(r)) }] : []),
    { ic: "pencil", label: t("act.rename"), key: "rename", run: () => openRename(r) },
    { ic: "move", label: t("act.move"), key: "move", run: () => void openMove([r.id], r.name) },
    { ic: "trash", label: t("act.trash"), key: "trash", run: () => void act(null, () => trashItems([r])), danger: true },
  ];
}
/** View and sort entries (both pages' empty area). */
function viewEntries(withSort: boolean): MenuEntry[] {
  const out: MenuEntry[] = [
    "sep",
    { group: t("view.label") },
    { ic: "list", label: t("view.list"), key: "view-list", run: () => setView("list"), checked: view === "list" },
    { ic: "grid", label: t("view.tiles"), key: "view-tiles", run: () => setView("tiles"), checked: view === "tiles" },
  ];
  if (withSort && !searchQ)
    out.push(
      "sep",
      { group: t("sort.label") },
      ...(["name", "size", "date"] as const).map((by) => ({ ic: "sort", label: t(`sort.${by}`), key: `sort-${by}`, run: () => setSort(by, sort.desc), checked: sort.by === by })),
      "sep",
      { ic: "up", label: t("sort.asc"), key: "sort-asc", run: () => setSort(sort.by, false), checked: !sort.desc },
      { ic: "down", label: t("sort.desc"), key: "sort-desc", run: () => setSort(sort.by, true), checked: sort.desc },
    );
  out.push("sep", { ic: "refresh", label: t("menu.refresh"), key: "refresh", run: refresh });
  return out;
}
function refresh() {
  shownList = "";
  void render();
}
function filesEntries(): MenuEntry[] {
  return [
    ...(searchQ ? [] : [{ ic: "folder-plus", label: t("files.newFolder"), key: "new-folder", run: () => $("new-folder").click() }]),
    { ic: "upload", label: t("files.upload"), key: "upload", run: () => (channelsOk ? $<HTMLInputElement>("file").click() : toast(t("err.need_channel"), "err")) },
    { ic: "check-square", label: t("menu.selectAll"), key: "select-all", run: selectAllRows },
    ...viewEntries(true),
  ];
}
function trashRowEntries(x: TrashRow): MenuEntry[] {
  return [
    { ic: "restore", label: t("trash.restore"), key: "restore", run: () => void act(null, () => restoreOne(x)) },
    { ic: "x", label: t("trash.purge"), key: "purge", run: () => void act(null, () => purgeOne(x)), danger: true },
  ];
}
function trashEntries(): MenuEntry[] {
  const any = $("trash-list").children.length > 0;
  return [...(any ? [{ ic: "trash", label: t("trash.empty"), key: "empty-trash", run: () => void act(null, emptyTrashAsk), danger: true }] : []), ...viewEntries(false)];
}

/** What a right click / Menu key / long press at `target` opens; null = the browser's own menu. */
function contextEntries(target: Element | null): { entries: MenuEntry[]; kind: string; back: HTMLElement | null } | null {
  if (!target || target.closest("input:not([type=checkbox]), textarea, select, [contenteditable=true], dialog, .menu")) return null;
  const page = target.closest<HTMLElement>("[data-page]");
  if (!page || page.hidden) return null;
  const row = target.closest<HTMLElement>("[data-ddn=row]");
  if (row && rowData.has(row)) return { entries: rowEntries(rowData.get(row)!), kind: "row", back: row.querySelector<HTMLElement>("[data-ddn=row-more]") };
  const tr = target.closest<HTMLElement>("[data-ddn=trash-row]");
  if (tr && trashData.has(tr)) return { entries: trashRowEntries(trashData.get(tr)!), kind: "trash-row", back: tr.querySelector<HTMLElement>("[data-ddn=trash-restore]") };
  // Links outside the list (breadcrumbs, navigation) keep the browser menu (open in a new tab).
  if (target.closest("a[href]")) return null;
  if (page.dataset.page === "files" && route.name === "files") return { entries: filesEntries(), kind: "files", back: null };
  if (page.dataset.page === "trash") return { entries: trashEntries(), kind: "trash", back: null };
  return null;
}
let suppressClickUntil = 0;
let kbMenuAt = 0;
function wireRowMenu() {
  document.addEventListener("click", (e) => {
    const m = $("row-menu");
    if (!m.hidden && !m.contains(e.target as Node) && !(e.target as Element | null)?.closest("[data-ddn=row-more]")) closeRowMenu(false);
  });
  // The click that ends a long press must not open the preview or close the menu it opened.
  window.addEventListener(
    "click",
    (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    // Menu key / Shift+F10: the context menu of the focused element (row, or the page's empty area).
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const focus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      const target = focus ?? document.querySelector<HTMLElement>("[data-page]:not([hidden])");
      const c = contextEntries(target);
      if (!c) return;
      e.preventDefault();
      kbMenuAt = Date.now();
      const r = (focus ?? target)!.getBoundingClientRect();
      const box = focus ? r : { left: r.left + 16, bottom: r.top + 16 };
      openMenu(c.entries, { x: Math.max(8, box.left), y: Math.max(8, Math.min(window.innerHeight - 8, box.bottom)), back: focus ?? c.back }, c.kind);
      return;
    }
    if ($("row-menu").hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeRowMenu();
    } else if (e.key === "Tab") closeRowMenu(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const bs = [...$("row-menu").querySelectorAll<HTMLButtonElement>("button")];
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      const j = e.key === "Home" ? 0 : e.key === "End" ? bs.length - 1 : (i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length;
      bs[j]?.focus();
    }
  });
  // Long press on a touch screen = the same menu (iOS Safari fires no contextmenu at all).
  let press: { id: number; x: number; y: number; timer: number } | null = null;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  document.addEventListener("contextmenu", (e) => {
    // Shift + right click: the browser's own menu (inspect, copy link…).
    if (e.shiftKey && e.button === 2) return;
    const c = contextEntries(e.target as Element | null);
    if (!c) return;
    e.preventDefault();
    cancel(); // Android: its own long-press contextmenu came first
    // Already opened by the key or the long press that caused this event.
    if (Date.now() - kbMenuAt < 600 || (!$("row-menu").hidden && Date.now() - menuOpenedAt < 600)) return;
    openMenu(c.entries, { x: e.clientX, y: e.clientY, back: c.back }, c.kind);
  });
  document.addEventListener("pointerdown", (e) => {
    cancel();
    if (e.pointerType !== "touch") return;
    const target = e.target as Element | null;
    if (!contextEntries(target) || target?.closest("button, input")) return;
    const { clientX: x, clientY: y, pointerId: id } = e;
    press = {
      id,
      x,
      y,
      timer: window.setTimeout(() => {
        press = null;
        const c = contextEntries(target);
        if (!c) return;
        suppressClickUntil = Date.now() + 800;
        openMenu(c.entries, { x, y, back: c.back }, c.kind);
        navigator.vibrate?.(10);
      }, 500),
    };
  });
  document.addEventListener("pointermove", (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel();
  });
  document.addEventListener("pointerup", cancel);
  document.addEventListener("pointercancel", cancel);
  // Close on a real scroll by the user, not on the small scroll the browser itself makes right after
  // opening (focus into view; seen in plain PL where the row sits near the bottom): the menu follows the
  // button instead within the first moment.
  window.addEventListener(
    "scroll",
    () => {
      if (Date.now() - menuOpenedAt < 400 && (menuFor || menuAt)) return placeRowMenu();
      closeRowMenu(false);
    },
    { passive: true },
  );
  window.addEventListener("resize", () => closeRowMenu(false));
}

// Rename (RenameFolderModal): prefilled, the name without the extension selected.
let renaming: { id: string; name: string; kind: "file" | "folder" } | null = null;
function openRename(r: { id: string; name: string; kind: "file" | "folder" }) {
  renaming = r;
  const d = $<HTMLDialogElement>("rename-dialog");
  ui("rn-title").textContent = t(r.kind === "folder" ? "rn.folder" : "rn.file");
  const input = $<HTMLInputElement>("rename-name");
  input.value = r.name;
  $("rename-error").hidden = true;
  d.showModal();
  input.focus();
  const dot = r.kind === "file" ? r.name.lastIndexOf(".") : -1;
  input.setSelectionRange(0, dot > 0 ? dot : r.name.length);
}
function renameProblem(v: string): string | null {
  if (!v.trim()) return t("rn.empty");
  if (v.includes("/")) return t("rn.slash");
  if (v.trim() === "." || v.trim() === "..") return t("rn.dots");
  return null;
}
function wireRename() {
  const d = $<HTMLDialogElement>("rename-dialog");
  const input = $<HTMLInputElement>("rename-name");
  const err = $("rename-error");
  ui("rn-close").onclick = () => d.close();
  ui("rn-cancel").onclick = () => d.close();
  input.oninput = () => {
    const p = renameProblem(input.value);
    err.hidden = !p;
    err.textContent = p ?? "";
  };
  ui<HTMLFormElement>("rn-form").onsubmit = (e) => {
    e.preventDefault();
    const r = renaming;
    if (!r) return;
    const v = input.value.trim();
    const p = renameProblem(v);
    if (p) {
      err.hidden = false;
      err.textContent = p;
      return;
    }
    if (v === r.name) return d.close();
    void act($("rename-save"), async () => {
      const res = await core.rename(r.id, v);
      d.close();
      await render();
      // Rule 2: the name was taken, the node got a suffix: the notice says which.
      report(res, t("act.renamed", { name: res.name ?? v }), async () => {
        if (res.before) showNotices((await core.rename(r.id, res.before)).notices);
        await render();
      });
    });
  };
}

// Move to… (folder picker): browse folders from the root; the moved folders themselves are not offered.
let moving: { ids: string[]; label: string; at: string; path: { id: string; name: string }[] } | null = null;
async function openMove(ids: string[], label: string) {
  moving = { ids, label, at: "root", path: [] };
  ui("mv-title").textContent = ids.length === 1 ? t("mv.one", { name: label }) : tn("mv.many", ids.length);
  $<HTMLDialogElement>("move-dialog").showModal();
  await paintMove();
}
async function paintMove() {
  const m = moving;
  if (!m) return;
  const crumbs = $("move-crumbs");
  const link = (id: string, name: string, i: number) => {
    const b = h("button", { type: "button", class: "link" }, name);
    b.onclick = () => {
      m.at = id;
      m.path = m.path.slice(0, i);
      void paintMove();
    };
    return b;
  };
  const parts: Node[] = [m.path.length ? link("root", t("files.root"), 0) : h("span", { "aria-current": "page" }, t("files.root"))];
  m.path.forEach((p, i) => parts.push(icon("right"), i === m.path.length - 1 ? h("span", { "aria-current": "page" }, p.name) : link(p.id, p.name, i + 1)));
  crumbs.replaceChildren(...parts);
  const kids = (await core.subfolders(m.at)).filter((f) => !m.ids.includes(f.id));
  $("move-list").replaceChildren(
    ...(kids.length
      ? kids.map((f) => {
          const b = h("button", { type: "button", "data-ddn": "move-folder", "data-id": f.id }, icon("folder"), h("span", { class: "dname" }, f.name), icon("right"));
          b.onclick = () => {
            m.path.push(f);
            m.at = f.id;
            void paintMove();
          };
          return h("li", {}, b);
        })
      : [h("li", { class: "empty-row" }, t("mv.none"))]),
  );
  const here = m.path.at(-1)?.name ?? t("files.root");
  ui("mv-hint").textContent = t("mv.target", { folder: here });
}
function wireMove() {
  const d = $<HTMLDialogElement>("move-dialog");
  ui("mv-close").onclick = () => d.close();
  ui("mv-cancel").onclick = () => d.close();
  d.addEventListener("close", () => (moving = null));
  $("move-here").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const m = moving;
      if (!m) return;
      const name = m.path.at(-1)?.name ?? t("files.root");
      d.close();
      await moveItems(m.ids, m.at, name, m.label);
    });
}

/** Ask before something that cannot be undone. Resolves true on the danger button. */
function confirmDanger(title: string, text: string, yes: string): Promise<boolean> {
  const d = $<HTMLDialogElement>("confirm-dialog");
  ui("cf-title").textContent = title;
  ui("cf-text").textContent = text;
  $("confirm-yes").textContent = yes;
  d.showModal();
  ui<HTMLButtonElement>("cf-no").focus();
  return new Promise((resolve) => {
    let answer = false;
    $("confirm-yes").onclick = () => {
      answer = true;
      d.close();
    };
    ui("cf-no").onclick = () => d.close();
    d.addEventListener("close", () => resolve(answer), { once: true });
  });
}

function setAllRows(on: boolean) {
  for (const b of $("list").querySelectorAll<HTMLInputElement>("[data-ddn=select]")) {
    if (b.checked !== on) {
      b.checked = on;
      b.dispatchEvent(new Event("change"));
    }
  }
  paintBulk();
}
const selectAllRows = () => setAllRows(true);
function clearSelection() {
  selected.clear();
  for (const b of $("list").querySelectorAll<HTMLInputElement>("[data-ddn=select]")) b.checked = false;
  for (const tr of $("list").querySelectorAll("tr.sel")) tr.classList.remove("sel");
  paintBulk();
}
const bulkTrash = () => trashItems([...selected].map(([id, x]) => ({ id, name: x.name })));
function bulkMove() {
  const ids = [...selected.keys()];
  if (ids.length) void openMove(ids, selected.get(ids[0]!)!.name);
}
async function bulkDownload() {
  // One file after another (the browser asks once whether to allow several downloads).
  for (const [id, x] of selected) if (x.kind === "file") await download(id, x.name);
}
function wireSelection() {
  $<HTMLInputElement>("select-all").onchange = (e) => setAllRows((e.target as HTMLInputElement).checked);
  $("bulk-clear").onclick = () => clearSelection();
  $("bulk-trash").onclick = (e) => void act(e.currentTarget as HTMLElement, bulkTrash);
  $("bulk-move").onclick = () => bulkMove();
  $("bulk-download").onclick = (e) => void act(e.currentTarget as HTMLElement, bulkDownload);
  // Drag and drop of rows onto folder rows and breadcrumb links.
  const target = (e: DragEvent) => (e.dataTransfer?.types.includes(DRAG_TYPE) ? (e.target as Element | null)?.closest<HTMLElement>("[data-drop]") : null);
  document.addEventListener("dragover", (e) => {
    const t0 = target(e);
    if (!t0) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    for (const x of document.querySelectorAll(".drop-over")) if (x !== t0) x.classList.remove("drop-over");
    t0.classList.add("drop-over");
  });
  document.addEventListener("dragleave", (e) => {
    const t0 = target(e);
    if (t0 && !t0.contains(e.relatedTarget as Node | null)) t0.classList.remove("drop-over");
  });
  document.addEventListener("drop", (e) => {
    const t0 = target(e);
    if (!t0) return;
    e.preventDefault();
    e.stopPropagation();
    t0.classList.remove("drop-over");
    const ids = (JSON.parse(e.dataTransfer!.getData(DRAG_TYPE) || "[]") as string[]).filter((id) => id !== t0.dataset.drop);
    const dest = t0.dataset.drop!;
    if (!ids.length || dest === currentFolder()) return;
    const name = dest === "root" ? t("files.root") : dest === "recovered" ? t("nav.recovered") : (t0.dataset.dropName ?? t0.querySelector("a")?.textContent ?? t0.textContent ?? "").trim();
    const first = document.querySelector<HTMLElement>(`[data-ddn=row][data-id="${CSS.escape(ids[0]!)}"] .nm > :last-child`)?.textContent ?? "";
    void act(null, () => moveItems(ids, dest, name, first));
  });
}

// ── Settings → Storage (cleanup of the trash and of old fragments; / Q4) ──
let storageSeq = 0;
async function renderStorage() {
  void paintBackfill();
  // Calls overlap (cleanup start/end events, renders): only the newest answer is painted.
  const seq = ++storageSeq;
  const st = await core.storageStatus().catch(() => null);
  if (!st || seq !== storageSeq) return;
  const chip = $("storage-state");
  chip.textContent = st.running ? t("st.running") : st.by === "server" ? t("st.byServer") : t("st.byBrowser");
  chip.className = `chip${st.running ? " chip--accent" : ""}`;
  $("storage-last").textContent = st.lastRunAt ? fmtDateTime(st.lastRunAt) : t("st.never");
  $("storage-expired").textContent = tn("files.count", st.expired);
  $("storage-due").textContent = st.due ? `${tn("st.uploads", st.due)} · ${fmt(st.dueBytes)}` : tn("st.uploads", 0);
  $("storage-waiting").textContent = tn("st.uploads", st.waiting);
  ui("storage-waiting-t").textContent = st.nextAt ? t("st.nextAt", { date: fmtDate(st.nextAt) }) : t("st.waiting.t");
  $<HTMLButtonElement>("cleanup-now").disabled = st.running;
  const res = $("cleanup-result");
  const l = st.last;
  res.textContent = l
    ? [
        t(l.manual ? "st.res.manual" : "st.res.auto", { date: fmtDateTime(l.at) }),
        tn("st.res.purged", l.purged),
        l.kept ? tn("notice.keptUnseen", l.kept) : "",
        st.by === "client" ? tn("st.res.frag", l.messages, { size: fmt(l.bytes) }) : tn("st.res.uploads", l.uploads),
        l.left ? tn("st.res.left", l.left) : "",
      ]
        .filter(Boolean)
        .join(" ")
    : st.metered && st.by === "client"
      ? t("st.metered")
      : "";
}
function wireStorage() {
  $("cleanup-now").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const r = await core.cleanup(true);
      await render();
      toast(t("st.done", { n: r.purged + r.uploads }));
    });
  $("thumbs-backfill").onclick = () => void runBackfill(true);
  $("thumbs-backfill-stop").onclick = () => (backfillStop = true);
}

/**
 * "Make thumbnails for existing photos": files without previews are downloaded one at a time, the
 * pictures are made here (this page has the decoder) and stored next to them. Stops with the page; the
 * core remembers what is done, so the next run continues. On a metered link only when started by hand.
 */
let backfillRunning = false;
let backfillStop = false;
async function runBackfill(manual: boolean) {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillStop = false;
  $("thumbs-backfill-stop").hidden = false;
  $<HTMLButtonElement>("thumbs-backfill").disabled = true;
  try {
    for (;;) {
      if (backfillStop) break;
      const next = await core.backfillNext(3, manual);
      if (!next.length) break;
      for (const f of next) {
        if (backfillStop) break;
        let imgs = null;
        try {
          imgs = await makePreviews(await core.download(f.nodeId), f.name);
        } catch {
          imgs = null;
        }
        await core.backfillAdd(f.nodeId, imgs).catch(() => false);
      }
    }
  } finally {
    await core.backfillEnd().catch(() => {});
    backfillRunning = false;
    $("thumbs-backfill-stop").hidden = true;
    $<HTMLButtonElement>("thumbs-backfill").disabled = false;
    void paintBackfill();
  }
}
function paintBackfillState(st: { running: boolean; done: number; made: number; left: number; metered?: boolean }) {
  const el = $("thumbs-backfill-state");
  el.textContent = st.metered && !st.running ? t("th.metered") : st.running || st.done ? t("th.state", { done: st.done, made: st.made, left: st.left }) : st.left ? "" : t("th.none");
}
async function paintBackfill() {
  const st = await core.backfillState().catch(() => null);
  if (st) paintBackfillState(st);
}

// ── Settings → Diagnostics: transfer logs ──
const TLOG_KEY = "ddn.transferLog";
function storedTransferLog(): { on: boolean; names: boolean } {
  try {
    const v = localStorage.getItem(TLOG_KEY);
    return { on: v === "1" || v === "names", names: v === "names" };
  } catch {
    return { on: false, names: false };
  }
}
function storeTransferLog(on: boolean, names: boolean) {
  try {
    localStorage.setItem(TLOG_KEY, on ? (names ? "names" : "1") : "0");
  } catch {
    /* private mode */
  }
}
/** Transfer logs stay on across reloads (this browser's choice); the worker starts writing at once. */
async function applyTransferLog() {
  const c = storedConcurrency();
  if ((c.upload || c.download) && (await core.status()).signedIn) await core.setConcurrency(c.upload, c.download).catch(() => null);
  const tl = storedTransferLog();
  if (tl.on && (await core.status()).signedIn) await core.setTransferLog(true, tl.names).catch(() => null);
}
const CONC_KEY = "ddn.concurrency";
function storedConcurrency(): { upload: number | null; download: number | null } {
  try {
    const v = JSON.parse(localStorage.getItem(CONC_KEY) ?? "{}") as { upload?: number; download?: number };
    return { upload: v.upload || null, download: v.download || null };
  } catch {
    return { upload: null, download: null };
  }
}
async function paintConcurrency() {
  const c = await core.concurrency().catch(() => null);
  if (!c) return;
  const st = storedConcurrency();
  const up = $<HTMLInputElement>("diag-conc-up");
  const down = $<HTMLInputElement>("diag-conc-down");
  if (document.activeElement !== up) ((up.value = st.upload ? String(st.upload) : ""), (up.placeholder = t("diag.auto", { n: c.upload })));
  if (document.activeElement !== down) ((down.value = st.download ? String(st.download) : ""), (down.placeholder = t("diag.auto", { n: c.download })));
  const how = (auto: boolean, cap: number) => (c.lean ? t("diag.conc.lean") : auto ? t("diag.conc.auto", { max: cap }) : t("diag.conc.fixed"));
  $("diag-conc-now").textContent = t("diag.conc.now2", { up: c.upload, upHow: how(c.auto, c.capUp), down: c.download, downHow: how(c.autoDown, c.capDown), ch: c.channels });
  // Above ~2 × channels Discord's per-channel limit (~30 pieces/min) answers 429: more in flight gains nothing.
  const over = c.upload > 2 * c.channels && !c.auto;
  $("diag-conc-warn").hidden = !over;
  if (over) ui("diag-conc-warn-t").textContent = t("diag.conc.warn", { n: c.upload, ch: c.channels, max: 2 * c.channels });
}
/** Settings → Network & transfers (save data, guard, pieces in flight). */
function renderNetwork() {
  void paintConcurrency();
  void core.netStatus().then(paintNetSettings, () => null);
  paintSpeedIntro();
}

// ── Speed test (Settings → Network & transfers) ──
const SPEED_KEY = "ddn.speed.history";
const speedHistory = (): SpeedTestResult[] => {
  try {
    return (JSON.parse(localStorage.getItem(SPEED_KEY) ?? "[]") as SpeedTestResult[]).slice(0, 5);
  } catch {
    return [];
  }
};
function speedOpts() {
  const n = (sel: string, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, Math.round(Number($<HTMLInputElement>(sel).value) || d)));
  return { count: n("speed-count", 4, 200, 32), sizeMb: n("speed-size", 1, 24, 10), noLine: $<HTMLInputElement>("speed-noline").checked, only: $<HTMLInputElement>("speed-uponly").checked ? ("up" as const) : undefined };
}
function paintSpeedIntro() {
  const o = speedOpts();
  const total = fmtSize(o.count * o.sizeMb * 1024 * 1024 * (o.only ? 1 : 2) + (o.noLine ? 0 : 400e6));
  $("speed-lead").textContent = t("sp.lead", { n: o.count, mb: o.sizeMb, total });
  // e2ee / plain: pieces go through the instance; only the line is measured (the Discord options do not apply).
  $("speed-adv").hidden = __DDN_MODE__ !== "metadata-only";
  void core.netStatus().then((st) => ($("speed-metered").hidden = !st?.leanWhy), () => null);
  paintSpeedHistory();
}
const spf = (v: number | null | undefined) => (v == null ? "—" : fmtNum(Math.round(v * 10) / 10));
function paintSpeedProgress(p: SpeedTestProgress) {
  const stage = t(`sp.stage.${p.stage}`);
  const mbps = spf(p.mbps);
  $("speed-live").textContent =
    p.stage === "cleanup"
      ? `${stage}: ${p.bytes} / ${p.total}`
      : p.total
        ? t("sp.liveN", { stage, done: fmtSize(p.bytes), total: fmtSize(p.total), mbps, inflight: p.inFlight ?? 0 })
        : t("sp.live", { stage, mbps });
}
/** The result as text (the Copy button; one line per value, no addresses or tokens). */
function speedResultText(r: SpeedTestResult): string {
  const d = r.discord;
  return [
    `discordrive speed test ${new Date(r.at).toISOString()} · ${t(`sp.where.${r.platform === "desktop" ? "desktop" : "web"}`)} · ${r.build ?? "?"}`,
    r.line ? `${t("sp.line")}: ${t("sp.lineV", { d: spf(r.line.down), u: spf(r.line.up) })}` : "",
    d.up != null ? `${t("sp.discordUp")}: ${spf(d.up)} MB/s${d.upShare != null ? ` (${t("sp.ofLine", { p: Math.round(d.upShare * 100) })})` : ""}` : "",
    d.down != null ? `${t("sp.discordDown")}: ${spf(d.down)} MB/s${d.downShare != null ? ` (${t("sp.ofLine", { p: Math.round(d.downShare * 100) })})` : ""}` : "",
    ...(d.fragments > 0 ? [`${t("sp.channels")}: ${d.channels} · ${d.fragments} × ${fmtSize(d.fragmentBytes)}`, `${t("sp.conc")}: ${concText(r)}`, `${t("sp.problems")}: ${d.rateLimited} / ${d.errors}`] : []),
    ...r.hints.map(hintText),
  ].filter(Boolean).join("\n");
}
function concText(r: SpeedTestResult): string {
  const d = r.discord;
  const how = (c: { auto: boolean; max: number }) => (c.auto ? t("sp.auto", { n: c.max }) : t("sp.fixed"));
  return t("sp.concV", { up: d.concUp.start, upMode: how(d.concUp), down: d.concDown.start, downMode: how(d.concDown) });
}
function hintText(h: SpeedTestResult["hints"][number]): string {
  switch (h.k) {
    case "channels":
      return t("sp.hint.channels", { per: spf(h.perChannel) });
    case "browser-h3":
      return t("sp.hint.browser-h3", { down: spf(h.down) });
    case "line-full":
      return t("sp.hint.line-full", { dir: t(`sp.dir.${h.dir}`), p: Math.round(h.share * 100) });
    case "rate-limited":
      return t("sp.hint.rate-limited", { n: h.n });
    case "errors":
      return t("sp.hint.errors", { n: h.n });
    case "metered":
      return t("sp.hint.metered");
  }
}
function paintSpeedResult(r: SpeedTestResult) {
  const d = r.discord;
  const row = (k: string, v: string | (Node | string)[], dd?: string, ...more: Node[]) => h("div", { "data-ddn": `speed-${dd ?? k}` }, h("dt", { class: "label-mono" }, t(k)), h("dd", {}, h("span", { class: "val mono" }, ...(typeof v === "string" ? [v] : v)), ...more));
  // A Discord speed: the number and its unit apart (the number is the big one; the unit's place comes from the locale).
  const mbps = (v: number) => {
    const [pre = "", post = ""] = t("sp.mbps", { v: "\u0000" }).split("\u0000");
    return [pre, h("span", { class: "num" }, spf(v)), h("span", { class: "unit" }, post)] as (Node | string)[];
  };
  // The share of the line under it: words + a bar.
  const share = (x: number | null) => {
    if (x == null) return [];
    const p = Math.round(x * 100);
    return [h("span", { class: "share" }, t("sp.ofLine", { p })), h("span", { class: "share-bar", style: `--p:${Math.min(100, Math.max(0, p))}%`, "aria-hidden": "true" })];
  };
  $("speed-result").replaceChildren(
    ...(r.line ? [row("sp.line", t("sp.lineV", { d: spf(r.line.down), u: spf(r.line.up) }), "line")] : []),
    ...(d.up != null ? [row("sp.discordUp", mbps(d.up), "up", ...share(d.upShare))] : []),
    ...(d.down != null ? [row("sp.discordDown", mbps(d.down), "down", ...share(d.downShare))] : []),
    // Only the line measured (e2ee / plain, or the Discord part could not run): no Discord rows of zeros.
    ...(d.fragments > 0
      ? [row("sp.channels", `${d.channels} · ${d.fragments} × ${fmtSize(d.fragmentBytes)}`, "channels"), row("sp.conc", concText(r), "conc"), row("sp.problems", `${d.rateLimited} / ${d.errors}`, "problems")]
      : []),
    row("sp.build", `${r.build ?? "?"} · ${t(`sp.where.${r.platform === "desktop" ? "desktop" : "web"}`)} · ${fmtDateTime(r.at)}`, "build"),
  );
  $("speed-hints").replaceChildren(...r.hints.map((x) => h("li", { "data-ddn": "speed-hint", "data-k": x.k }, hintText(x))), ...(d.leftOver ? [h("li", {}, t("sp.leftover", { n: d.leftOver }))] : []));
  $("speed-card").hidden = false;
  // The result where the user looks: the card scrolled into view (it opens below the fold in a usual window).
  $("speed-card").scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("speed-copy").onclick = () => void copy(speedResultText(r), t("sp.copied"));
}
// Tests (check.ts): the rows a result card would show, without running a test.
(window as unknown as { ddnSpeedCardRows(r: SpeedTestResult): string[] }).ddnSpeedCardRows = (r) => {
  paintSpeedResult(r);
  const rows = [...document.querySelectorAll<HTMLElement>("[data-ddn=speed-result] > [data-ddn]")].map((e) => e.dataset.ddn!.replace(/^speed-/, ""));
  $("speed-card").hidden = true;
  return rows;
};
function paintSpeedHistory() {
  const hs = speedHistory();
  $("speed-history-box").hidden = hs.length === 0;
  $("speed-history").replaceChildren(
    ...hs.map((r) => h("li", { "data-ddn": "speed-history-row" }, h("span", { class: "dname mono" }, `${fmtDateTime(r.at)} · ↑ ${spf(r.discord.up)} ↓ ${spf(r.discord.down)} MB/s${r.line ? ` · ${t("sp.line")} ↓ ${spf(r.line.down)} ↑ ${spf(r.line.up)}` : ""}`), h("span", { class: "when" }, `${r.discord.channels} ch · ${r.build ?? ""}`))),
  );
}
function wireSpeedTest() {
  for (const k of ["speed-count", "speed-size", "speed-noline", "speed-uponly"]) $(k).addEventListener("change", paintSpeedIntro);
  $("speed-cancel").onclick = () => void core.speedTestCancel();
  $("speed-run").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const o = speedOpts();
      const st = await core.netStatus().catch(() => null);
      if (st?.leanWhy) {
        const total = fmtSize(o.count * o.sizeMb * 1024 * 1024 * (o.only ? 1 : 2) + (o.noLine ? 0 : 400e6));
        if (!(await confirmDanger(t("sp.h"), t("sp.meteredAsk", { total }), t("sp.run")))) return;
      }
      $("speed-run").hidden = true;
      $("speed-cancel").hidden = false;
      $("speed-state").textContent = t("sp.running");
      // The progress line in view (the button may sit low in a short window).
      $("speed-live").scrollIntoView({ block: "nearest", behavior: "smooth" });
      $("speed-state").className = "chip chip--accent";
      $("speed-card").hidden = true;
      try {
        const r = await core.speedTest(o);
        $("speed-live").textContent = "";
        $("speed-state").textContent = t("sp.done");
        $("speed-state").className = "chip chip--success";
        paintSpeedResult(r);
        try {
          localStorage.setItem(SPEED_KEY, JSON.stringify([r, ...speedHistory()].slice(0, 5)));
        } catch {
          /* private mode */
        }
        paintSpeedHistory();
      } catch (err) {
        const aborted = /abort/i.test(String((err as Error)?.message ?? err));
        $("speed-state").textContent = "";
        $("speed-live").textContent = aborted ? t("sp.cancelled") : errText(err);
        if (!aborted) throw err;
      } finally {
        $("speed-run").hidden = false;
        $("speed-cancel").hidden = true;
      }
    });
}
/** The agent's reasons for a disk that did not mount, in the UI's language where known. */
function vdiskWhy(why: string): string {
  if (/^restart the app/.test(why)) return t("app.vdisk.why.restart");
  if (/still mounted by an earlier run/.test(why)) return t("app.vdisk.why.stale", { cmd: why.match(/"([^"]+)"/)?.[1] ?? "fusermount3 -u -z ~/discordrive" });
  if (/system refused the mount/.test(why)) return t("app.vdisk.why.refused");
  if (/is not empty/.test(why)) return t("app.vdisk.why.notEmpty");
  return why;
}
/** Settings → Desktop app (only in the desktop app): version and updates, autostart, downloads folder, key storage. */
async function renderDesktopApp() {
  if (!desktop) return;
  $("app-section").hidden = false;
  // "About this browser" (tab, local copy in the browser) is for the web app; the desktop app has its card.
  $("browser-section").hidden = true;
  const [st, caps] = await Promise.all([desktop.updates.settings(), core.capabilities()]);
  $<HTMLInputElement>("app-check-updates").checked = st.checkUpdates;
  $<HTMLInputElement>("app-autostart").checked = st.autostart;
  $("app-downloads").textContent = st.downloadsDir;
  $("app-keys-warn").hidden = caps.keyProtection !== "file";
  // Linux: the keyring switch (off = the user refused it at the start; on = used from the next start).
  $("app-keyring-row").hidden = st.platform !== "linux";
  $<HTMLInputElement>("app-keyring").checked = st.keyring !== "file";
  // Linux: the disk in the system (off by default); unavailable without FUSE (the reason in words).
  const vd = st.vdisk;
  $("app-vdisk-row").hidden = !vd;
  $("app-vdisk-cache-row").hidden = !vd;
  $("app-vdisk-write-row").hidden = !vd || !vd.on || !!vd.unavailable;
  if (vd) {
    const sw = $<HTMLInputElement>("app-vdisk");
    sw.checked = vd.on;
    sw.disabled = !!vd.unavailable;
    $<HTMLInputElement>("app-vdisk-cache").value = String(vd.cacheGb);
    $<HTMLInputElement>("app-vdisk-write").checked = vd.write === true;
    // Files copied into the disk that are still being uploaded: how many and how far (safe to switch off?).
    const q = vd.queue;
    $("app-vdisk-write-hint").textContent = q && q.left > 0 ? tn("app.vdisk.queue", q.left, { done: fmt(q.done), total: fmt(q.total) }) : t("app.vdisk.write.hint");
    if (q && q.left > 0) setTimeout(() => void renderDesktopApp(), 2000);
    const stateText = vd.state === "mounted" ? t("app.vdisk.mounted", { dir: vd.mountpoint }) : vd.state === "mounting" || vd.state === "restarting" || vd.state === "off" ? t("app.vdisk.mounting") : t("app.vdisk.failed", { why: vdiskWhy(vd.state.replace(/^error: /, "")) });
    $("app-vdisk-hint").textContent = vd.unavailable ? t("app.vdisk.unavailable", { why: vd.unavailable }) : vd.on ? stateText : t("app.vdisk.off");
    // Mounting takes a moment: the state again shortly (until it is mounted or failed).
    if (vd.on && !vd.unavailable && vd.state !== "mounted" && !/^error/.test(vd.state)) setTimeout(() => void renderDesktopApp(), 1500);
  }
  // Not awaited: the check asks GitHub, and a slow or hanging network must not hold up the page (every later
  // render, a tab change too, waits for this one).
  void paintUpdate(false);
}
async function paintUpdate(manual: boolean) {
  if (!desktop) return;
  if (manual) $("app-version").textContent = t("app.checking");
  const u = await desktop.updates.check().catch(() => null);
  if (!u) return;
  $("app-version").textContent = t("app.version", { v: u.current.version, build: u.current.build }) + (manual && !u.available ? ` · ${t("app.none")}` : "");
  const has = !!u.available;
  $("app-update").hidden = !has;
  $("app-update-chip").hidden = !has;
  $("app-download").hidden = !has;
  if (u.available) {
    const txt = $("app-update-text");
    txt.textContent = t("app.new", { build: u.available.build || u.available.commit.slice(0, 7), date: u.available.publishedAt ? fmtDate(Date.parse(u.available.publishedAt), {}) : "" }) + " ";
    // What changed: the commits between this copy and the new build (opens in the system browser).
    const href = u.current.commit ? `https://github.com/Magiszonekk/discordrive/compare/${u.current.commit}...${u.available.commit}` : u.available.htmlUrl;
    if (href) txt.append(h("a", { href, target: "_blank", rel: "noopener", "data-ddn": "app-changes" }, t("app.changes")));
  }
}
function wireDesktopApp() {
  if (!desktop) return;
  const d = desktop;
  $("app-check").onclick = (e) => void act(e.currentTarget as HTMLElement, () => paintUpdate(true));
  // Download progress (~100 MB with no sign of life looks like a hang).
  d.updates.onProgress?.((p) => {
    const hint = $("app-update-hint");
    hint.hidden = false;
    hint.textContent = t("app.downloading", { done: fmtSize(p.done), total: fmtSize(p.total), p: p.total ? Math.floor((p.done / p.total) * 100) : 0 });
  });
  $("app-download").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const r = await d.updates.download();
      const hint = $("app-update-hint");
      hint.textContent = t("app.downloaded", { path: r.path, hint: r.hint }) + (r.busy ? ` ${t("app.busy")}` : "");
      hint.hidden = false;
      const open = $("app-open");
      open.hidden = false;
      const install = d.updates.install;
      // Windows / AppImage: the app installs it in place and restarts; otherwise the user opens the file.
      const inPlace = !!(r.inPlace && install);
      open.dataset.i18n = inPlace ? "app.install" : "app.open";
      open.textContent = t(open.dataset.i18n);
      open.onclick = inPlace ? (ev) => void act(ev.currentTarget as HTMLElement, () => install!()) : () => d.updates.open(r.path);
      // A .deb without pkexec: the terminal command to copy (opening the file starts App Center, which refuses it).
      if (!inPlace && r.command) {
        open.dataset.i18n = "app.copyCmd";
        open.textContent = t("app.copyCmd");
        open.onclick = (ev) => void act(ev.currentTarget as HTMLElement, async () => (await writeClipboard(r.command!), toast(t("app.copied"))));
      }
    });
  $<HTMLInputElement>("app-check-updates").onchange = (e) => void d.updates.settings({ checkUpdates: (e.currentTarget as HTMLInputElement).checked });
  $<HTMLInputElement>("app-autostart").onchange = (e) => void d.updates.settings({ autostart: (e.currentTarget as HTMLInputElement).checked });
  $<HTMLInputElement>("app-vdisk-write").onchange = (e) => void d.updates.settings({ vdiskWrite: (e.currentTarget as HTMLInputElement).checked }).then(() => renderDesktopApp());
  $<HTMLInputElement>("app-vdisk").onchange = (e) => void d.updates.settings({ vdisk: (e.currentTarget as HTMLInputElement).checked }).then(() => renderDesktopApp());
  $<HTMLInputElement>("app-vdisk-cache").onchange = (e) => {
    const gb = Math.max(1, Math.min(10_000, Math.round(Number((e.currentTarget as HTMLInputElement).value) || 10)));
    void d.updates.settings({ vdiskCacheGb: gb }).then(() => renderDesktopApp());
  };
  $<HTMLInputElement>("app-keyring").onchange = (e) =>
    void d.updates.settings({ keyring: (e.currentTarget as HTMLInputElement).checked ? "ask" : "file" }).then(() => toast(t("app.keyringNext"), "info"));
  $("app-downloads-pick").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const dir = await d.pickFolder();
      if (dir) $("app-downloads").textContent = (await d.updates.settings({ downloadsDir: dir })).downloadsDir;
    });
}

async function renderDiagnostics() {
  renderNetwork();
  const st = await core.transferLogStatus().catch(() => null);
  if (!st) return;
  $<HTMLInputElement>("diag-log").checked = st.on;
  $<HTMLInputElement>("diag-names").checked = st.names;
  $<HTMLInputElement>("diag-names").disabled = !st.on;
  $("diag-state").textContent = st.on ? t("diag.on") : t("diag.off");
  $("diag-state").className = `chip${st.on ? " chip--accent" : ""}`;
  const parts = [t("diag.size", { size: fmt(st.bytes) }), st.where === "memory" ? t("diag.memory") : ""];
  if (st.server) parts.push(st.server.all ? t("diag.serverAll") : st.server.on ? t("diag.serverOn") : t("diag.serverOff"));
  $("diag-info").textContent = parts.filter(Boolean).join(" ");
  const b = await core.buildInfo().catch(() => null);
  // The same sources (hash and commit after "+"): the same build, whatever version number the package carries
  // (the desktop app's 0.1.x, an instance's 0.2.x). Different: the page is older than the instance (a reload
  // in a browser; the desktop app updates itself instead).
  const src = (x: string) => x.split("+")[1] ?? x;
  if (b) $("diag-version").textContent = b.server && src(b.server) !== src(b.app) ? t(desktop ? "diag.version2Desktop" : "diag.version2", { app: b.app, server: b.server }) : t("diag.version", { app: b.app });
}
function wireDiagnostics() {
  const box = $<HTMLInputElement>("diag-log");
  const names = $<HTMLInputElement>("diag-names");
  const apply = () =>
    void act(null, async () => {
      storeTransferLog(box.checked, box.checked && names.checked);
      await core.setTransferLog(box.checked, box.checked && names.checked);
      await renderDiagnostics();
    });
  box.onchange = apply;
  names.onchange = apply;
  const conc = () =>
    void act(null, async () => {
      const n = (v: string) => (v.trim() ? Math.max(1, Math.min(64, Math.round(Number(v)) || 0)) : null);
      const c = { upload: n($<HTMLInputElement>("diag-conc-up").value), download: n($<HTMLInputElement>("diag-conc-down").value) };
      try {
        localStorage.setItem(CONC_KEY, JSON.stringify(c));
      } catch {
        /* private mode */
      }
      await core.setConcurrency(c.upload, c.download);
      await paintConcurrency();
    });
  $("diag-conc-up").onchange = conc;
  $("diag-conc-down").onchange = conc;
  $("diag-download").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const f = await core.transferLogFile();
      if (!f.lines) return toast(t("diag.empty"), "info");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f.data);
      a.download = `discordrive-transfers-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl${f.gz ? ".gz" : ""}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      toast(t("diag.downloaded", { n: fmtNum(f.lines) }));
    });
  $("diag-clear").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      const r = await core.clearTransferLog();
      await renderDiagnostics();
      toast(r?.kept ? t("diag.clearedKept", { n: r.kept }) : t("diag.cleared"));
    });
}

// ── Settings → Security: optional password-protected account key ──
let pwEnabled = false;
async function renderSecurity() {
  const st = await core.passwordKeyStatus().catch(() => null);
  if (!st) return;
  pwEnabled = st.enabled;
  $("pw-state").textContent = st.enabled ? t("pw.state.on") : t("pw.state.off");
  $("pw-state").className = `chip${st.enabled ? " chip--success" : ""}`;
  $("pw-current").hidden = !st.enabled;
  $("pw-current").textContent = st.enabled ? t("pw.current", { login: st.login ?? "", date: st.updatedAt ? fmtDate(st.updatedAt) : "" }) : "";
  const login = $<HTMLInputElement>("pw-login");
  if (st.enabled && !login.value) login.value = st.login ?? "";
  $("pw-save").textContent = t(st.enabled ? "pw.change" : "pw.on");
  $("pw-off").hidden = !st.enabled;
}
function paintStrength() {
  const pw = $<HTMLInputElement>("pw-password").value;
  void core.passwordStrength(pw).then((r) => {
    $("pw-strength").dataset.score = String(pw ? r.score + 1 : 0);
    ui("pw-strength-t").textContent = pw ? t(`pw.s${r.score}`) : "";
  });
}
async function renderAi() {
  const got = await core.aiSettings().catch(() => undefined);
  if (got === undefined) return;
  const unsupported = got === "unsupported";
  $("ai-sec").querySelector<HTMLFormElement>("form")!.hidden = unsupported;
  $("ai-unsupported").hidden = !unsupported;
  const st = unsupported ? null : got;
  $("ai-state").textContent = st ? t("ai.state.on") : t("ai.state.off");
  $("ai-state").className = `chip${st ? " chip--success" : ""}`;
  $<HTMLInputElement>("ai-url").value = st?.url ?? "";
  $<HTMLInputElement>("ai-model").value = st?.model ?? "";
  $<HTMLInputElement>("ai-key").value = "";
  $("ai-key-hint").textContent = st?.hasKey ? t("ai.key.kept") : "";
  $("ai-off").hidden = !st;
}

function wireAi() {
  ui<HTMLFormElement>("ai-form").onsubmit = (e) => {
    e.preventDefault();
    void act($("ai-save"), async () => {
      const url = $<HTMLInputElement>("ai-url").value.trim();
      const model = $<HTMLInputElement>("ai-model").value.trim();
      if (!/^https?:\/\/\S+$/.test(url)) throw new Error(t("ai.err.url"));
      if (!model) throw new Error(t("ai.err.model"));
      await core.setAiSettings({ url, model, key: $<HTMLInputElement>("ai-key").value });
      await renderAi();
      toast(t("ai.saved"));
    });
  };
  $("ai-off").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      await core.setAiSettings(null);
      await renderAi();
      toast(t("ai.removed"));
    });
}

function wireSecurity() {
  $<HTMLInputElement>("pw-password").oninput = () => paintStrength();
  ui<HTMLFormElement>("pw-form").onsubmit = (e) => {
    e.preventDefault();
    void act($("pw-save"), async () => {
      const login = $<HTMLInputElement>("pw-login").value.trim();
      const pw = $<HTMLInputElement>("pw-password").value;
      if (!/^[\p{L}\p{N}._+@-]{3,64}$/u.test(login)) throw new Error(t("pw.err.login"));
      if (pw.length < 10) throw new Error(t("pw.err.short"));
      if (pw !== $<HTMLInputElement>("pw-password2").value) throw new Error(t("pw.err.repeat"));
      if (!$<HTMLInputElement>("pw-ack").checked) throw new Error(t("pw.err.ack"));
      const was = pwEnabled;
      await core.setPasswordKey(login, pw);
      for (const id of ["pw-password", "pw-password2"]) $<HTMLInputElement>(id).value = "";
      $<HTMLInputElement>("pw-ack").checked = false;
      paintStrength();
      await renderSecurity();
      toast(t(was ? "pw.changed" : "pw.enabled"));
    });
  };
  $("pw-off").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      if (!(await confirmDanger(t("pw.off.h"), t("pw.off.q"), t("pw.off")))) return;
      await core.removePasswordKey();
      $<HTMLInputElement>("pw-login").value = "";
      await renderSecurity();
      toast(t("pw.disabled"));
    });
}

// ── Trash page ──────────────────────────────────────────────────────
function trashRow(x: TrashRow, i: number) {
  const tr = h("tr", { class: "reveal", style: `--i:${Math.min(i, 12)}`, "data-ddn": "trash-row", "data-id": x.id });
  trashData.set(tr, x);
  const days = Math.max(0, Math.ceil((x.purgeAt - Date.now()) / 86_400_000));
  const where = x.from === null ? "" : x.fromRecovered ? t("nav.recovered") + (x.from.length > 1 ? " / " + x.from.slice(1).join(" / ") : "") : x.from.length ? x.from.join(" / ") : t("files.root");
  const [, label, tone] = x.kind === "file" ? typeOf(x.name) : [null, "", ""];
  const lead = x.kind === "folder" ? icon("folder") : h("span", { class: `badge ${tone}` }, label);
  const name = h(
    "td",
    { class: "c-name" },
    h("span", { class: "nm" }, lead, h("span", { title: x.name }, x.name)),
    // Phone: the date column is hidden, so the sub-line carries the days left too.
    h("span", { class: "sub" }, [x.kind === "file" ? fmt(x.size) : t("files.folder"), t("trash.from", { path: where }), tn("trash.left", days)].filter(Boolean).join(" · ")),
  );
  const left = h("span", { class: `chip${days <= 3 ? " chip--warning" : ""}`, "data-ddn": "trash-left", title: fmtDate(x.purgeAt) }, tn("trash.left", days));
  const restore = h("button", { class: "btn sm", type: "button", "data-ddn": "trash-restore", "aria-label": t("trash.restore.aria", { name: x.name }), title: t("trash.restore") }, icon("restore"), h("span", { class: "lbl-md" }, t("trash.restore")));
  restore.onclick = () => void act(restore, () => restoreOne(x));
  const del = h("button", { class: "iconbtn danger quiet", type: "button", "data-ddn": "trash-purge", "aria-label": t("trash.purge.aria", { name: x.name }), title: t("trash.purge") }, icon("x"));
  del.onclick = () => void act(del, () => purgeOne(x));
  tr.append(
    name,
    h("td", { class: "size" }, x.kind === "file" ? fmt(x.size) : ""),
    h("td", { class: "c-date" }, fmtDate(x.trashedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
    h("td", { class: "c-left" }, left),
    h("td", { class: "c-acts" }, h("span", { class: "acts" }, restore, del)),
  );
  return tr;
}
async function restoreOne(x: TrashRow) {
  const r = await core.restore([x.id]);
  await render();
  report(r, t("trash.restored", { name: x.name }));
}
async function purgeOne(x: TrashRow) {
  if (!(await confirmDanger(t("trash.purge.h"), t("trash.purge.q", { name: x.name }), t("trash.purge")))) return;
  const r = await core.purge([x.id]);
  await render();
  report(r, t("trash.purged", { name: x.name }));
}
async function emptyTrashAsk() {
  const n = (await core.trashList()).length;
  if (!n) return;
  if (!(await confirmDanger(t("trash.emptyQ.h"), tn("trash.emptyQ", n), t("trash.empty")))) return;
  const r = await core.emptyTrash();
  await render();
  report(r, t("trash.emptied"));
}
let trashShown = false;
async function renderTrash() {
  const list = await core.trashList();
  const enter = !trashShown;
  trashShown = true;
  const hadFocus = $("trash-list").contains(document.activeElement) ? focusKey(document.activeElement) : null;
  queueMicrotask(() => refocus(hadFocus));
  $("trash-list").replaceChildren(...list.map((x, i) => (enter ? trashRow(x, i) : (() => {
    const r = trashRow(x, i);
    r.classList.remove("reveal");
    return r;
  })())));
  ui("trash-none").hidden = list.length > 0;
  $<HTMLButtonElement>("trash-empty").disabled = list.length === 0;
  ui("trash-meta").textContent = list.length ? [tn("files.count", list.length), fmt(list.reduce((s0, x) => s0 + (x.size ?? 0), 0))].join(" · ") : "";
}
function wireTrash() {
  $("trash-empty").onclick = (e) => void act(e.currentTarget as HTMLElement, () => emptyTrashAsk());
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Mac/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : t("browser.generic");
  return os ? t("device.on", { browser: br, os }) : br;
}

async function copy(text: string, done: string) {
  try {
    await writeClipboard(text);
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
let kitReminded = false;
async function openKit(forced: boolean, renew = false) {
  const d = $<HTMLDialogElement>("kit-dialog");
  // Renders come in bursts (upload progress, websocket): open the forced kit once.
  if (d.open || kitOpening || (forced && !renew && kitConfirmed)) return;
  kitOpening = true;
  let got: { kit: string; accountId: string };
  try {
    got = await core.rescueKit();
    if (forced && !renew && (kitConfirmed || (await core.status()).kitSaved)) return;
  } finally {
    kitOpening = false;
  }
  if (d.open) return;
  const { kit, accountId } = got;
  $("kit-renew").hidden = !renew;
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
/**
 * Webhook URLs found in pasted text: one per line, or separated by spaces/commas/semicolons, or glued
 * together (a password field drops line breaks on paste). Deduplicated, in the order they were pasted.
 */
const WEBHOOK_RE = /https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+/g;
export function webhookUrlsIn(text: string): string[] {
  return [...new Set(text.match(WEBHOOK_RE) ?? [])];
}

function wireHooks() {
  const input = $<HTMLInputElement>("webhook-url");
  // Several addresses pasted at once (e.g. 10 lines copied together) are kept from the clipboard
  // text itself, because a password input removes the line breaks.
  let pasted: string[] = [];
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    const urls = webhookUrlsIn(text);
    if (urls.length > 1) {
      e.preventDefault();
      pasted = urls;
      input.value = urls.join(" ");
      toast(tn("hooks.pastedMany", urls.length), "info");
    } else pasted = [];
  });
  input.addEventListener("input", () => {
    if (pasted.length && input.value !== pasted.join(" ")) pasted = [];
  });
  $("add-webhook").onclick = (e) =>
    void act(e.currentTarget as HTMLElement, async () => {
      if (!input.value.trim()) throw new Error(t("hooks.pasteFirst"));
      const urls = pasted.length ? pasted : webhookUrlsIn(input.value);
      if (urls.length <= 1) {
        await core.addWebhook(urls[0] ?? input.value);
        input.value = "";
        pasted = [];
        await render();
        toast(t("hooks.added"));
        return;
      }
      // One at a time: each is checked with Discord (GET webhook) and stored in the vault (CAS).
      const failed: string[] = [];
      let ok = 0;
      for (const [i, url] of urls.entries()) {
        toast(t("hooks.addingMany", { i: i + 1, n: urls.length }), "info");
        try {
          await core.addWebhook(url);
          ok++;
        } catch (err) {
          failed.push(`${i + 1}: ${errText(err)}`);
        }
      }
      pasted = failed.length ? urls.filter((_, i) => failed.some((f) => f.startsWith(`${i + 1}:`))) : [];
      input.value = pasted.join(" ");
      await render();
      if (ok) toast(tn("hooks.addedMany", ok), "ok");
      if (failed.length) toast(t("hooks.addedManyFailed", { n: failed.length, list: failed.join("; ") }), "err");
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
      // Desktop, "This computer only": the first account is the only one; the built-in instance closes sign-up.
      if (cfg.desktop?.local) await desktop?.firstAccountMade();
      await core.open();
      await applyTransferLog();
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
      await applyTransferLog();
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
      await applyTransferLog();
      navigate("/", true);
      toast(t("rescueD.done"));
    });
  $<HTMLInputElement>("rescue-name").value ||= defaultDeviceName();
  $<HTMLInputElement>("signin-name").value ||= defaultDeviceName();
  ui<HTMLFormElement>("signin-form").onsubmit = (e) => {
    e.preventDefault();
    void act($("signin-go"), async () => {
      await core.joinWithPassword(server(), $<HTMLInputElement>("signin-login").value, $<HTMLInputElement>("signin-password").value, $<HTMLInputElement>("signin-name").value.trim() || defaultDeviceName());
      $<HTMLInputElement>("signin-password").value = "";
      await core.open();
      await applyTransferLog();
      navigate("/", true);
      toast(t("signin.done"));
    });
  };
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
type Accent = { get(): string; set(v: string): void; presets: { name: string; accent: string }[] };
const ddnAccent = () => (window as unknown as { ddnAccent?: Accent }).ddnAccent ?? null;
/** Settings -> Appearance: accent presets and a custom colour (cobalt/theme.js applies and keeps it). */
function paintAccent() {
  const a = ddnAccent();
  const box = $("accent");
  if (!a || !box) return;
  if (!box.childElementCount) {
    for (const p of a.presets) {
      const b = h("button", { type: "button", role: "radio", class: "swatch", "data-accent": p.name, style: `--sw:${p.accent}` }, h("span", { class: "dot" }), h("span", { class: "sw-l" }, ""));
      b.onclick = () => (a.set(p.name), paintAccent());
      box.append(b);
    }
    const pick = h("input", { type: "color", "data-ddn": "accent-custom" }) as HTMLInputElement;
    pick.oninput = () => (a.set(pick.value), paintAccent());
    box.append(h("label", { class: "swatch custom", "data-accent": "custom" }, pick, h("span", { class: "sw-l", "data-i18n": "accent.custom" }, "")));
  }
  const cur = a.get();
  box.querySelectorAll<HTMLElement>("[data-accent]").forEach((b) => {
    const name = b.dataset.accent!;
    const on = name === "custom" ? /^#/.test(cur) : name === cur;
    b.setAttribute("aria-checked", String(on));
    const l = b.querySelector<HTMLElement>(".sw-l");
    if (l) l.textContent = t(`accent.${name}`);
    if (name !== "custom") b.setAttribute("aria-label", t(`accent.${name}`));
  });
  if (/^#/.test(cur)) box.querySelector<HTMLInputElement>("[data-ddn=accent-custom]")!.value = cur;
}

function wireTheme() {
  paintAccent();
  document.addEventListener("ddn-accent", () => paintAccent());
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
  // Desktop: downloads go straight to disk through the agent; no service worker is needed (or allowed: app://).
  if ("serviceWorker" in navigator && !desktop) {
    await navigator.serviceWorker.register("./sw.js").catch(() => {});
    // /w/ (the app worker) under its own fetch-less service worker: see src/w-sw.ts. The app worker starts
    // above before this registration exists on a first visit; it is only slower then, never wrong.
    await navigator.serviceWorker.register("./w/sw.js", { scope: "./w/" }).catch(() => {});
  }
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
  const pre = new URLSearchParams(location.search).get("invite") ?? cfg.desktop?.invite;
  if (pre) $<HTMLInputElement>("invite").value = pre;
  // Desktop, "This computer only": the one-shot code of the first account is filled in by the app.
  if (cfg.desktop?.local) ui("invite-field").hidden = true;
  if (!(await ed25519Supported())) showOldBrowser();
  features = await core.features();
  await core.setShowUnavailable(storedShowUnavailable());
  wireSearch();
  wireDesktopApp();
  wireSignedOut(server);
  wireKit();
  wireHooks();
  channelsUi.wire();
  wireFilesPage();
  wireDevices();
  wireRowMenu();
  wireRename();
  wireMove();
  wireSelection();
  wireTrash();
  wireStorage();
  wireDiagnostics();
  wireNet();
  wireSpeedTest();
  wireSecurity();
  wireAi();
  adminUi.wire();
  // Desktop: the agent uploads and downloads, also with the window closed (the browser notes speak of a tab).
  if (desktop) {
    document.querySelector<HTMLElement>('[data-i18n="queue.note"]')!.dataset.i18n = "queue.noteDesktop";
    document.querySelector<HTMLElement>('[data-i18n="dl.note"]')!.dataset.i18n = "dl.noteDesktop";
    applyStatic(document);
  }
  $("auth-lost-retry").onclick = () =>
    void act($("auth-lost-retry"), async () => {
      if (!(await core.retryAuth())) toast(t("lost.still"), "err");
      myAccount = null;
      await render();
    });
  $("auth-lost-forget").onclick = () =>
    void act($("auth-lost-forget"), async () => {
      if (!(await confirmDanger(t("lost.forget"), t("lost.forget.t"), t("lost.forget.yes")))) return;
      await core.forgetThisBrowser();
      // Thumbnails are pictures of the files: they go with the account's data on this browser.
      if (typeof caches !== "undefined") await caches.delete(THUMB_CACHE).catch(() => false);
      for (const u of thumbs.values()) void u.then((x) => x && URL.revokeObjectURL(x));
      thumbs.clear();
      myAccount = null;
      isAdmin = false;
      navigate("/", true);
    });
  $("dl-close").onclick = () => closeDownloads();
  $("share-copy").onclick = () => void copy($<HTMLTextAreaElement>("share-link").value, t("shareD.copied"));
  $("share-close").onclick = () => $<HTMLDialogElement>("share-dialog").close();
  $<HTMLDialogElement>("share-dialog").addEventListener("close", () => {
    if (route.name === "settings") void renderShares();
  });
  ui("player-close").onclick = () => closePlayer();
  ui<HTMLDialogElement>("player-dialog").addEventListener("close", () => $<HTMLVideoElement>("player").pause());
  $("keys-locked-retry").onclick = () =>
    void act($("keys-locked-retry"), async () => {
      // The keyring asks again (unlock dialog). Desktop: the app asks the keyring itself; when it works now the
      // agent starts again with it and the window reloads.
      if (desktop?.keystoreRetry) {
        if (!(await desktop.keystoreRetry())) toast(t("locked.still"), "err");
        return;
      }
      const st = await core.status();
      if (st.keysLocked) return toast(t("locked.still"), "err");
      if (st.hasAccount) await core.open();
      await render();
    });
  if ((await core.status()).hasAccount) await act(null, () => core.open());
  await applyTransferLog();
  if ((await core.status()).signedIn) void paintUnfinished();
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
