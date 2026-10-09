// `discordrive setup`: interactive wizard (Polish), Enter accepts the value in brackets.
// Written for someone who does not know the project: it checks the
// requirements first, defaults to "only this computer" (http://localhost),
// explains every Discord step, and ends with what to open and what to run.
// Re-running edits the existing config (current values are the defaults; the
// bot token is kept unless you choose otherwise).
// Non-interactive: --yes plus flags or --answers <file.json>.

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { InviteStore } from "@ddv4/metadata-client/node";
import { health, hostUrl, isLocalAddress, isLoopback, localAddresses, nextFreePort, portState, validateBotToken } from "./checks.js";
import {
  DEFAULT_PORT,
  REPO_DIR,
  checkWritable,
  configPath,
  dbPath,
  defaultDataDir,
  defaults,
  isLocalUrl,
  saveConfig,
  tryLoadConfig,
  validate,
  type InstanceConfig,
  type SignupPolicy,
} from "./config.js";
import { ttyPrompter, type Prompter } from "./prompt.js";
import { ensureWebBuilt, serve } from "./serve.js";
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
  /** Start the server in this terminal after setup (foreground). */
  start?: boolean;
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
  /** The server was started in this process and keeps running (foreground). */
  running: Awaited<ReturnType<typeof serve>> | null;
}

const urlOk = (s: string) => {
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
  } catch {
    return false;
  }
};

/** Token file: the bare token, or an env file line `NAME=token` (first such line). */
export function tokenFromFile(path: string): string {
  const text = readFileSync(path, "utf8");
  const env = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
  return (env ? env[1]! : text).trim();
}

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

/** How to run things again, as the user would type it (from the repo directory). */
export const COMMANDS = {
  start: "npm start",
  setup: "npm run setup",
  doctor: "npm run doctor",
  invite: "npm run invite",
};

export const BOT_GUIDE = [
  "Jak zdobyć token bota (ok. 3 minuty, można to zrobić później):",
  "  1. Otwórz https://discord.com/developers/applications i zaloguj się na swoje konto Discord.",
  "  2. Kliknij „New Application”, wpisz dowolną nazwę (np. „Mój dysk”), zaakceptuj warunki, „Create”.",
  "  3. Po lewej wybierz „Bot”, potem „Reset Token” → „Yes, do it!” → „Copy”.",
  "  4. Wklej token tutaj. Bota NIE trzeba zapraszać na żaden serwer i nie potrzebuje żadnych uprawnień.",
  "  Token to hasło bota: nie pokazuj go nikomu. Tutaj wpisywanie jest niewidoczne.",
];

