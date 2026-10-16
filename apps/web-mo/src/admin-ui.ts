// Admin screen (/admin): instance administration for accounts with the admin flag.
// The server checks the flag on every /v1/admin call; this module only paints what it answers.
//  - Accounts: table (ID, invite note, devices, size, last activity, chips admin/blocked), search by
//    ID or note, a dialog per account (details, devices with "revoke", admin / block / delete);
//  - Invite codes: create (validity, note; the code is shown once with Copy), list, revoke;
//  - Instance: sign-up policy, mode, version, uptime, the `doctor` checks, the pool (e2ee/plain);
//  - Administrative log with a filter.
// Destructive actions (delete an account, change the admin flag, revoke another account's device)
// ask in the confirm dialog, and the request is signed again by this device (re-authentication).
// Look: existing Cobalt classes (sections, ftable, list, about, chip, note, modal, choice).
import type { AdminAccount, AdminDeletion, AdminInvite, AdminLogRow } from "./app-core.js";
import { fmtDate, fmtDateTime, fmtNum, fmtSize, t, tn } from "./i18n.js";
import type { connect } from "./rpc.js";

type Core = ReturnType<typeof connect>;

export interface AdminUiDeps {
  core: Core;
  mode: string;
  h: <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...kids: (Node | string)[]) => HTMLElementTagNameMap[K];
  icon: (name: string) => SVGElement;
  chip: (text: string, tone?: string, title?: string) => HTMLElement;
  act: (btn: HTMLElement | null, fn: () => Promise<unknown>) => Promise<void>;
  toast: (text: string, kind?: "ok" | "err" | "info") => void;
  confirmDanger: (title: string, text: string, yes: string) => Promise<boolean>;
  copy: (text: string) => Promise<void>;
  /** This account (its own row cannot be blocked or deleted from here). */
  me: () => string | null;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`[data-ddn="${sel}"]`)!;
const ui = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`[data-ddn-ui="${sel}"]`)!;
const shortId = (id: string) => id.slice(0, 13);

function fmtUptime(s: number): string {
  if (s < 90) return `${fmtNum(s)} s`;
  if (s < 5400) return `${fmtNum(Math.round(s / 60))} min`;
  if (s < 172_800) return `${fmtNum(s / 3600, 1)} h`;
  return `${fmtNum(s / 86_400, 1)} d`;
}

