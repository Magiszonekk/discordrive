// discordrive <command>
//   setup   [--data-dir DIR] [--yes] [--answers FILE] [--public-url URL] [--host H] [--port N]
//           [--trust-proxy A,B] [--signup invite|open|closed] [--bot-token-file F | --no-bot]
//           [--replace-bot] [--autostart | --no-autostart] [--accept-risk] [--no-invite] [--no-self-test]
//           [--mode metadata-only|e2ee|plain] [--webhooks-file F]   (mode: new instances only)
//           (--systemd / --no-systemd: older names of --autostart)
//   start   [--data-dir DIR]   (alias: serve)
//   doctor  [--data-dir DIR]
//   invite  [--data-dir DIR] [--days N] [--note TEXT]
//   uninstall-autostart [--data-dir DIR]   remove the background start (any system)
//   supervise [--data-dir DIR]   (used by the background start) serve + restart after a crash, log to a file
//   channels [--data-dir DIR] list | impact <id> | retire <id> | unretire <id> | move <id> [--wait] | status | remove <id> --force
//           (e2ee/plain: the instance pool's webhooks; src/channels.ts)
// Every command: --lang en|pl (or DISCORDRIVE_LANG); default = the language
// saved by setup in config.json, else English.

import { readFileSync } from "node:fs";
import { cliLang, envLang, isCliLang, setCliLang, t, type CliLang } from "./i18n.js";
import { ConfigError, configPath, defaultDataDir, loadConfig, riskAccepted, type InstanceConfig } from "./config.js";
import type { DdnServer } from "@ddv4/metadata-client/node";
import { doctor, invite } from "./doctor.js";
import { serve } from "./serve.js";
import * as autostart from "./autostart.js";
import { Cancelled, ttyPrompter, wantTui } from "./prompt.js";
import { tuiPrompter } from "./tui.js";
import { setup, type SetupFlags } from "./setup.js";

const help = () => t("cli.help", { dir: defaultDataDir() });

/** Flags that never take a value (so `channels remove <id> --force` does not eat the next word). */
const SWITCHES = new Set(["force", "wait", "yes"]);

function parse(argv: string[]): { cmd: string; opts: Record<string, string | boolean>; args: string[] } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    // Positional words only for `channels` (sub-command + webhook ID).
    if (!a.startsWith("--") && cmd === "channels") {
      args.push(a);
      continue;
    }
    if (!a.startsWith("--")) throw new Error(t("cli.badArg", { a }));
    if (cmd === "channels" && SWITCHES.has(a.slice(2))) {
      opts[a.slice(2)] = true;
      continue;
    }
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (v !== undefined) opts[k] = v;
    else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) opts[k] = rest[++i]!;
    else opts[k] = true;
  }
  return { cmd, opts, args };
}

/** `language` saved by setup, read without validating the rest (so errors are in that language). */
export function savedLanguage(dataDir: string): CliLang | null {
  try {
    const l = (JSON.parse(readFileSync(configPath(dataDir), "utf8")) as { language?: unknown }).language;
    return isCliLang(l) ? l : null;
  } catch {
    return null;
  }
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
  if (opts["bot-token"] !== undefined) throw new Error(t("cli.noBotToken"));
  const lang = pick("lang", "language");
  if (lang !== undefined && !isCliLang(lang)) throw new Error(t("cli.badLang"));
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
    autostart: bool("autostart", "autostart") ?? bool("systemd", "systemd"),
    start: bool("start", "start"),
    selfTest: bool("self-test", "selfTest"),
    discordApiOrigin: str(pick("discord-api-origin", "discordApiOrigin")),
    acceptRisk: opts["accept-risk"] === true || answers.acceptRisk === true,
    mode: str(pick("mode", "mode")) as SetupFlags["mode"],
    webhooksFile: str(pick("webhooks-file", "webhooksFile")),
    lang: (lang as CliLang | undefined) ?? envLang() ?? undefined,
  };
}

