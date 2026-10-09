// `discordrive doctor` and `discordrive invite`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InviteStore } from "@ddv4/metadata-client/node";
import { health, hostUrl, isLocalAddress, portState, validateBotToken } from "./checks.js";
import { configPath, dbPath, fileMode, loadConfig, webDir, type InstanceConfig } from "./config.js";
import { lingerEnabled, systemdAvailable, unitState } from "./systemd.js";

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
    out(`${{ ok: " OK ", warn: "UWAG", fail: "BŁĄD" }[level]}  ${what}: ${detail}`);
  };
  let c: InstanceConfig;
  try {
    c = loadConfig(dataDir);
    add("ok", "konfiguracja", configPath(dataDir));
  } catch (e) {
    add("fail", "konfiguracja", (e as Error).message);
    return { checks, ok: false };
  }
  const m = fileMode(configPath(dataDir));
  add(m === 0o600 ? "ok" : "fail", "uprawnienia config.json", m === null ? "brak" : `0${m.toString(8)}${m === 0o600 ? "" : " (powinno być 0600: chmod 600)"}`);
  const dm = fileMode(dataDir);
  add(dm === 0o700 ? "ok" : "warn", "uprawnienia katalogu danych", dm === null ? "brak" : `0${dm.toString(8)}${dm === 0o700 ? "" : " (zalecane 0700)"}`);
  for (const f of [dbPath(c), `${dbPath(c)}-wal`]) {
    const fm = fileMode(f);
    if (fm !== null && fm & 0o077) add("warn", `uprawnienia ${f}`, `0${fm.toString(8)} (inni użytkownicy mogą czytać)`);
  }
  add(existsSync(join(webDir(c), "index.html")) ? "ok" : "warn", "aplikacja przeglądarkowa", existsSync(join(webDir(c), "index.html")) ? webDir(c) : `${webDir(c)}: nie zbudowana (zbuduje się przy starcie)`);

  add(isLocalAddress(c.bind.host) ? "ok" : "fail", "adres nasłuchu", `${c.bind.host}${isLocalAddress(c.bind.host) ? "" : " nie jest adresem tej maszyny (VPN nie działa?)"}`);
  if (c.bind.host === "0.0.0.0" || c.bind.host === "::") add("warn", "adres nasłuchu", "nasłuch na wszystkich interfejsach; za proxy lepiej konkretny adres");
  const st = await portState(c.bind.host, c.bind.port);
  if (st.state === "ours") add("ok", "port", `${c.bind.port}: działa discordrive-next ${st.version}`);
  else if (st.state === "free") add("warn", "port", `${c.bind.port}: wolny, serwer nie działa`);
  else add("fail", "port", `${c.bind.port}: zajęty przez inną usługę (${st.code})`);

  if (systemdAvailable()) {
    const u = unitState();
    add(u.installed ? (u.active === "active" ? "ok" : "warn") : "warn", "systemd --user", u.installed ? `${u.active}, ${u.enabled}` : "unit nie zainstalowany (discordrive setup)");
    if (u.installed && lingerEnabled() === false) add("warn", "linger", "wyłączony: usługa zatrzyma się po wylogowaniu (loginctl enable-linger)");
  }

  const local = await health(hostUrl(c.bind.host, c.bind.port));
  add(local.ok ? "ok" : "fail", "health lokalnie", local.ok ? `wersja ${local.body.version}, tryb ${local.body.mode}, reguły ${local.body.rulesVersion}, uptime ${local.body.uptimeS} s` : local.error);
  const pub = new URL(c.publicUrl);
  if (pub.hostname !== "127.0.0.1" && pub.hostname !== "localhost") {
    const r = await health(c.publicUrl, 8000);
    add(r.ok ? "ok" : "fail", "health pod adresem publicznym", r.ok ? `${c.publicUrl}/v1/health odpowiada` : `${c.publicUrl}: ${r.error}`);
    if (pub.protocol !== "https:") add("warn", "HTTPS", "adres publiczny bez https: przeglądarka nie uruchomi aplikacji");
  }
  if (c.botToken) {
    const b = await validateBotToken(c.botToken, c.testing?.discordApiOrigin);
    add(b.ok ? "ok" : "fail", "token bota", b.ok ? `działa (${b.username}, ${b.id})` : b.why);
  } else add("warn", "token bota", "brak: udostępnianie wyłączone");
  add(c.signup === "open" ? "warn" : "ok", "rejestracja", c.signup === "open" ? "otwarta dla każdego" : c.signup === "invite" ? "z kodem zaproszenia" : "zamknięta");
  if (c.testing) add("warn", "tryb testowy", "testing.discordApiOrigin ustawiony: to nie jest prawdziwy Discord");
  const ok = !checks.some((x) => x.level === "fail");
  out(ok ? "\nWszystko w porządku." : "\nSą błędy (BŁĄD) do poprawienia.");
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
