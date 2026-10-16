// `discordrive doctor` and `discordrive invite`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InviteStore } from "@ddv4/metadata-client/node";
import { health, hostUrl, isLocalAddress, portState, validateBotToken } from "./checks.js";
import { POSIX_MODES, checkWritable, riskAccepted, configPath, dbPath, fileMode, isLocalUrl, loadConfig, webDir, type InstanceConfig } from "./config.js";
import { COMMANDS } from "./setup.js";
import { loadServerMode, webBuildState } from "./serve.js";
import { t } from "./i18n.js";
import * as autostart from "./autostart.js";

type Level = "ok" | "warn" | "fail";
export interface Check {
  level: Level;
  what: string;
  detail: string;
}

export async function doctor(dataDir: string, out: (s: string) => void = console.log): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const add = (level: Level, what: string, detail: string) => {
    checks.push({ level, what, detail });
    out(`${{ ok: t("d.ok"), warn: t("d.warn"), fail: t("d.fail") }[level]}  ${what}: ${detail}`);
  };
  let c: InstanceConfig;
  try {
    c = loadConfig(dataDir);
    add("ok", t("d.config"), configPath(dataDir));
    if (!riskAccepted(c)) {
      add("fail", t("d.risk"), t("r.needed"));
      out(t("d.someFail"));
      return { checks, ok: false };
    }
    add("ok", t("d.risk"), t("d.riskOk", { version: c.acceptedRisk!.version, at: c.acceptedRisk!.at }));
  } catch (e) {
    add("fail", t("d.config"), (e as Error).message);
    return { checks, ok: false };
  }
  add(process.versions.node.split(".").map(Number)[0]! >= 22 ? "ok" : "fail", "Node.js", process.version);
  const wr = checkWritable(dataDir);
  add(wr ? "fail" : "ok", t("d.write"), wr ?? dataDir);
  if (!POSIX_MODES) {
    // NTFS: a directory inside the user profile inherits "only this user (+ SYSTEM, Administrators)".
    const prof = (process.env.USERPROFILE ?? "").toLowerCase();
    const inside = !!prof && dataDir.toLowerCase().startsWith(prof);
    add(inside ? "ok" : "warn", t("d.acl"), inside ? t("d.aclWin") : t("d.aclWinOutside", { dir: dataDir }));
  }
  if (POSIX_MODES) {
    const m = fileMode(configPath(dataDir));
    add(m === 0o600 ? "ok" : "fail", t("d.cfgMode"), m === null ? t("d.none") : `0${m.toString(8)}${m === 0o600 ? "" : t("d.cfgModeFix")}`);
    const dm = fileMode(dataDir);
    add(dm === 0o700 ? "ok" : "warn", t("d.dirMode"), dm === null ? t("d.none") : `0${dm.toString(8)}${dm === 0o700 ? "" : t("d.dirModeFix")}`);
    for (const f of [dbPath(c), `${dbPath(c)}-wal`]) {
      const fm = fileMode(f);
      if (fm !== null && fm & 0o077) add("warn", t("d.fileMode", { file: f }), t("d.fileModeBad", { mode: `0${fm.toString(8)}` }));
    }
  }
  // Mode: the build of web + server matches the config; the database agrees.
  try {
    const sm = await loadServerMode(c);
    const db0 = existsSync(dbPath(c)) ? new DatabaseSync(dbPath(c), { readOnly: true }) : null;
    let stored: string | null = null;
    try {
      stored = (db0?.prepare("SELECT v FROM server_meta WHERE k = 'mode'").get() as { v: string } | undefined)?.v ?? null;
    } catch {
      stored = null;
    } finally {
      db0?.close();
    }
    if (stored && stored !== c.mode) add("fail", t("d.mode"), t("s.mode.change", { old: stored, mode: c.mode }));
    else add(webBuildState(c) === "ok" ? "ok" : "warn", t("d.mode"), t("d.modeBuild", { mode: sm.mode }));
    for (const x of (await sm.doctor?.(c, t as (k: string, p?: Record<string, string | number>) => string)) ?? []) add(x.level, x.what, x.detail);
  } catch (e) {
    add("warn", t("d.mode"), t("d.modeBuildBad", { detail: (e as Error).message }));
  }
  add(existsSync(join(webDir(c), "index.html")) ? "ok" : "warn", t("d.web"), existsSync(join(webDir(c), "index.html")) ? webDir(c) : t("d.webMissing", { dir: webDir(c) }));

  add(isLocalAddress(c.bind.host) ? "ok" : "fail", t("d.bind"), `${c.bind.host}${isLocalAddress(c.bind.host) ? "" : t("d.bindBad")}`);
  if (c.bind.host === "0.0.0.0" || c.bind.host === "::") add("warn", t("d.bind"), t("d.bindAll"));
  const st = await portState(c.bind.host, c.bind.port);
  if (st.state === "ours") add("ok", t("d.port"), t("d.portOurs", { port: c.bind.port, version: st.version }));
  else if (st.state === "free") add("warn", t("d.port"), t("d.portFree", { port: c.bind.port, cmd: COMMANDS.start }));
  else add("fail", t("d.port"), t("d.portBusy", { port: c.bind.port, code: st.code }));

  const local = isLocalUrl(c.publicUrl);
  const bg = autostart.state(dataDir);
  if (bg.backend !== "none") {
    const name = bg.backend === "systemd" ? "systemd --user" : bg.backend === "windows-task" ? "Task Scheduler" : bg.backend === "launchd" ? "LaunchAgent" : "XDG autostart";
    if (bg.installed) add(bg.running === false ? "warn" : "ok", t("d.autostart"), t("d.autostartOn", { backend: name, detail: bg.detail }));
    else add(local ? "ok" : "warn", t("d.autostart"), local ? t("d.autostartUnused", { cmd: COMMANDS.start }) : t("d.autostartMissing", { cmd: COMMANDS.setup }));
    if (bg.installed && autostart.lingerOff(bg.backend)) add("warn", t("d.linger"), t("d.lingerOff"));
  }

  const h = await health(hostUrl(c.bind.host, c.bind.port));
  add(h.ok ? "ok" : st.state === "free" ? "warn" : "fail", t("d.health"), h.ok ? t("d.healthOk", { version: String(h.body.version), mode: String(h.body.mode), rules: String(h.body.rulesVersion), uptime: String(h.body.uptimeS) }) : h.error);
  const pub = new URL(c.publicUrl);
  if (pub.hostname !== "127.0.0.1" && pub.hostname !== "localhost" && pub.hostname !== "[::1]") {
    const r = await health(c.publicUrl, 8000);
    add(r.ok ? "ok" : "fail", t("d.healthPub"), r.ok ? t("d.healthPubOk", { url: c.publicUrl }) : `${c.publicUrl}: ${r.error}`);
    if (pub.protocol !== "https:") add("warn", t("d.https"), t("d.httpsBad"));
  }
  if (c.botToken) {
    const b = await validateBotToken(c.botToken, c.testing?.discordApiOrigin);
    add(b.ok ? "ok" : "fail", t("d.bot"), b.ok ? t("d.botOk", { name: b.username, id: b.id }) : b.why);
  } else add(local ? "ok" : "warn", t("d.share"), t("d.shareOff", { cmd: COMMANDS.setup }));
  add(c.signup === "open" && !local ? "warn" : "ok", t("d.signup"), c.signup === "open" ? (local ? t("d.signupOpenLocal") : t("d.signupOpenPub")) : t(`signup.${c.signup}`));
  add("ok", t("d.lang"), c.language);
  if (c.testing) add("warn", t("d.testing"), t("d.testingOn"));
  const ok = !checks.some((x) => x.level === "fail");
  out(ok ? t("d.allOk") : t("d.someFail"));
  return { checks, ok };
}

export function invite(dataDir: string, ttlDays = 7, note = ""): { code: string; expiresAt: number } {
  const c = loadConfig(dataDir);
  const db = new DatabaseSync(dbPath(c));
  try {
    return new InviteStore(db).create(ttlDays * 24 * 3600_000, note);
  } finally {
    db.close();
  }
}
