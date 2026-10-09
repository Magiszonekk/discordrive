// discordrive <command>
//   setup   [--data-dir DIR] [--yes] [--answers FILE] [--public-url URL] [--host H] [--port N]
//           [--trust-proxy A,B] [--signup invite|open|closed] [--bot-token-file F | --no-bot]
//           [--replace-bot] [--systemd | --no-systemd] [--no-invite] [--no-self-test]
//   start   [--data-dir DIR]   (alias: serve)
//   doctor  [--data-dir DIR]
//   invite  [--data-dir DIR] [--days N] [--note TEXT]

import { readFileSync } from "node:fs";
import { ConfigError, defaultDataDir, loadConfig, type InstanceConfig } from "./config.js";
import type { DdnServer } from "@ddv4/metadata-client/node";
import { doctor, invite } from "./doctor.js";
import { serve } from "./serve.js";
import { ttyPrompter } from "./prompt.js";
import { setup, type SetupFlags } from "./setup.js";

const HELP = `discordrive: instancja discordrive-next (w katalogu repo: npm run <polecenie>)

  setup    kreator konfiguracji (ponowne uruchomienie = zmiana ustawień)   npm run setup
  start    uruchom dysk w tym oknie (Ctrl+C zatrzymuje)                     npm start
  doctor   sprawdź, co nie działa                                           npm run doctor
  invite   nowy jednorazowy kod zaproszenia                                 npm run invite

Wspólne: --data-dir DIR (domyślnie ${defaultDataDir()})
setup bez pytań: --yes [--answers plik.json] [--public-url URL] [--host H] [--port N]
  [--trust-proxy A,B] [--signup invite|open|closed] [--bot-token-file PLIK | --no-bot]
  [--replace-bot] [--systemd|--no-systemd] [--start] [--no-invite] [--no-self-test]
Token bota podaje się tylko interaktywnie albo plikiem (nigdy w linii poleceń).`;

function parse(argv: string[]): { cmd: string; opts: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`nieznany argument: ${a}`);
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (v !== undefined) opts[k] = v;
    else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) opts[k] = rest[++i]!;
    else opts[k] = true;
  }
  return { cmd, opts };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function setupFlags(opts: Record<string, string | boolean>): SetupFlags {
  const answers = str(opts.answers) ? (JSON.parse(readFileSync(str(opts.answers)!, "utf8")) as Record<string, unknown>) : {};
  const pick = (k: string, a: string) => opts[k] ?? answers[a];
  const bool = (k: string, a: string): boolean | undefined => {
    if (opts[`no-${k}`] === true) return false;
    const v = pick(k, a);
    return v === undefined ? undefined : v === true || v === "true";
  };
  const tp = pick("trust-proxy", "trustProxy");
  if (opts["bot-token"] !== undefined) throw new Error("--bot-token jest niedozwolony (token trafiłby do historii powłoki). Użyj --bot-token-file albo trybu interaktywnego.");
  return {
    yes: opts.yes === true,
    dataDir: str(pick("data-dir", "dataDir")),
    publicUrl: str(pick("public-url", "publicUrl")),
    host: str(pick("host", "host")),
    port: pick("port", "port") !== undefined ? Number(pick("port", "port")) : undefined,
    trustProxy: tp === undefined ? undefined : Array.isArray(tp) ? (tp as string[]) : String(tp).split(",").map((s) => s.trim()).filter(Boolean),
    signup: str(pick("signup", "signup")) as SetupFlags["signup"],
    botTokenFile: str(pick("bot-token-file", "botTokenFile")),
    noBot: opts["no-bot"] === true || answers.bot === false,
    replaceBot: opts["replace-bot"] === true || answers.replaceBot === true,
    invite: bool("invite", "invite"),
    systemd: bool("systemd", "systemd"),
    start: bool("start", "start"),
    selfTest: bool("self-test", "selfTest"),
    discordApiOrigin: str(pick("discord-api-origin", "discordApiOrigin")),
  };
}

/** Keep a started server alive until Ctrl+C / SIGTERM, closing it cleanly. */
function holdOpen(srv: DdnServer, c: InstanceConfig): void {
  let closing = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      console.log("\nZatrzymuję dysk…");
      void srv.close().then(() => process.exit(0));
    });
  void c;
}

function human(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err.code === "EADDRINUSE") return `port${(err as { port?: number }).port ? ` ${(err as { port?: number }).port}` : ""} jest zajęty przez inny program. Zamknij go albo wybierz inny port: npm run setup`;
  if (err.code === "EADDRNOTAVAIL") return "adres nasłuchu nie istnieje na tej maszynie (sieć/VPN wyłączone?). Zmień go: npm run setup";
  if (err.code === "EACCES" || err.code === "EPERM") return `brak uprawnień${err.path ? ` do ${err.path}` : ""}. Wybierz inny katalog danych albo port powyżej 1024: npm run setup`;
  return err.message ?? String(e);
}

export async function main(argv: string[]): Promise<number | "running"> {
  let cmd = "help";
  try {
    const p = parse(argv);
    cmd = p.cmd;
    const dataDir = str(p.opts["data-dir"]) ?? defaultDataDir();
    switch (p.cmd) {
      case "setup": {
        const pr = ttyPrompter();
        try {
          const r = await setup(setupFlags(p.opts), pr);
          if (r.running) {
            holdOpen(r.running, r.config);
            return "running";
          }
          return r.selfTest && !r.selfTest.ok ? 2 : 0;
        } finally {
          pr.close();
        }
      }
      case "start":
      case "serve": {
        const c = loadConfig(dataDir);
        const { portState } = await import("./checks.js");
        const st = await portState(c.bind.host, c.bind.port);
        if (st.state === "ours") {
          console.error(`Dysk już działa (w innym oknie albo jako usługa): otwórz ${c.publicUrl}`);
          return 1;
        }
        const srv = await serve(c, () => {});
        console.log(`Dysk działa: otwórz ${c.publicUrl}\nZatrzymanie: Ctrl+C. Problemy: npm run doctor`);
        holdOpen(srv, c);
        return "running";
      }
      case "doctor":
        return (await doctor(dataDir)).ok ? 0 : 1;
      case "invite": {
        const r = invite(dataDir, Number(str(p.opts.days) ?? 7), str(p.opts.note) ?? "");
        console.log(r.code);
        console.error(`(jednorazowy, ważny do ${new Date(r.expiresAt).toLocaleString("pl-PL")})`);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      default:
        console.error(`Nieznane polecenie: ${p.cmd}\n\n${HELP}`);
        return 64;
    }
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `discordrive ${cmd}: ${human(e)}`);
    return 1;
  }
}
