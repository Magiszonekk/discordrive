// `discordrive doctor` and `discordrive invite`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InviteStore } from "@ddv4/metadata-client/node";
import { health, hostUrl, isLocalAddress, portState, validateBotToken } from "./checks.js";
import { POSIX_MODES, checkWritable, configPath, dbPath, fileMode, isLocalUrl, loadConfig, webDir, type InstanceConfig } from "./config.js";
import { COMMANDS } from "./setup.js";
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
  add(process.versions.node.split(".").map(Number)[0]! >= 22 ? "ok" : "fail", "Node.js", process.version);
  const wr = checkWritable(dataDir);
  add(wr ? "fail" : "ok", "zapis w katalogu danych", wr ?? dataDir);
  if (POSIX_MODES) {
    const m = fileMode(configPath(dataDir));
    add(m === 0o600 ? "ok" : "fail", "uprawnienia config.json", m === null ? "brak" : `0${m.toString(8)}${m === 0o600 ? "" : " (powinno być 0600: chmod 600)"}`);
    const dm = fileMode(dataDir);
    add(dm === 0o700 ? "ok" : "warn", "uprawnienia katalogu danych", dm === null ? "brak" : `0${dm.toString(8)}${dm === 0o700 ? "" : " (zalecane 0700)"}`);
    for (const f of [dbPath(c), `${dbPath(c)}-wal`]) {
      const fm = fileMode(f);
      if (fm !== null && fm & 0o077) add("warn", `uprawnienia ${f}`, `0${fm.toString(8)} (inni użytkownicy mogą czytać)`);
    }
  }
  add(existsSync(join(webDir(c), "index.html")) ? "ok" : "warn", "aplikacja przeglądarkowa", existsSync(join(webDir(c), "index.html")) ? webDir(c) : `${webDir(c)}: nie zbudowana (zbuduje się przy starcie)`);

  add(isLocalAddress(c.bind.host) ? "ok" : "fail", "adres nasłuchu", `${c.bind.host}${isLocalAddress(c.bind.host) ? "" : " nie jest adresem tej maszyny (sieć/VPN nie działa?)"}`);
  if (c.bind.host === "0.0.0.0" || c.bind.host === "::") add("warn", "adres nasłuchu", "nasłuch na wszystkich interfejsach; za proxy lepiej konkretny adres");
  const st = await portState(c.bind.host, c.bind.port);
  if (st.state === "ours") add("ok", "port", `${c.bind.port}: działa discordrive-next ${st.version}`);
  else if (st.state === "free") add("warn", "port", `${c.bind.port}: serwer nie działa (uruchom: ${COMMANDS.start})`);
  else add("fail", "port", `${c.bind.port}: zajęty przez inną usługę (${st.code})`);

  const local = isLocalUrl(c.publicUrl);
  if (systemdAvailable()) {
    const u = unitState();
    if (u.installed) add(u.active === "active" ? "ok" : "warn", "usługa systemd --user", `${u.active}, ${u.enabled}`);
    else add(local ? "ok" : "warn", "usługa systemd --user", local ? `nie używana (start ręczny: ${COMMANDS.start})` : `nie zainstalowana (${COMMANDS.setup} → uruchamianie w tle)`);
    if (u.installed && lingerEnabled() === false) add("warn", "linger", "wyłączony: usługa zatrzyma się po wylogowaniu (loginctl enable-linger)");
  }

  const h = await health(hostUrl(c.bind.host, c.bind.port));
  add(h.ok ? "ok" : st.state === "free" ? "warn" : "fail", "health lokalnie", h.ok ? `wersja ${h.body.version}, tryb ${h.body.mode}, reguły ${h.body.rulesVersion}, uptime ${h.body.uptimeS} s` : h.error);
  const pub = new URL(c.publicUrl);
  if (pub.hostname !== "127.0.0.1" && pub.hostname !== "localhost" && pub.hostname !== "[::1]") {
    const r = await health(c.publicUrl, 8000);
    add(r.ok ? "ok" : "fail", "health pod adresem publicznym", r.ok ? `${c.publicUrl}/v1/health odpowiada` : `${c.publicUrl}: ${r.error}`);
    if (pub.protocol !== "https:") add("warn", "HTTPS", "adres publiczny bez https: przeglądarka nie uruchomi aplikacji");
  }
  if (c.botToken) {
    const b = await validateBotToken(c.botToken, c.testing?.discordApiOrigin);
    add(b.ok ? "ok" : "fail", "token bota", b.ok ? `działa (${b.username}, ${b.id})` : b.why);
  } else add(local ? "ok" : "warn", "udostępnianie linkiem", `wyłączone (brak bota; włączysz w ${COMMANDS.setup})`);
  add(c.signup === "open" && !local ? "warn" : "ok", "rejestracja", c.signup === "open" ? (local ? "otwarta (tylko z tego komputera)" : "otwarta dla każdego z internetu") : c.signup === "invite" ? "z kodem zaproszenia" : "zamknięta");
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
