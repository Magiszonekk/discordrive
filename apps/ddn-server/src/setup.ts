// `discordrive setup`: interactive wizard (Polish), Enter accepts defaults.
// Re-running edits the existing config (current values are the defaults;
// the bot token is kept unless you choose to replace it).
// Non-interactive: --yes plus flags or --answers <file.json>.

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { InviteStore } from "@ddv4/metadata-client/node";
import { health, hostUrl, isLocalAddress, isLoopback, nextFreePort, portState, validateBotToken } from "./checks.js";
import {
  DEFAULT_PORT,
  configPath,
  dbPath,
  defaultDataDir,
  defaults,
  saveConfig,
  tryLoadConfig,
  validate,
  type InstanceConfig,
  type SignupPolicy,
} from "./config.js";
import { ttyPrompter, type Prompter } from "./prompt.js";
import { serve } from "./serve.js";
import { installAndStart, lingerEnabled, systemdAvailable, unitPath } from "./systemd.js";

export interface SetupFlags {
  yes?: boolean;
  dataDir?: string;
  publicUrl?: string;
  host?: string;
  port?: number;
  trustProxy?: string[];
  signup?: SignupPolicy;
  /** File with the bot token (never on the command line). */
  botTokenFile?: string;
  noBot?: boolean;
  /** Replace a saved token without asking (with botTokenFile). */
  replaceBot?: boolean;
  invite?: boolean;
  systemd?: boolean;
  selfTest?: boolean;
  /** Tests: Discord API on a fake. */
  discordApiOrigin?: string;
}

export interface SetupResult {
  config: InstanceConfig;
  configFile: string;
  invite: { code: string; expiresAt: number } | null;
  selfTest: { ok: boolean; detail: string } | null;
  systemd: "installed" | "skipped" | "unavailable";
}

const urlOk = (s: string) => {
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
  } catch {
    return false;
  }
};

export function nginxSnippet(c: InstanceConfig): string {
  const host = new URL(c.publicUrl).hostname;
  const up = hostUrl(c.bind.host, c.bind.port);
  return `server {
    listen 443 ssl http2;
    server_name ${host};
    # ssl_certificate / ssl_certificate_key: np. certbot --nginx -d ${host}

    client_max_body_size 50m;
    location / {
        proxy_pass ${up};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;     # websocket /v1/notify
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
# w bloku http {}: map $http_upgrade $connection_upgrade { default upgrade; '' close; }`;
}

async function pickDataDir(p: Prompter, f: SetupFlags): Promise<string> {
  if (f.dataDir) return f.dataDir;
  if (f.yes) return defaultDataDir();
  p.say("Katalog danych: tu trafią konfiguracja (config.json), baza serwera i nic więcej.");
  return p.ask("Katalog danych", defaultDataDir());
}

