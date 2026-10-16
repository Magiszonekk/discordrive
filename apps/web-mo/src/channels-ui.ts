// Settings → Channels & webhooks and Settings → Storage, as one
// module with a few hooks in ui.ts:
//  - the channel list: per channel files/size, chips Critical / Retired, a "Remove or retire" button;
//  - the remove dialog: the counted impact (files with pieces only there, by name, scrollable), three
//    options (retire = default, move and remove, remove anyway with an explicit acknowledgement); for a
//    critical channel only "move and remove", for the last active one none ("add another channel first");
//  - move progress (this tab in metadata only, the instance in e2ee/plain) with ETA, and the forced new
//    rescue kit after a critical move in metadata only;
//  - the section folds: folded by default when there are channels (summary in the heading), open when
//    there are none; the choice is kept in this browser;
//  - Storage totals (all files, trash, unavailable, Discord usage, per channel) and the
//    "Show unavailable files" switch (kept in this browser, default off).
// Look: existing Cobalt classes (list, chip, note, modal, ack, bar); the frontend profile polishes.
import type { ChannelRow, ChannelsView, MoveStatus, RemovalImpact } from "./modes/types.js";
import { fmtNum, fmtSize, t, tn } from "./i18n.js";
import type { connect } from "./rpc.js";

type Core = ReturnType<typeof connect>;

export interface ChannelsUiDeps {
  core: Core;
  mode: string;
  h: <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...kids: (Node | string)[]) => HTMLElementTagNameMap[K];
  icon: (name: string) => SVGElement;
  chip: (text: string, tone?: string, title?: string) => HTMLElement;
  act: (btn: HTMLElement | null, fn: () => Promise<unknown>) => Promise<void>;
  toast: (text: string, kind?: "ok" | "err" | "info") => void;
  render: () => Promise<void>;
  /** Forced rescue kit (after a critical move in metadata only). */
  openKit: (forced: boolean) => Promise<void>;
}

const FOLD_KEY = "ddn.channels.open";
export const SHOW_UNAVAILABLE_KEY = "ddn.show-unavailable";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`[data-ddn="${sel}"]`)!;
const ui = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`[data-ddn-ui="${sel}"]`)!;