/** Keep a started server alive until Ctrl+C / SIGTERM, closing it cleanly. */
function holdOpen(srv: DdnServer, c: InstanceConfig): void {
  let closing = false;
  // SIGBREAK: Ctrl+Break in a Windows console (Ctrl+C arrives as SIGINT in cmd and PowerShell).
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      console.log(t("cli.stopping"));
      void srv.close().then(() => process.exit(0));
    });
  void c;
}

function human(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const port = (err as { port?: number }).port;
  if (err.code === "EADDRINUSE") return t("cli.portBusy", { port: port ? ` ${port}` : "" });
  if (err.code === "EADDRNOTAVAIL") return t("cli.addrNA");
  if (err.code === "EACCES" || err.code === "EPERM") return t("cli.perm", { path: err.path ? t("cli.permPath", { path: err.path }) : "" });
  return err.message ?? String(e);
}

export async function main(argv: string[]): Promise<number | "running"> {
  let cmd = "help";
  try {
    // Language before anything is printed: flag, env, saved config, English.
    const li = argv.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
    const flagLang = li < 0 ? undefined : argv[li]!.includes("=") ? argv[li]!.split("=")[1] : argv[li + 1];
    if (flagLang !== undefined && !isCliLang(flagLang)) throw new Error(t("cli.badLang"));
    const di = argv.indexOf("--data-dir");
    const dd0 = di >= 0 ? argv[di + 1] : argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1];
    setCliLang(envLang(flagLang) ?? savedLanguage(dd0 ?? defaultDataDir()) ?? "en");
    const p = parse(argv);
    cmd = p.cmd;
    const dataDir = str(p.opts["data-dir"]) ?? defaultDataDir();
    switch (p.cmd) {
      case "setup": {
        const flags = setupFlags(p.opts);
        const pr = !flags.yes && wantTui() ? tuiPrompter() : ttyPrompter();
        try {
          const r = await setup(flags, pr).catch((e) => {
            if (!(e instanceof Cancelled)) throw e;
            pr.cancelled(e.message);
            return null;
          });
          if (!r) return 130;
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
        if (!riskAccepted(c)) throw new ConfigError(t("r.needed"));
        const { portState } = await import("./checks.js");
        const st = await portState(c.bind.host, c.bind.port);
        if (st.state === "ours") {
          const bg = autostart.state(c.dataDir);
          console.error(bg.installed && bg.running !== false ? t("a.inBackground", { how: t(`a.how.${bg.backend}` as "a.how.systemd"), url: c.publicUrl }) : t("cli.alreadyRunning", { url: c.publicUrl }));
          return 1;
        }
        const srv = await serve(c, () => {});
        console.log(t("cli.running", { url: c.publicUrl }));
        holdOpen(srv, c);
        return "running";
      }
      case "supervise": {
        const c = loadConfig(dataDir);
        if (!riskAccepted(c)) throw new ConfigError(t("r.needed"));
        const { supervise } = await import("./supervise.js");
        await supervise(c);
        return "running";
      }
      case "uninstall-autostart": {
        const backend = autostart.detectBackend();
        const where = autostart.state(dataDir, backend).where;
        console.log((await autostart.uninstall(dataDir, backend)) ? t("a.removed", { where }) : t("a.none"));
        return 0;
      }
      case "doctor":
        return (await doctor(dataDir)).ok ? 0 : 1;
      case "channels": {
        const { channelsCli } = await import("./channels.js");
        return await channelsCli(dataDir, p.args, p.opts);
      }
      case "invite": {
        const r = invite(dataDir, Number(str(p.opts.days) ?? 7), str(p.opts.note) ?? "");
        console.log(r.code);
        console.error(t("cli.invite", { date: new Date(r.expiresAt).toLocaleString(cliLang() === "pl" ? "pl-PL" : "en-US") }));
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        console.log(help());
        return 0;
      default:
        console.error(`${t("cli.unknown", { cmd: p.cmd })}\n\n${help()}`);
        return 64;
    }
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `discordrive ${cmd}: ${human(e)}`);
    return 1;
  }
}