export function createAdminUi(d: AdminUiDeps) {
  const { core, h, icon, chip, act, toast } = d;
  const server = d.mode !== "metadata-only";
  let accounts: AdminAccount[] = [];
  let deletions: AdminDeletion[] = [];
  let logFilter = "";
  let logOldest = 0;
  let openId: string | null = null;

  const seen = (ms: number | null) => (ms ? fmtDateTime(ms) : t("adm.never"));
  const size = (a: AdminAccount) => fmtSize(a.serverBytes) + (a.poolBytes !== null ? ` + ${fmtSize(a.poolBytes)}` : "");

  // ── accounts

  function accountRow(a: AdminAccount): HTMLTableRowElement {
    const tr = h("tr", { "data-ddn": "adm-acc-row", "data-account": a.accountId });
    const name = h("td", { class: "c-name" });
    const nm = h("span", { class: "nm" }, icon("shield"), h("span", { class: "mono", title: a.accountId }, shortId(a.accountId)));
    name.append(nm);
    const tags = h("span", { class: "sub" }, [a.inviteNote === null ? "" : a.inviteNote || t("adm.noNote"), tn("adm.devices", a.devices)].filter(Boolean).join(" · "));
    name.append(tags);
    if (a.admin) name.append(" ", chip(t("adm.chip.admin"), "accent"));
    if (a.state === "blocked") name.append(" ", chip(t("adm.chip.blocked"), "warning", a.blockedReason ?? ""));
    if (a.accountId === d.me()) name.append(" ", chip(t("dev.me")));
    // Desktop: own columns; phone: the line under the ID (.sub) carries the note and the devices.
    const inv = h("td", { class: "c-date" }, a.inviteNote === null ? "-" : a.inviteNote || t("adm.noNote"));
    const devs = h("td", { class: "size" }, fmtNum(a.devices));
    const note = h("td", { class: "size", title: server ? t("adm.size.t.pool") : t("adm.size.t") }, size(a));
    const when = h("td", { class: "c-date", title: seen(a.lastSeenAt) }, a.lastSeenAt ? fmtDate(a.lastSeenAt) : t("adm.never"));
    const open = h("button", { class: "btn sm", type: "button", "data-ddn": "adm-acc-open" }, t("adm.open"));
    open.onclick = () => void openAccount(a.accountId);
    const acts = h("td", { class: "c-acts" }, h("span", { class: "acts" }, open));
    tr.append(name, inv, devs, note, when, acts);
    return tr;
  }

  function paintAccounts() {
    const q = $<HTMLInputElement>("adm-search").value.trim().toLowerCase();
    const shown = accounts.filter((a) => !q || a.accountId.toLowerCase().includes(q) || (a.inviteNote ?? "").toLowerCase().includes(q));
    $("adm-accounts").replaceChildren(...shown.map(accountRow));
    ui("adm-acc-none").hidden = shown.length > 0;
    $("adm-acc-count").textContent = fmtNum(accounts.length);
    const pending = deletions.filter((x) => x.state !== "done");
    $("adm-deletions").hidden = pending.length === 0;
    $("adm-deletions").replaceChildren(
      ...pending.map((x) =>
        h("li", { "data-ddn": "adm-deletion" }, icon("trash"), h("span", { class: "dname mono" }, shortId(x.accountId)), h("span", { class: "when" }, t(x.state === "failed" ? "adm.del.failed" : "adm.del.progress", { done: fmtNum(x.done), total: fmtNum(x.total), err: x.error ?? "" }))),
      ),
    );
  }

  async function loadAccounts() {
    const r = await core.adminAccounts();
    accounts = r.accounts;
    deletions = r.deletions;
    paintAccounts();
  }

  // ── one account (dialog)

  async function openAccount(id: string) {
    openId = id;
    const dlg = $<HTMLDialogElement>("adm-acc-dialog");
    await paintAccount();
    if (!dlg.open) dlg.showModal();
  }

  async function paintAccount() {
    if (!openId) return;
    const id = openId;
    const r = await core.adminAccount(id);
    const a = r.account;
    const mine = id === d.me();
    ui("adm-d-title").textContent = shortId(id);
    const row = (k: string, v: Node | string, ddn = "") => h("div", {}, h("dt", { class: "label-mono" }, t(k)), h("dd", {}, typeof v === "string" ? h("span", { class: "val", ...(ddn ? { "data-ddn": ddn } : {}) }, v) : v));
    $("adm-d-about").replaceChildren(
      row("adm.d.id", h("span", { class: "val mono" }, id)),
      row("adm.d.created", fmtDateTime(a.createdAt)),
      row("adm.d.seen", seen(a.lastSeenAt)),
      row("adm.d.state", a.state === "blocked" ? t("adm.state.blocked", { reason: a.blockedReason ? ` (${a.blockedReason})` : "" }) : t("adm.state.active"), "adm-d-state"),
      row("adm.d.invite", a.inviteNote === null ? t("adm.d.noInvite") : a.inviteNote || t("adm.noNote")),
      row("adm.d.size", size(a)),
      row("adm.d.admin", a.admin ? t("adm.yes") : t("adm.no"), "adm-d-admin-v"),
    );
    $("adm-d-devices").replaceChildren(
      ...r.devices.map((dv) => {
        const li = h("li", { "data-ddn": "adm-d-device", title: `${dv.deviceId} · ${t("adm.d.devAdded", { added: fmtDate(dv.createdAt) })}` }, icon("phone"), h("span", { class: "dname mono" }, dv.deviceId.slice(0, 12)), h("span", { class: "when" }, seen(dv.lastSeenAt)));
        const rm = h("button", { class: "iconbtn danger", type: "button", "data-ddn": "adm-d-revoke", "aria-label": t("adm.d.revoke"), title: t("adm.d.revoke") }, icon("x"));
        rm.onclick = () =>
          void act(rm, async () => {
            if (!(await d.confirmDanger(t("adm.d.revoke.h"), t("adm.d.revoke.t"), t("adm.d.revoke")))) return;
            await core.adminRevokeDevice(id, dv.deviceId);
            toast(t("adm.d.revoked"));
            await Promise.all([paintAccount(), loadAccounts(), loadLog()]);
          });
        li.append(rm);
        return li;
      }),
    );
    const adm = $<HTMLButtonElement>("adm-d-admin");
    adm.textContent = a.admin ? t("adm.d.adminOff") : t("adm.d.adminOn");
    adm.onclick = () =>
      void act(adm, async () => {
        const off = a.admin;
        if (!(await d.confirmDanger(t(off ? "adm.d.adminOff" : "adm.d.adminOn"), t(off ? "adm.d.adminOff.t" : "adm.d.adminOn.t"), t(off ? "adm.d.adminOff" : "adm.d.adminOn")))) return;
        await core.adminSetAdmin(id, !off);
        toast(t(off ? "adm.d.adminOffDone" : "adm.d.adminOnDone"));
        await Promise.all([paintAccount(), loadAccounts(), loadLog()]);
        // Took the flag from itself: the panel is gone on the next render.
        if (off && mine) location.assign("/");
      });
    const blk = $<HTMLButtonElement>("adm-d-block");
    blk.textContent = a.state === "blocked" ? t("adm.d.unblock") : t("adm.d.block");
    blk.disabled = mine;
    ui("adm-d-reason-f").hidden = a.state === "blocked" || mine;
    $<HTMLInputElement>("adm-d-reason").value = "";
    blk.onclick = () =>
      void act(blk, async () => {
        if (a.state === "blocked") {
          await core.adminUnblock(id);
          toast(t("adm.d.unblocked"));
        } else {
          if (!(await d.confirmDanger(t("adm.d.block.h"), t("adm.d.block.t"), t("adm.d.block")))) return;
          await core.adminBlock(id, $<HTMLInputElement>("adm-d-reason").value);
          toast(t("adm.d.blocked"));
        }
        await Promise.all([paintAccount(), loadAccounts(), loadLog()]);
      });
    const del = $<HTMLButtonElement>("adm-d-delete");
    del.disabled = mine;
    del.onclick = () =>
      void act(del, async () => {
        const text = t("adm.d.delete.t", { size: fmtSize(a.poolBytes ?? 0) });
        if (!(await d.confirmDanger(t("adm.d.delete.h", { id: shortId(id) }), text, t("adm.d.delete")))) return;
        const res = await core.adminDelete(id);
        $<HTMLDialogElement>("adm-acc-dialog").close();
        toast(res.deletion.state === "done" ? t("adm.d.deleted") : t("adm.d.deletedBg", { n: fmtNum(res.deletion.total) }));
        await Promise.all([loadAccounts(), loadLog(), loadInstance()]);
      });
  }

  // ── invites

  function inviteRow(x: AdminInvite): HTMLLIElement {
    const tone = x.state === "active" ? "success" : x.state === "used" ? "" : "warning";
    const li = h("li", { "data-ddn": "adm-inv-row", "data-invite": x.id, "data-state": x.state }, icon("key"), h("span", { class: "dname" }, x.note || t("adm.noNote")), chip(t(`adm.inv.st.${x.state}`), tone));
    const info = x.state === "used" && x.usedBy ? t("adm.inv.usedBy", { id: shortId(x.usedBy) }) : x.state === "active" ? t("adm.inv.until", { date: fmtDateTime(x.expiresAt) }) : fmtDate(x.createdAt);
    li.append(h("span", { class: "when", title: x.id }, info));
    if (x.state === "active") {
      const rv = h("button", { class: "iconbtn danger", type: "button", "data-ddn": "adm-inv-revoke", "aria-label": t("adm.inv.revoke"), title: t("adm.inv.revoke") }, icon("x"));
      rv.onclick = () =>
        void act(rv, async () => {
          await core.adminRevokeInvite(x.id);
          toast(t("adm.inv.revoked"));
          await Promise.all([loadInvites(), loadLog()]);
        });
      li.append(rv);
    }
    return li;
  }

  async function loadInvites() {
    const { invites } = await core.adminInvites();
    // Newest first; long-dead codes stay listed (the log is the history) but after the live ones.
    const order = { active: 0, used: 1, expired: 2, revoked: 3 } as const;
    invites.sort((a, b) => order[a.state] - order[b.state] || b.createdAt - a.createdAt);
    $("adm-invites").replaceChildren(...invites.map(inviteRow));
    $("adm-inv-count").textContent = fmtNum(invites.filter((x) => x.state === "active").length);
  }

  // ── instance

  async function loadInstance() {
    const i = await core.adminInstance();
    $("adm-mode").textContent = t("adm.mode");
    $("adm-version").textContent = `${i.health.version} · rules ${i.health.rulesVersion}`;
    $("adm-uptime").textContent = fmtUptime(i.health.uptimeS);
    $("adm-accounts-n").textContent = t("adm.ins.accountsN", { n: fmtNum(i.accounts), admins: fmtNum(i.admins) });
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-ddn=adm-signup] [data-signup]")) b.setAttribute("aria-checked", String(b.dataset.signup === i.health.signup));
    ui("adm-signup-t").textContent = t(`adm.su.${i.health.signup}.t`);
    $("adm-pool-box").hidden = !i.pool;
    if (i.pool) {
      const name = (id: string) => accounts.find((a) => a.accountId === id)?.inviteNote || shortId(id);
      $("adm-pool").replaceChildren(
        ...i.pool.map((p) => {
          const li = h("li", { "data-ddn": "adm-pool-row" }, icon("hash"), h("span", { class: "dname" }, p.label || `#…${p.channelId.slice(-6)}`));
          if (!p.alive) li.append(chip(t("adm.pool.dead"), "warning"));
          if (p.retired) li.append(chip(t("adm.pool.retired")));
          const top = p.accounts.slice(0, 3).map((x) => `${name(x.accountId)} ${fmtSize(x.bytes)}`).join(", ");
          li.append(h("span", { class: "when", title: top }, t("adm.pool.row", { files: fmtNum(p.files), size: fmtSize(p.bytes), n: fmtNum(p.accounts.length) })));
          return li;
        }),
      );
    }
    const checks = (await core.adminDoctor()).checks;
    $("adm-doctor").replaceChildren(
      ...(checks ?? []).map((c) => h("li", { "data-ddn": "adm-doctor-row", "data-level": c.level }, chip(c.level === "ok" ? "OK" : c.level === "warn" ? t("adm.warn") : t("adm.fail"), c.level === "ok" ? "success" : "warning"), h("span", { class: "dname" }, c.what), h("span", { class: "when", title: c.detail }, c.detail))),
    );
    if (!checks) $("adm-doctor").replaceChildren(h("li", { class: "empty-row" }, t("adm.ins.noDoctor")));
  }

  // ── log

  function logText(e: AdminLogRow): string {
    const who = e.actor === "operator" ? t("adm.log.operator") : shortId(e.actor);
    const target = e.target.startsWith("acct-") ? shortId(e.target) : e.target;
    const det = e.detail as Record<string, unknown>;
    const extra = typeof det.note === "string" && det.note ? ` (${det.note})` : typeof det.reason === "string" ? ` (${det.reason})` : typeof det.to === "string" ? ` → ${t(`adm.su.${det.to}`)}` : "";
    const key = `adm.act.${e.action.replace(/\./g, "_")}`;
    const what = t(key) === key ? e.action : t(key);
    return `${who}: ${what} ${target}${extra}`.trim();
  }

  async function loadLog(more = false) {
    const { entries } = await core.adminLog(logFilter, more ? logOldest : 0);
    const items = entries.map((e) => h("li", { "data-ddn": "adm-log-row", "data-action": e.action }, icon(e.action.startsWith("invite") ? "key" : e.action.startsWith("signup") ? "settings" : "shield"), h("span", { class: "dname" }, logText(e)), h("span", { class: "when" }, fmtDateTime(e.at))));
    if (more) $("adm-log-list").append(...items);
    else $("adm-log-list").replaceChildren(...items);
    if (!more && !entries.length) $("adm-log-list").replaceChildren(h("li", { class: "empty-row" }, t("adm.log.none")));
    if (entries.length) logOldest = entries.at(-1)!.id;
    $("adm-log-more").hidden = entries.length < 100;
  }

  function wire() {
    $<HTMLInputElement>("adm-search").oninput = () => paintAccounts();
    ui("adm-d-close").onclick = () => $<HTMLDialogElement>("adm-acc-dialog").close();
    $<HTMLDialogElement>("adm-acc-dialog").addEventListener("close", () => {
      openId = null;
    });
    const create = $<HTMLButtonElement>("adm-inv-create");
    create.onclick = () =>
      void act(create, async () => {
        const days = Number($<HTMLInputElement>("adm-inv-days").value.replace(",", "."));
        if (!Number.isFinite(days) || days <= 0 || days > 365) return toast(t("adm.inv.badDays"), "err");
        const r = await core.adminCreateInvite(days, $<HTMLInputElement>("adm-inv-note").value);
        $<HTMLTextAreaElement>("adm-inv-code").value = r.code;
        $("adm-inv-new").hidden = false;
        $<HTMLInputElement>("adm-inv-note").value = "";
        await Promise.all([loadInvites(), loadLog()]);
      });
    $("adm-inv-copy").onclick = () =>
      void act($("adm-inv-copy"), async () => {
        await d.copy($<HTMLTextAreaElement>("adm-inv-code").value);
        toast(t("adm.inv.copied"));
      });
    $("adm-inv-hide").onclick = () => {
      $<HTMLTextAreaElement>("adm-inv-code").value = "";
      $("adm-inv-new").hidden = true;
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-ddn=adm-signup] [data-signup]")) {
      b.onclick = () =>
        void act(b, async () => {
          await core.adminSetSignup(b.dataset.signup as "invite" | "open" | "closed");
          toast(t("adm.su.saved"));
          await Promise.all([loadInstance(), loadLog()]);
        });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-ddn=adm-log-filter] [data-filter]")) {
      b.onclick = () =>
        void act(b, async () => {
          logFilter = b.dataset.filter ?? "";
          for (const x of document.querySelectorAll<HTMLButtonElement>("[data-ddn=adm-log-filter] [data-filter]")) x.setAttribute("aria-checked", String(x === b));
          await loadLog();
        });
    }
    $("adm-log-more").onclick = () => void act($("adm-log-more"), () => loadLog(true));
  }

  /** Paint the whole page (on entering /admin). */
  async function render() {
    ui("adm-blind").textContent = t("adm.blind");
    ui("adm-acc-lead").textContent = t("adm.acc.lead");
    await loadAccounts();
    await Promise.all([loadInvites(), loadInstance(), loadLog()]);
  }

  return { wire, render };
}