export async function setup(f: SetupFlags, p0: Prompter = ttyPrompter()): Promise<SetupResult> {
  const yes = !!f.yes;
  // In --yes mode the step separators (empty lines) are noise.
  const p: Prompter = yes ? { ...p0, say: (s?: string) => (s ? p0.say(s) : undefined) } : p0;
  p.say("");
  p.say("discordrive-next · konfiguracja instancji");
  p.say("Enter przyjmuje wartość w nawiasie. Ctrl+C przerywa bez zapisu.");
  p.say("");

  const dataDir = await pickDataDir(p, f);
  const old = tryLoadConfig(dataDir);
  if (old) p.say(`Znaleziono konfigurację w ${configPath(dataDir)}: obecne wartości są domyślnymi.`);
  else if (existsSync(configPath(dataDir))) p.say(`Uwaga: ${configPath(dataDir)} jest uszkodzony, zostanie zastąpiony.`);
  const c: InstanceConfig = old ? structuredClone(old) : defaults(dataDir);
  c.dataDir = dataDir;
  if (f.discordApiOrigin) c.testing = { discordApiOrigin: f.discordApiOrigin };

  // 1. Tryb
  p.say("");
  if (yes) c.mode = "metadata-only";
  else
    c.mode = await p.choose(
      "1/6 Tryb instancji (jedna instancja = jeden tryb, na zawsze):",
      [
        { value: "metadata-only", label: "metadata only: serwer nie widzi plików ani webhooków, przeglądarka wysyła wprost na Discorda" },
        { value: "e2ee" as "metadata-only", label: "e2ee: wkrótce (etap 3)", disabled: true },
        { value: "plain" as "metadata-only", label: "plain (bez szyfrowania, miniatury): wkrótce (etap 3)", disabled: true },
      ],
      "metadata-only",
    );

  // 2. Adres publiczny
  p.say("");
  if (f.publicUrl) c.publicUrl = f.publicUrl.replace(/\/$/, "");
  else if (!yes) {
    p.say("2/6 Adres, pod którym użytkownicy otworzą dysk. Przeglądarka wymaga HTTPS (poza 127.0.0.1),");
    p.say("    więc dla dostępu z internetu postaw przed serwerem nginx z certyfikatem (snippet na końcu).");
    for (;;) {
      const v = (await p.ask("Adres publiczny", c.publicUrl)).replace(/\/$/, "");
      if (urlOk(v)) {
        c.publicUrl = v;
        break;
      }
      p.say("  To nie wygląda na adres. Przykład: https://dysk.example.com");
    }
  }
  if (!urlOk(c.publicUrl)) throw new Error(`zły adres publiczny: ${c.publicUrl}`);
  const pub = new URL(c.publicUrl);
  const behindProxy = !(pub.hostname === "127.0.0.1" || pub.hostname === "localhost");
  if (pub.protocol === "http:" && behindProxy) p.say("  Uwaga: http:// poza localhost: przeglądarka nie włączy service workera ani kluczy. Użyj https://.");

  // 3. Nasłuch
  p.say("");
  if (f.host) c.bind.host = f.host;
  if (f.port) c.bind.port = f.port;
  if (!yes) {
    p.say("3/6 Na jakim adresie i porcie serwer ma słuchać. Za reverse proxy: adres sieci, z której łączy się proxy");
    p.say("    (np. adres VPN), nie 0.0.0.0. Bez proxy, tylko lokalnie: 127.0.0.1.");
    for (;;) {
      const h = await p.ask("Adres nasłuchu", c.bind.host);
      if (isLocalAddress(h)) {
        c.bind.host = h;
        break;
      }
      p.say(`  ${h} nie jest adresem tej maszyny. Dostępne: ${[...new Set(["127.0.0.1", ...(await import("./checks.js")).localAddresses().filter((a) => !a.startsWith("fe80") && a !== "localhost")])].join(", ")}`);
    }
    for (;;) {
      const v = Number(await p.ask("Port", String(c.bind.port || DEFAULT_PORT)));
      if (Number.isInteger(v) && v > 0 && v < 65536) {
        c.bind.port = v;
        break;
      }
      p.say("  Port to liczba 1–65535.");
    }
  }
  if (!isLocalAddress(c.bind.host)) throw new Error(`${c.bind.host} nie jest adresem tej maszyny`);
  for (;;) {
    const st = await portState(c.bind.host, c.bind.port);
    if (st.state === "free") {
      p.say(`  Port ${c.bind.port} na ${c.bind.host}: wolny.`);
      break;
    }
    if (st.state === "ours") {
      p.say(`  Port ${c.bind.port}: działa już discordrive-next ${st.version} (zostanie zrestartowany).`);
      break;
    }
    const alt = await nextFreePort(c.bind.host, c.bind.port);
    p.say(`  Port ${c.bind.port} na ${c.bind.host} jest zajęty przez inną usługę (${st.code}).`);
    if (yes || !alt) throw new Error(`port ${c.bind.port} zajęty`);
    const v = Number(await p.ask("Inny port", String(alt)));
    if (Number.isInteger(v) && v > 0 && v < 65536) c.bind.port = v;
  }

  // 4. Proxy
  if (f.trustProxy) c.trustProxy = f.trustProxy;
  else if (!yes && behindProxy && !isLoopback(c.bind.host)) {
    p.say("");
    p.say("4/6 Adres reverse proxy (np. nginx przez VPN). Tylko od niego serwer przyjmie X-Forwarded-For,");
    p.say("    czyli prawdziwy adres IP użytkownika (limity logowania na IP). Puste = nie ufaj nikomu.");
    const v = await p.ask("Adres proxy (kilka: po przecinku)", c.trustProxy.join(", "));
    c.trustProxy = v.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (!yes && isLoopback(c.bind.host) && behindProxy) {
    const v = await p.ask("4/6 Proxy na tej maszynie? Podaj 127.0.0.1, żeby ufać X-Forwarded-For (puste = nie)", c.trustProxy.join(", "));
    c.trustProxy = v.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // 5. Bot do udostępniania
  p.say("");
  const apiOrigin = c.testing?.discordApiOrigin;
  const setToken = async (tok: string): Promise<boolean> => {
    const r = await validateBotToken(tok, apiOrigin);
    if (!r.ok) {
      p.say(`  Token nie działa: ${r.why}.`);
      return false;
    }
    c.botToken = tok;
    c.bot = { id: r.id, username: r.username };
    p.say(`  Token działa: bot ${r.username} (${r.id}). Zapisany w pliku konfiguracji (0600), nie jest nigdzie wypisywany.`);
    return true;
  };
  if (f.noBot) {
    c.botToken = null;
    c.bot = null;
  } else if (f.botTokenFile) {
    if (c.botToken && !f.replaceBot && !yes && !(await p.confirm("Zastąpić zapisany token bota tokenem z pliku?", false))) {
      p.say("  Zostaje obecny token.");
    } else if (!(await setToken(readFileSync(f.botTokenFile, "utf8").trim()))) throw new Error("token bota z pliku nie działa");
  } else if (!yes) {
    p.say("5/6 Bot instancji (opcjonalny) odświeża linki do udostępnionych plików (Discord unieważnia je po ~24 h).");
    p.say("    Bot nie musi być na niczyim serwerze i nie dostaje dostępu do plików. Bez bota udostępnianie jest wyłączone.");
    if (c.botToken) {
      p.say(`  Zapisany bot: ${c.bot?.username ?? "?"} (${c.bot?.id ?? "?"}).`);
      if (await p.confirm("Zostawić ten token?", true)) {
        const r = await validateBotToken(c.botToken, apiOrigin);
        p.say(r.ok ? "  Token nadal działa." : `  Uwaga: zapisany token nie działa (${r.why}). Sprawdź go albo uruchom setup ponownie.`);
      } else {
        for (;;) {
          const t = await p.secret("Nowy token bota (puste = wyłącz udostępnianie)");
          if (!t) {
            c.botToken = null;
            c.bot = null;
            break;
          }
          if (await setToken(t)) break;
        }
      }
    } else {
      for (;;) {
        const t = await p.secret("Token bota z discord.com/developers (puste = pomiń)");
        if (!t) {
          p.say("  Pominięto: udostępnianie będzie wyłączone. Dodasz bota później, uruchamiając setup ponownie.");
          break;
        }
        if (await setToken(t)) break;
      }
    }
  }

  // 6. Rejestracja
  p.say("");
  if (f.signup) c.signup = f.signup;
  else if (!yes) {
    c.signup = await p.choose(
      "6/6 Kto może zakładać konta:",
      [
        { value: "invite", label: "tylko z kodem zaproszenia (zalecane dla instancji w internecie)" },
        { value: "open", label: "każdy, kto zna adres (uwaga: obcy mogą zakładać konta i zajmować miejsce w bazie)" },
        { value: "closed", label: "nikt (rejestracja zamknięta)" },
      ],
      c.signup,
    );
  }
  if (c.signup === "open" && behindProxy) p.say("  Uwaga: rejestracja otwarta na publicznym adresie. Każdy z internetu może założyć konto.");

  const errs = validate(c);
  if (errs.length) throw new Error(errs.join("; "));

  // Podsumowanie + zapis
  p.say("");
  p.say("Podsumowanie:");
  p.say(`  tryb:           ${c.mode}`);
  p.say(`  adres:          ${c.publicUrl}`);
  p.say(`  nasłuch:        ${c.bind.host}:${c.bind.port}`);
  p.say(`  zaufane proxy:  ${c.trustProxy.join(", ") || "brak"}`);
  p.say(`  katalog danych: ${c.dataDir}`);
  p.say(`  bot:            ${c.botToken ? `${c.bot?.username ?? "?"} (udostępnianie włączone)` : "brak (udostępnianie wyłączone)"}`);
  p.say(`  rejestracja:    ${{ invite: "z kodem zaproszenia", open: "otwarta", closed: "zamknięta" }[c.signup]}`);
  if (!yes && !(await p.confirm("Zapisać?", true))) throw new Error("Przerwano bez zapisu.");
  const file = saveConfig(c);
  p.say(`Zapisano ${file} (0600).`);

  // Kod zaproszenia
  let invite: SetupResult["invite"] = null;
  if (c.signup === "invite" && (f.invite ?? (yes ? true : await p.confirm("Wygenerować kod zaproszenia dla pierwszego konta?", true)))) {
    const db = new DatabaseSync(dbPath(c));
    try {
      invite = new InviteStore(db).create(undefined, "setup");
    } finally {
      db.close();
    }
  }

  // systemd
  let sysd: SetupResult["systemd"] = "skipped";
  let started = false;
  if (!systemdAvailable()) {
    sysd = "unavailable";
    if (f.systemd) throw new Error("systemd --user niedostępny");
  } else if (f.systemd ?? (yes ? false : await p.confirm(`Zainstalować i uruchomić usługę systemd --user (${unitPath()})?`, true))) {
    const r = installAndStart(c.dataDir);
    sysd = "installed";
    started = true;
    p.say(`  Usługa ${r.restarted ? "zrestartowana" : "uruchomiona"}${r.written ? " (plik unitu zapisany)" : ""}.`);
    if (lingerEnabled() === false) p.say("  Uwaga: bez `loginctl enable-linger` usługa zatrzyma się po wylogowaniu.");
  }

  // Test
  let selfTest: SetupResult["selfTest"] = null;
  if (f.selfTest ?? true) {
    p.say("");
    p.say("Test: uruchomienie serwera i /v1/health…");
    const base = hostUrl(c.bind.host, c.bind.port);
    let tmp: Awaited<ReturnType<typeof serve>> | null = null;
    try {
      if (!started) {
        const st = await portState(c.bind.host, c.bind.port);
        if (st.state === "free") tmp = await serve(c, () => {});
      }
      let h = await health(base);
      for (let i = 0; !h.ok && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        h = await health(base);
      }
      if (h.ok) {
        selfTest = { ok: true, detail: `${base}/v1/health: wersja ${h.body.version}, tryb ${h.body.mode}, reguły ${h.body.rulesVersion}` };
        p.say(`  OK ${selfTest.detail}`);
      } else {
        selfTest = { ok: false, detail: `${base}/v1/health: ${h.error}` };
        p.say(`  BŁĄD ${selfTest.detail}`);
      }
      if (behindProxy) {
        const hp = await health(c.publicUrl, 8000);
        p.say(hp.ok ? `  OK ${c.publicUrl}/v1/health odpowiada (proxy działa).` : `  ${c.publicUrl}/v1/health: ${hp.error} (proxy jeszcze nie skonfigurowane? snippet niżej)`);
      }
    } finally {
      if (tmp) await tmp.close();
    }
  }

  // Co dalej
  p.say("");
  p.say("Gotowe. Co dalej:");
  p.say(`  1. Otwórz ${c.publicUrl} i załóż konto.`);
  if (invite) p.say(`  2. Kod zaproszenia (jednorazowy, ważny 7 dni): ${invite.code}`);
  else if (c.signup === "invite") p.say("  2. Kod zaproszenia wygenerujesz poleceniem: discordrive invite");
  p.say(sysd === "installed" ? "  3. Usługa: systemctl --user status discordrive-next" : `  3. Start ręczny: discordrive serve --data-dir ${c.dataDir}  (albo uruchom setup ponownie i wybierz systemd)`);
  p.say("  4. Sprawdzenie wszystkiego: discordrive doctor");
  if (behindProxy) {
    p.say("");
    p.say("Reverse proxy (nginx), jeśli jeszcze go nie ma. Na tej maszynie niczego nie zmieniam:");
    p.say(nginxSnippet(c));
  }
  return { config: c, configFile: file, invite, selfTest, systemd: sysd };
}