export async function setup(f: SetupFlags, p0: Prompter = ttyPrompter()): Promise<SetupResult> {
  const yes = !!f.yes;
  // In --yes mode the step separators (empty lines) are noise.
  const p: Prompter = yes ? { ...p0, say: (s?: string) => (s ? p0.say(s) : undefined) } : p0;
  p.say("");
  p.say("discordrive-next · konfiguracja");
  p.say("Prywatny dysk na Twoich kanałach Discorda: pliki są szyfrowane w przeglądarce, a Discord");
  p.say("przechowuje tylko zaszyfrowane kawałki. Ten kreator ustawia serwer; konto i kanały");
  p.say("założysz potem w przeglądarce (aplikacja pokaże, gdzie kliknąć).");
  p.say("Enter przyjmuje wartość w nawiasie [ ]. Ctrl+C przerywa bez zapisu.");

  // Wymagania
  p.say("");
  p.say("Sprawdzam wymagania:");
  p.say(`  OK  Node.js ${process.version}`);
  const dataDir0 = f.dataDir ?? defaultDataDir();
  const old = tryLoadConfig(dataDir0);
  const c: InstanceConfig = old ? structuredClone(old) : defaults(dataDir0);
  c.dataDir = dataDir0;
  if (f.discordApiOrigin) c.testing = { discordApiOrigin: f.discordApiOrigin };
  const w0 = checkWritable(c.dataDir);
  p.say(w0 ? `  !!  ${w0} (zapytam o inny katalog)` : `  OK  zapis w ${c.dataDir}`);
  if (w0 && yes) throw new Error(w0);
  const sysd = systemdAvailable();
  if (old) p.say(`  OK  znaleziono konfigurację (${configPath(c.dataDir)}): obecne wartości są domyślnymi`);
  else if (existsSync(configPath(c.dataDir))) p.say(`  !!  ${configPath(c.dataDir)} jest uszkodzony, zostanie zastąpiony`);

  // Kroki
  let step = 0;
  const total = 5;
  const head = (t: string) => {
    p.say("");
    p.say(`${++step}/${total} ${t}`);
  };

  // 1. Gdzie ma działać
  const scenarioOld: "local" | "public" = isLocalUrl(c.publicUrl) ? "local" : "public";
  let scenario: "local" | "public" = f.publicUrl ? (isLocalUrl(f.publicUrl) ? "local" : "public") : scenarioOld;
  if (!yes && !f.publicUrl) {
    head("Gdzie ma działać dysk?");
    scenario = await p.choose(
      "",
      [
        { value: "local", label: "Tylko na tym komputerze (najprostsze, nic nie wystawiam do sieci)" },
        { value: "public", label: "Na serwerze z własną domeną i HTTPS, dla innych urządzeń (dla zaawansowanych)" },
      ],
      scenario,
    );
  } else step++;

  if (scenario === "local") {
    if (f.port) c.bind.port = f.port;
    if (!isLoopback(c.bind.host)) c.bind.host = "127.0.0.1";
    if (f.host) c.bind.host = f.host;
    if (!yes) {
      p.say("  Dysk będzie dostępny tylko z tej przeglądarki na tym komputerze, pod adresem http://localhost:<port>.");
      p.say("  (localhost nie potrzebuje certyfikatu HTTPS: przeglądarka traktuje go jak bezpieczny adres.)");
    }
  } else {
    if (f.publicUrl) c.publicUrl = f.publicUrl.replace(/\/$/, "");
    if (f.host) c.bind.host = f.host;
    if (f.port) c.bind.port = f.port;
    if (!yes && !f.publicUrl) {
      p.say("  Potrzebujesz domeny i reverse proxy z certyfikatem (np. nginx + Let's Encrypt). Przykład vhosta");
      p.say("  wydrukuję na końcu. Przeglądarka uruchomi aplikację tylko przez https:// (albo na localhost).");
      for (;;) {
        const v = (await p.ask("Adres, który wpiszą użytkownicy (np. https://dysk.example.com)", isLocalUrl(c.publicUrl) ? "" : c.publicUrl)).replace(/\/$/, "");
        if (urlOk(v) && !isLocalUrl(v)) {
          c.publicUrl = v;
          break;
        }
        p.say("  To nie wygląda na adres. Przykład: https://dysk.example.com");
      }
      if (new URL(c.publicUrl).protocol === "http:") p.say("  Uwaga: http:// poza localhost: przeglądarka nie włączy szyfrowania ani odtwarzania wideo. Użyj https://.");
      p.say("  Na jakim adresie tej maszyny serwer ma słuchać? Proxy na tej samej maszynie: 127.0.0.1.");
      p.say("  Proxy na innej maszynie: adres sieci, przez którą łączy się proxy (LAN/VPN), nie 0.0.0.0.");
      const avail = [...new Set(["127.0.0.1", ...localAddresses().filter((a) => !a.startsWith("fe80") && a !== "localhost" && a !== "::" && a !== "0.0.0.0" && a !== "::1")])];
      for (;;) {
        const h = await p.ask("Adres nasłuchu", c.bind.host);
        if (isLocalAddress(h)) {
          c.bind.host = h;
          break;
        }
        p.say(`  ${h} nie jest adresem tej maszyny. Dostępne: ${avail.join(", ")}`);
      }
    }
    if (!urlOk(c.publicUrl)) throw new Error(`zły adres publiczny: ${c.publicUrl}`);
    if (!isLocalAddress(c.bind.host)) throw new Error(`${c.bind.host} nie jest adresem tej maszyny`);
  }

  if (!isLocalAddress(c.bind.host)) throw new Error(`${c.bind.host} nie jest adresem tej maszyny`);

  // Port
  if (!yes && !f.port) {
    for (;;) {
      const v = Number(await p.ask("Port", String(c.bind.port || DEFAULT_PORT)));
      if (Number.isInteger(v) && v > 0 && v < 65536) {
        c.bind.port = v;
        break;
      }
      p.say("  Port to liczba od 1 do 65535.");
    }
  }
  for (;;) {
    const st = await portState(c.bind.host, c.bind.port);
    if (st.state === "free") {
      p.say(`  OK  port ${c.bind.port} jest wolny`);
      break;
    }
    if (st.state === "ours") {
      p.say(`  OK  na porcie ${c.bind.port} działa już discordrive-next ${st.version} (zostanie uruchomiony ponownie z nową konfiguracją)`);
      break;
    }
    const alt = await nextFreePort(c.bind.host, c.bind.port);
    p.say(`  Port ${c.bind.port} jest zajęty przez inny program${st.code === "EACCES" ? " albo wymaga uprawnień administratora" : ""}.`);
    if (yes || !alt) throw new Error(`port ${c.bind.port} jest zajęty. Podaj inny: --port <numer>`);
    const v = Number(await p.ask("Inny port", String(alt)));
    if (Number.isInteger(v) && v > 0 && v < 65536) c.bind.port = v;
  }
  if (scenario === "local") c.publicUrl = f.publicUrl && isLocalUrl(f.publicUrl) ? f.publicUrl.replace(/\/$/, "") : `http://localhost:${c.bind.port}`;

  // Proxy (public only)
  if (scenario === "public") {
    if (f.trustProxy) c.trustProxy = f.trustProxy;
    else if (!yes) {
      p.say("  Adres reverse proxy: tylko od niego serwer przyjmie prawdziwy adres IP użytkownika");
      p.say("  (X-Forwarded-For, limity logowania). Puste = nie ufaj nikomu.");
      const v = await p.ask("Adres proxy (kilka: po przecinku)", c.trustProxy.join(", ") || (isLoopback(c.bind.host) ? "127.0.0.1" : ""));
      c.trustProxy = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  } else c.trustProxy = f.trustProxy ?? [];

  // 2. Tryb
  if (yes) {
    c.mode = "metadata-only";
    step++;
  } else {
    head("Tryb (jedna instancja = jeden tryb, na zawsze)");
    c.mode = await p.choose(
      "",
      [
        { value: "metadata-only", label: "metadata only: serwer nie widzi plików ani adresów Twoich kanałów, przeglądarka wysyła wprost na Discorda" },
        { value: "e2ee" as "metadata-only", label: "e2ee: wkrótce", disabled: true },
        { value: "plain" as "metadata-only", label: "plain (bez szyfrowania, miniatury): wkrótce", disabled: true },
      ],
      "metadata-only",
    );
  }

  // 3. Bot do udostępniania
  const apiOrigin = c.testing?.discordApiOrigin;
  const setToken = async (tok: string): Promise<boolean> => {
    const r = await validateBotToken(tok, apiOrigin);
    if (!r.ok) {
      p.say(`  Token nie działa: ${r.why}. Sprawdź, czy skopiowałeś cały token (przycisk „Copy”).`);
      return false;
    }
    c.botToken = tok;
    c.bot = { id: r.id, username: r.username };
    p.say(`  OK  token działa: bot ${r.username}. Zapisany tylko w pliku konfiguracji, nigdzie nie jest wypisywany.`);
    return true;
  };
  const skipText = "  Pominięto. Udostępnianie linkiem będzie wyłączone; wszystko inne działa. Żeby włączyć je później: " + COMMANDS.setup + ".";
  if (f.noBot) {
    c.botToken = null;
    c.bot = null;
    step++;
  } else if (f.botTokenFile) {
    step++;
    if (c.botToken && !f.replaceBot && !yes && !(await p.confirm("Zastąpić zapisany token bota tokenem z pliku?", false))) p.say("  Zostaje obecny token.");
    else if (!(await setToken(tokenFromFile(f.botTokenFile)))) throw new Error("token bota z pliku nie działa");
  } else if (yes) step++;
  else {
    head("Udostępnianie plików linkiem (opcjonalne, można pominąć)");
    p.say("  Żeby wysłać komuś link do pliku, serwer potrzebuje własnego bota Discorda: odświeża nim linki,");
    p.say("  bo Discord unieważnia je po ok. 24 h. Bot nie dostaje dostępu do Twoich plików ani kanałów.");
    p.say("  Bez bota: nie ma udostępniania linkiem. Wysyłanie, pobieranie, wideo i kilka urządzeń działają normalnie.");
    if (c.botToken) {
      p.say(`  Zapisany bot: ${c.bot?.username ?? "?"}.`);
      const keep = await p.choose(
        "",
        [
          { value: "keep", label: "Zostaw obecny token" },
          { value: "new", label: "Wpisz nowy token" },
          { value: "off", label: "Wyłącz udostępnianie (usuń token)" },
        ],
        "keep",
      );
      if (keep === "keep") {
        const r = await validateBotToken(c.botToken, apiOrigin);
        p.say(r.ok ? "  OK  token nadal działa." : `  Uwaga: zapisany token nie działa (${r.why}). Uruchom ${COMMANDS.setup} i wpisz nowy.`);
      } else if (keep === "off") {
        c.botToken = null;
        c.bot = null;
      } else {
        BOT_GUIDE.forEach((l) => p.say(l));
        for (;;) {
          const t = await p.secret("Token bota (puste = pomiń)");
          if (!t) {
            p.say(skipText);
            break;
          }
          if (await setToken(t)) break;
        }
      }
    } else {
      const want = await p.choose(
        "",
        [
          { value: "skip", label: "Pomiń na razie (zalecane na start)" },
          { value: "now", label: "Skonfiguruj teraz (pokażę krok po kroku, ok. 3 minuty)" },
        ],
        "skip",
      );
      if (want === "skip") p.say(skipText);
      else {
        BOT_GUIDE.forEach((l) => p.say(l));
        for (;;) {
          const t = await p.secret("Token bota (puste = pomiń)");
          if (!t) {
            p.say(skipText);
            break;
          }
          if (await setToken(t)) break;
        }
      }
    }
  }

  // 4. Rejestracja
  if (f.signup) {
    c.signup = f.signup;
    step++;
  } else if (!old || isLocalUrl(old.publicUrl) !== (scenario === "local")) {
    // New config or the scenario changed: the safe default for it.
    c.signup = scenario === "local" ? "open" : "invite";
  }
  if (!f.signup) {
    if (scenario === "local") {
      step++;
      if (!yes) {
        p.say("");
        p.say(`${step}/${total} Konta: zakładanie kont jest otwarte, bo serwer jest dostępny tylko z tego komputera.`);
      }
    } else if (!yes) {
      head("Kto może zakładać konta?");
      c.signup = await p.choose(
        "",
        [
          { value: "invite", label: "Tylko z kodem zaproszenia (zalecane; kod dostaniesz na końcu)" },
          { value: "open", label: "Każdy, kto zna adres (uwaga: obcy z internetu mogą zakładać konta)" },
          { value: "closed", label: "Nikt (rejestracja zamknięta)" },
        ],
        c.signup,
      );
    } else step++;
  }
  if (c.signup === "open" && scenario === "public") p.say("  Uwaga: rejestracja otwarta na publicznym adresie. Każdy z internetu może założyć konto.");

  // 5. Katalog danych
  if (!yes && !f.dataDir) {
    head("Gdzie trzymać dane serwera (konfiguracja i zaszyfrowany spis; pliki są na Discordzie)");
    for (;;) {
      const d = await p.ask("Katalog", c.dataDir);
      const why = checkWritable(d);
      if (!why) {
        c.dataDir = d;
        break;
      }
      p.say(`  ${why}. Podaj inny katalog.`);
    }
  } else {
    step++;
    const why = checkWritable(c.dataDir);
    if (why) throw new Error(why);
  }

  const errs = validate(c);
  if (errs.length) throw new Error(errs.join("; "));

  // Podsumowanie + zapis
  p.say("");
  p.say("Podsumowanie:");
  p.say(`  adres:          ${c.publicUrl}${scenario === "local" ? "  (tylko ten komputer)" : ""}`);
  p.say(`  nasłuch:        ${c.bind.host}:${c.bind.port}`);
  if (scenario === "public") p.say(`  zaufane proxy:  ${c.trustProxy.join(", ") || "brak"}`);
  p.say(`  tryb:           ${c.mode}`);
  p.say(`  udostępnianie:  ${c.botToken ? `włączone (bot ${c.bot?.username ?? "?"})` : "wyłączone (brak bota)"}`);
  p.say(`  rejestracja:    ${{ invite: "z kodem zaproszenia", open: "otwarta", closed: "zamknięta" }[c.signup]}`);
  p.say(`  dane:           ${c.dataDir}`);
  if (!yes && !(await p.confirm("Zapisać?", true))) throw new Error("Przerwano bez zapisu.");
  const file = saveConfig(c);
  p.say(`  OK  zapisano ${file}`);

  // Aplikacja w przeglądarce: zbudowana teraz, nie przy pierwszym starcie.
  try {
    ensureWebBuilt(c, (s) => p.say(`  ${s}`));
    p.say("  OK  aplikacja przeglądarkowa gotowa");
  } catch (e) {
    throw new Error(`nie udało się zbudować aplikacji przeglądarkowej: ${(e as Error).message}`);
  }

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

  // Uruchomienie: systemd (Linux) albo w tym oknie
  p.say("");
  let sysdState: SetupResult["systemd"] = sysd ? "skipped" : "unavailable";
  let started = false;
  if (f.systemd && !sysd) throw new Error("systemd --user jest niedostępny (tylko Linux z systemd)");
  if (sysd && (f.systemd ?? (yes ? false : await p.confirm("Uruchamiać dysk automatycznie w tle (usługa systemd --user, także po restarcie komputera)?", scenario === "public")))) {
    const r = installAndStart(c.dataDir);
    sysdState = "installed";
    started = true;
    p.say(`  OK  usługa ${r.restarted ? "uruchomiona ponownie" : "uruchomiona"} (${unitPath()})`);
    if (lingerEnabled() === false) p.say("  Uwaga: bez `loginctl enable-linger` usługa zatrzyma się po wylogowaniu.");
  }
  let running: SetupResult["running"] = null;
  if (!started) {
    const now = f.start ?? (yes ? false : await p.confirm("Uruchomić dysk teraz, w tym oknie?", true));
    if (now) {
      const st = await portState(c.bind.host, c.bind.port);
      if (st.state === "ours") p.say(`  Na porcie ${c.bind.port} działa już poprzednio uruchomiony dysk: zatrzymaj go (Ctrl+C w tamtym oknie) i uruchom ${COMMANDS.start}.`);
      else {
        running = await serve(c, () => {});
        started = true;
      }
    }
  }

  // Test
  let selfTest: SetupResult["selfTest"] = null;
  if (f.selfTest ?? true) {
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
      selfTest = h.ok ? { ok: true, detail: `${base}/v1/health: wersja ${h.body.version}, tryb ${h.body.mode}` } : { ok: false, detail: `${base}/v1/health: ${h.error}` };
      p.say(`  ${h.ok ? "OK " : "BŁĄD"} test serwera: ${selfTest.detail}`);
      if (scenario === "public") {
        const hp = await health(c.publicUrl, 8000);
        p.say(hp.ok ? `  OK  ${c.publicUrl} odpowiada (proxy działa)` : `  ..  ${c.publicUrl}: ${hp.error} (proxy jeszcze nie skonfigurowane? przykład niżej)`);
      }
    } finally {
      if (tmp) await tmp.close();
    }
  }

  // Co dalej
  const bar = "─".repeat(Math.min(72, Math.max(40, c.publicUrl.length + 24)));
  p.say("");
  p.say(bar);
  p.say(started ? `  Gotowe. Otwórz w przeglądarce:  ${c.publicUrl}` : `  Gotowe. Uruchom dysk (${COMMANDS.start}) i otwórz:  ${c.publicUrl}`);
  p.say(bar);
  p.say("");
  p.say("W przeglądarce:");
  p.say(`  1. Załóż konto${invite ? ` (kod zaproszenia: ${invite.code}, jednorazowy, ważny 7 dni)` : c.signup === "invite" ? ` (kod zaproszenia: ${COMMANDS.invite})` : ""}.`);
  p.say("  2. Podłącz kanał Discorda: aplikacja pokaże krok po kroku, jak założyć własny serwer Discord,");
  p.say("     kanał i webhook (wystarczy zwykłe konto Discord; 3–4 kanały = szybsze wysyłanie).");
  p.say("  3. Zapisz zestaw ratunkowy, który pokaże aplikacja: bez niego i bez urządzeń plików nie odzyskasz.");
  p.say("  4. Wyślij pliki. Telefon dołączysz kodem QR (Urządzenia → Sparuj).");
  p.say("");
  p.say(`Konfiguracja: ${file}`);
  p.say(`Dane serwera: ${c.dataDir}`);
  p.say(`Polecenia (w katalogu ${REPO_DIR}):`);
  if (sysdState === "installed") {
    p.say("  stan / zatrzymanie / start:  systemctl --user status|stop|start discordrive-next");
  } else {
    p.say(`  uruchomienie:      ${COMMANDS.start}   (zatrzymanie: Ctrl+C w tym oknie)`);
  }
  p.say(`  zmiana ustawień:   ${COMMANDS.setup}`);
  p.say(`  coś nie działa:    ${COMMANDS.doctor}`);
  if (c.signup === "invite") p.say(`  nowy kod zaproszenia: ${COMMANDS.invite}`);
  if (scenario === "public") {
    p.say("");
    p.say("Przykładowy vhost nginx (niczego nie zmieniam na innych maszynach):");
    p.say(nginxSnippet(c));
  }
  if (running) {
    p.say("");
    p.say(`Dysk działa w tym oknie. Nie zamykaj go, dopóki korzystasz z dysku. Ctrl+C zatrzymuje.`);
  }
  return { config: c, configFile: file, invite, selfTest, systemd: sysdState, running };
}