/** "about 3 min" for ETAs. */
export function fmtEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "?";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 6) / 10} h`;
}

export function storedShowUnavailable(): boolean {
  try {
    return localStorage.getItem(SHOW_UNAVAILABLE_KEY) === "1";
  } catch {
    return false;
  }
}

export function createChannelsUi(d: ChannelsUiDeps) {
  const { core, h, icon, chip, act, toast } = d;
  const server = d.mode !== "metadata-only";
  let lastMove: MoveStatus | null = null;
  let kitAsked = false;

  // ── folding ─────────────────────────────────────────────────────
  const stored = (): boolean | null => {
    try {
      const v = localStorage.getItem(FOLD_KEY);
      return v === null ? null : v === "1";
    } catch {
      return null;
    }
  };
  function setOpen(open: boolean) {
    $("channels-toggle").setAttribute("aria-expanded", String(open));
    $("channels-body").hidden = !open;
  }
  function wireFold() {
    $("channels-toggle").onclick = () => {
      const open = $("channels-toggle").getAttribute("aria-expanded") !== "true";
      setOpen(open);
      try {
        localStorage.setItem(FOLD_KEY, open ? "1" : "0");
      } catch {
        /* private mode */
      }
    };
  }
  /** Folded by default when there are channels, open when there are none (wizard needs the form). */
  function paintFold(wh: ChannelsView, inWizard: boolean) {
    const n = wh.webhooks.length + (wh.pool && wh.using !== "own" ? wh.pool.channels : 0);
    const has = n > 0 || wh.advice.ok;
    $("channels-toggle").hidden = inWizard;
    if (inWizard || !has) return setOpen(true);
    setOpen(stored() ?? false);
  }

  // ── list ────────────────────────────────────────────────────────
  function summary(wh: ChannelsView): string {
    const retired = wh.webhooks.filter((w) => w.retired).length;
    const dead = wh.webhooks.filter((w) => w.alive === false).length;
    const parts = [tn("hooks.channels", wh.advice.channels)];
    if (!retired && !dead) parts.push(t("ch.sum.ok"));
    if (retired) parts.push(tn("ch.sum.retired", retired));
    if (dead) parts.push(tn("ch.sum.dead", dead));
    return parts.join(" · ");
  }

  function row(w: ChannelRow, removable: boolean): HTMLLIElement {
    const li = h("li", { "data-ddn": "channel-row", "data-id": w.id }, icon("hash"), h("span", { class: "dname", title: w.label }, w.label || "webhook"));
    if (w.critical) {
      const c = chip(t("ch.critical"), "accent", `${t("ch.critical.t")} (${w.criticalWhat.map((x) => t(`ch.what.${x}`)).join(", ")})`);
      c.dataset.ddn = "channel-critical";
      li.append(c);
    }
    if (w.retired) {
      const c = chip(t("ch.retired"), "warning", t("ch.retired.t"));
      c.dataset.ddn = "channel-retired";
      li.append(c);
    }
    li.append(h("span", { class: "when", "data-ddn": "channel-stats" }, `${tn("files.meta.files", w.files)} · ${fmtSize(w.bytes)} · #…${String(w.channelId).slice(-6)}`));
    if (removable) {
      const acts = h("span", { class: "acts2" });
      if (w.retired) {
        const un = h("button", { class: "btn sm", type: "button", "data-ddn": "channel-unretire" }, t("ch.unretire"));
        un.onclick = () =>
          void act(un, async () => {
            await core.retireWebhook(w.id, false);
            toast(t("ch.unretired"));
            await d.render();
          });
        acts.append(un);
      }
      const rm = h("button", { class: "iconbtn danger", type: "button", "data-ddn": "remove-webhook", "aria-label": t("ch.manage"), title: t("ch.manage") }, icon("x"));
      rm.onclick = () => void act(rm, () => openDialog(w));
      acts.append(rm);
      li.append(acts);
    }
    return li;
  }

  function paintRemoved(wh: ChannelsView) {
    const list = $("removed-list");
    $("removed-block").hidden = wh.removed.length === 0;
    list.replaceChildren(
      ...wh.removed.map((r) => {
        const li = h("li", { "data-ddn": "removed-row", "data-id": r.id }, icon("hash"), h("span", { class: "dname" }, r.label || "webhook"));
        li.append(h("span", { class: "when" }, r.how === "moved" && !r.unavailableFiles ? t("ch.removed.moved") : `${tn("ch.removed.lost", r.unavailableFiles)} · ${t("ch.removed.back")}`));
        if (wh.botRecovery && r.unavailableFiles > 0) {
          const b = h("button", { class: "btn sm", type: "button", "data-ddn": "channel-recover", title: t("ch.recover.t") }, t("ch.recover"));
          b.onclick = () =>
            void act(b, async () => {
              paintMove(await core.recoverWebhook(r.id));
            });
          li.append(b);
        }
        return li;
      }),
    );
  }

  function paintMove(s: MoveStatus | null) {
    lastMove = s;
    const box = $("channel-move");
    if (!s || (s.state === "done" && Date.now() - s.updatedAt > 60_000)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const eta = s.state === "running" && s.etaMs ? t("ch.moving.eta", { eta: fmtEta(s.etaMs) }) : "";
    const p = { name: s.label || "webhook", done: fmtNum(s.done), total: fmtNum(s.total), bytes: fmtSize(s.bytesDone), all: fmtSize(s.bytesTotal), eta };
    $("channel-move-text").textContent =
      s.state === "done" ? t(s.newKitNeeded ? "ch.moved.kit" : "ch.moved", p) : s.state === "running" ? t(server ? "ch.moving.inst" : "ch.moving", p) : t("ch.movePaused", { ...p, why: s.error ?? "?" });
    box.dataset.state = s.state;
    const bar = $("channel-move-bar");
    bar.style.width = `${s.total ? Math.round((100 * s.done) / s.total) : s.state === "done" ? 100 : 0}%`;
    bar.className = s.state === "done" ? "done" : s.state === "running" ? "" : s.state === "paused" ? "paused" : "err";
  }

  /** Called by ui.ts renderHooks after the generic part (advice, slots, pool row). */
  function paint(wh: ChannelsView, inWizard: boolean) {
    $("channels-summary").textContent = wh.advice.ok ? summary(wh) : "";
    paintFold(wh, inWizard);
    const removable = !inWizard && (server ? typeof wh.using === "string" : true);
    const rows = wh.webhooks.map((w) => row(w, removable && (server || wh.webhooks.length > 0)));
    paintRemoved(wh);
    paintMove(wh.move);
    return rows;
  }

  // ── remove dialog ───────────────────────────────────────────────
  let current: RemovalImpact | null = null;
  async function openDialog(w: ChannelRow) {
    const dlg = $<HTMLDialogElement>("channel-dialog");
    ui("chd-title").textContent = t("ch.dlg.title", { name: w.label || "webhook" });
    $("chd-impact").textContent = t("ch.dlg.checking");
    $("chd-files").replaceChildren();
    for (const id of ["retire", "move", "remove"]) $<HTMLInputElement>(`chd-opt-${id}`).disabled = true;
    $<HTMLButtonElement>("chd-go").disabled = true;
    if (!dlg.open) dlg.showModal();
    const imp = await core.channelImpact(w.id);
    current = imp;
    paintDialog(imp);
  }

  function paintDialog(imp: RemovalImpact) {
    const p = { n: imp.files, size: fmtSize(imp.bytes) };
    $("chd-impact").textContent = imp.files ? tn("ch.dlg.impact", imp.files, { size: fmtSize(imp.bytes) }) : t("ch.dlg.none");
    $("chd-impact").dataset.files = String(imp.files);
    $("chd-files").replaceChildren(
      ...imp.list.map((f) => h("li", { "data-ddn": "chd-file" }, icon("file"), h("span", { class: "dname", title: f.name }, f.name), h("span", { class: "when" }, [fmtSize(f.size), f.trashed ? t("ch.dlg.inTrash") : ""].filter(Boolean).join(" · ")))),
      ...(imp.more ? [h("li", { class: "empty-row" }, t("ch.dlg.more", { n: fmtNum(imp.more) }))] : []),
    );
    $("chd-files").hidden = imp.list.length === 0;
    if (imp.checking) $("chd-impact").textContent += ` ${t("ch.dlg.still", { n: fmtNum(imp.checking) })}`;
    $("chd-critical").hidden = !imp.critical;
    ui("chd-critical-t").textContent = t("ch.dlg.critical", { what: imp.criticalWhat.map((x) => t(`ch.what.${x}`)).join(", ") });
    const last = imp.otherActive === 0;
    $("chd-last").hidden = !last;
    const opt = (id: string) => $<HTMLInputElement>(`chd-opt-${id}`);
    opt("retire").disabled = imp.critical || last || imp.retired;
    opt("move").disabled = last;
    opt("remove").disabled = imp.critical || last;
    ui("chd-opt-retire-t").textContent = imp.critical ? t("ch.opt.critical") : t("ch.opt.retire.t");
    ui("chd-opt-move-t").textContent = last ? t("ch.opt.move.no") : t("ch.opt.move.t", { size: fmtSize(imp.moveBytes), eta: fmtEta(imp.moveEtaMs) });
    ui("chd-opt-remove-t").textContent = imp.critical ? t("ch.opt.critical") : tn("ch.opt.remove.t", imp.files, { size: p.size });
    // Default: retire (owner decision), else move for a critical / retired one.
    const pick = [opt("retire"), opt("move"), opt("remove")].find((x) => !x.disabled);
    for (const x of [opt("retire"), opt("move"), opt("remove")]) x.checked = x === pick;
    paintChoice();
  }

  function paintRemoveList(imp: RemovalImpact) {
    ui("chd-remove-files-t").textContent = tn("ch.rmList.t", imp.files, { size: fmtSize(imp.bytes) });
    $("chd-remove-list").replaceChildren(
      ...imp.list.map((f) => h("li", { "data-ddn": "chd-remove-file" }, icon("file"), h("span", { class: "dname", title: f.name }, f.name), h("span", { class: "when" }, [fmtSize(f.size), f.trashed ? t("ch.dlg.inTrash") : ""].filter(Boolean).join(" · ")))),
      ...(imp.more ? [h("li", { class: "empty-row" }, t("ch.rmList.more", { n: fmtNum(imp.more) }))] : []),
    );
  }

  /** The complete list (every file, with its folder path) as a text file, before removing anyway. */
  async function exportList(imp: RemovalImpact) {
    const all = await core.channelFiles(imp.webhookId);
    const lines = [t("ch.rmList.head", { name: imp.label || "webhook", n: all.length }), "", ...all.map((f) => `${f.path}\t${fmtSize(f.size)}${f.trashed ? `\t${t("ch.dlg.inTrash")}` : ""}`)];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
    a.download = `unavailable-${(imp.label || imp.webhookId).replace(/[^\p{L}\p{N}._-]+/gu, "_")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  function choice(): "retire" | "move" | "remove" | null {
    for (const id of ["retire", "move", "remove"] as const) if ($<HTMLInputElement>(`chd-opt-${id}`).checked) return id;
    return null;
  }
  function paintChoice() {
    const c = choice();
    const imp = current;
    const go = $<HTMLButtonElement>("chd-go");
    const needAck = c === "remove" && !!imp && imp.files > 0;
    $("chd-ack-row").hidden = !needAck;
    // Owner (#31): with "Remove anyway" the files that become unavailable are listed right by the confirmation.
    $("chd-remove-files").hidden = !needAck;
    if (needAck && imp) paintRemoveList(imp);
    if (imp) ui("chd-ack-t").textContent = tn("ch.ack", imp.files, { size: fmtSize(imp.bytes) });
    go.textContent = c ? t(`ch.go.${c}`) : t("ch.go.retire");
    go.className = `btn ${c === "remove" ? "danger" : "primary"}`;
    go.disabled = !c || (needAck && !$<HTMLInputElement>("chd-ack").checked);
  }

  function wireDialog() {
    const dlg = $<HTMLDialogElement>("channel-dialog");
    for (const id of ["retire", "move", "remove"]) $(`chd-opt-${id}`).onchange = () => paintChoice();
    $("chd-ack").onchange = () => paintChoice();
    $("chd-remove-export").onclick = (e) =>
      void act(e.currentTarget as HTMLElement, async () => {
        if (current) await exportList(current);
      });
    ui("chd-close").onclick = () => dlg.close();
    ui("chd-cancel").onclick = () => dlg.close();
    dlg.addEventListener("close", () => {
      current = null;
      $<HTMLInputElement>("chd-ack").checked = false;
    });
    $("chd-go").onclick = (e) =>
      void act(e.currentTarget as HTMLElement, async () => {
        const imp = current;
        const c = choice();
        if (!imp || !c) return;
        if (c === "retire") {
          await core.retireWebhook(imp.webhookId, true);
          dlg.close();
          toast(t("ch.retiredDone"));
        } else if (c === "remove") {
          await core.removeWebhook(imp.webhookId);
          dlg.close();
          toast(imp.files ? tn("ch.removedDone", imp.files) : t("hooks.removed"));
        } else {
          dlg.close();
          setOpen(true);
          // metadata only: runs in this tab and resolves at the end (progress events meanwhile); e2ee/plain: returns at once.
          const s = core.moveWebhook(imp.webhookId);
          paintMove({ webhookId: imp.webhookId, label: imp.label, state: "running", critical: imp.critical, done: 0, total: imp.files, bytesDone: 0, bytesTotal: imp.moveBytes, startedAt: Date.now(), updatedAt: Date.now(), etaMs: imp.moveEtaMs });
          onMoveDone(await s);
        }
        await d.render();
      });
  }

  async function onMoveDone(s: MoveStatus) {
    paintMove(s);
    if (s.state === "done" && s.newKitNeeded && !server && !kitAsked) {
      kitAsked = true;
      await d.openKit(true);
    }
    if (s.state !== "running") await d.render();
  }

  /** core "channel-move" events. */
  function onMoveEvent(s: MoveStatus) {
    paintMove(s);
    if (s.state === "done" && lastMove?.state !== "done") void onMoveDone(s);
  }

  // ── Storage totals + the unavailable switch ─────────────────────
  async function paintStorage(wh: ChannelsView | null) {
    const st = await core.storageTotals().catch(() => null);
    if (!st) return;
    $("st-all").textContent = t("st.files", { files: tn("files.meta.files", st.files), size: fmtSize(st.bytes) });
    $("st-trash").textContent = t("st.files", { files: tn("files.meta.files", st.trashFiles), size: fmtSize(st.trashBytes) });
    $("st-unavail").textContent = st.unavailableFiles ? t("st.files", { files: tn("files.meta.files", st.unavailableFiles), size: fmtSize(st.unavailableBytes) }) : t("st.unavail.none");
    ui("st-unavail-t").textContent = st.unavailableFiles ? t("st.unavail.t") : "";
    $("st-discord").textContent = st.discordBytes === null ? "—" : fmtSize(st.discordBytes);
    $("st-all").title = t("st.took", { ms: st.tookMs });
    $("st-all").dataset.tookMs = String(st.tookMs);
    const list = $("st-channels");
    const rows = wh?.webhooks ?? [];
    list.hidden = rows.length === 0;
    list.replaceChildren(
      ...rows.map((w) => {
        const li = h("li", { "data-ddn": "st-channel", "data-id": w.id }, icon("hash"), h("span", { class: "dname" }, w.label || "webhook"));
        if (w.critical) li.append(chip(t("ch.critical"), "accent", t("ch.critical.t")));
        li.append(chip(w.retired ? t("ch.retired") : w.alive === false ? t("ch.sum.dead", { n: 1 }).replace(/^1\s*/, "") : t("ch.sum.ok").split(" ").pop()!, w.retired ? "warning" : w.alive === false ? "error" : "success"));
        li.append(h("span", { class: "when" }, `${tn("files.meta.files", w.files)} · ${fmtSize(w.bytes)}`));
        return li;
      }),
    );
  }

  function wireStorage() {
    const box = $<HTMLInputElement>("show-unavailable");
    box.checked = storedShowUnavailable();
    box.onchange = () =>
      void act(null, async () => {
        try {
          localStorage.setItem(SHOW_UNAVAILABLE_KEY, box.checked ? "1" : "0");
        } catch {
          /* private mode */
        }
        await core.setShowUnavailable(box.checked);
        await d.render();
      });
  }

  function wire() {
    wireFold();
    wireDialog();
    wireStorage();
  }

  return { wire, paint, paintStorage, onMoveEvent, openDialog, get lastMove() {
    return lastMove;
  } };
}
