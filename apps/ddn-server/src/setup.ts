// `discordrive setup`: interactive wizard (English by default, Polish with --lang pl,
// DISCORDRIVE_LANG=pl or the first question), Enter accepts the value in brackets.
// Written for someone who does not know the project: it checks the
// requirements first, defaults to "only this computer" (http://localhost),
// explains every Discord step, and ends with what to open and what to run.
// Re-running edits the existing config (current values are the defaults; the
// bot token is kept unless you choose otherwise).
// Non-interactive: --yes plus flags or --answers <file.json>; --yes does NOT accept the risk
// notice, that needs --accept-risk (or "acceptRisk": true in the answers file).
// First step after the language: the risk notice (Discord's Terms of Service, no warranty) with
// "Cancel" preselected; Enter alone cancels. The acceptance is saved in config.json and asked
// again only when RISK_VERSION changes; `start` and `doctor` refuse to run without it.
// Interface: arrow keys (tui.ts) on an interactive terminal, plain numbered
// questions otherwise (prompt.ts); the wizard logic below is the same for both.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { InviteStore } from "@ddv4/metadata-client/node";
import { health, hostUrl, isLocalAddress, isLoopback, localAddresses, nextFreePort, portState, validateBotToken } from "./checks.js";
import {
  DEFAULT_PORT,
  MODES,
  REPO_DIR,
  availableModes,
  RISK_VERSION,
  checkWritable,
  configPath,
  dbPath,
  defaultDataDir,
  defaults,
  isLocalUrl,
  riskAccepted,
  saveConfig,
  tryLoadConfig,
  validate,
  type InstanceConfig,
  type InstanceMode,
  type SignupPolicy,
} from "./config.js";
import { setCliLang, t, type CliLang } from "./i18n.js";
import { Cancelled, ttyPrompter, type Prompter } from "./prompt.js";
import { buildWeb, loadServerMode, serve } from "./serve.js";
import { LOG_FILE, detectBackend, install as autostartInstall, lingerOff } from "./autostart.js";
import { join } from "node:path";

/** The threat model, one chapter per mode (shown under the mode step). Relative to the repository. */
export const THREAT_MODEL_DOC = "docs/threat-model.md";
export const THREAT_MODEL_SECTION: Record<InstanceMode, string> = { "metadata-only": "3", e2ee: "4", plain: "5" };

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
  /** Run in the background at log-on (systemd --user / Task Scheduler / LaunchAgent / XDG autostart). `--systemd` is an alias. */
  autostart?: boolean;
  /** Start the server in this terminal after setup (foreground). */
  start?: boolean;
  selfTest?: boolean;
  /** Accept the risk notice without the question (required with --yes, see RISK_VERSION). */
  acceptRisk?: boolean;
  /** Language of the wizard and the instance default (skips the first question). */
  lang?: CliLang;
  /** Tests: Discord API on a fake. */
  discordApiOrigin?: string;
  /** Mode of a NEW instance (koncept §2); an existing instance keeps its mode. Default metadata-only. */
  mode?: InstanceMode;
  /** e2ee/plain: file with webhook URLs for the instance pool, one per line (never on the command line). */
  webhooksFile?: string;
}

export interface SetupResult {
  config: InstanceConfig;
  configFile: string;
  invite: { code: string; expiresAt: number } | null;
  selfTest: { ok: boolean; detail: string } | null;
  /** Background start: registered, declined, or no backend on this system. */
  autostart: "installed" | "skipped" | "unavailable";
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
    ${t("s.nginxCert", { host })}

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
${t("s.nginxMap")}`;
}

/** How to run things again, as the user would type it (from the repo directory). */
export const COMMANDS = {
  start: "npm start",
  setup: "npm run setup",
  doctor: "npm run doctor",
  invite: "npm run invite",
  uninstallAutostart: "npm run uninstall-autostart",
};

/** Word-wrap for the framed risk notice (the frame does not wrap by itself on narrow terminals). */
export function wrap(text: string, width = Math.max(40, Math.min(76, (process.stdout.columns || 80) - 8))): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    const indent = /^\d+\. /.test(para) ? "   " : "";
    for (const w of para.split(" ")) {
      if (line && (line + " " + w).length > width) {
        out.push(line);
        line = indent + w;
      } else line = line ? `${line} ${w}` : w;
    }
    out.push(line);
  }
  return out;
}

/**
 * The risk notice, first step after the language. Default = Cancel: Enter alone does not accept.
 * Resolves with the acceptance to save, or throws Cancelled (nothing is saved).
 */
export async function acceptRisk(p: Prompter, yes: boolean, flag: boolean | undefined, saved: InstanceConfig["acceptedRisk"]): Promise<NonNullable<InstanceConfig["acceptedRisk"]>> {
  if (saved && riskAccepted({ acceptedRisk: saved })) return saved;
  if (flag) return { version: RISK_VERSION, at: new Date().toISOString() };
  if (yes) throw new Error(t("r.yesNeedsFlag"));
  const text = [...wrap(t("r.tos")), "", ...wrap(t("r.warranty"))];
  p.note(t("r.title"), text);
  if (!p.tui) p.say(t("r.plainHelp"));
  const v = await p.choose(
    t("r.q"),
    [
      { value: "accept", label: t("r.accept") },
      { value: "cancel", label: t("r.cancel") },
    ],
    "cancel",
  );
  if (v !== "accept") throw new Cancelled(t("r.declined"));
  return { version: RISK_VERSION, at: new Date().toISOString() };
}

export const botGuide = (): string[] => [t("s.guide0"), t("s.guide1"), t("s.guide2"), t("s.guide3"), t("s.guide4"), t("s.guide5")];

export async function setup(f: SetupFlags, p0?: Prompter): Promise<SetupResult> {
  const yes = !!f.yes;
  const p: Prompter = p0 ?? ttyPrompter();
  // In --yes mode the step separators (empty lines) are noise.
  if (yes && !p.tui) p.compact = true;
  const dataDir0 = f.dataDir ?? defaultDataDir();
  const old = tryLoadConfig(dataDir0);
  const c: InstanceConfig = old ? structuredClone(old) : defaults(dataDir0);
  c.dataDir = dataDir0;

  // Language: flag/env, else ask first (Enter = the saved one, else English).
  c.language = f.lang ?? old?.language ?? "en";
  setCliLang(c.language);
  if (!yes && !f.lang) {
    if (p.tui) p.intro("discordrive-next", []);
    else p.say("");
    c.language = await p.choose(
      t("lang.q"),
      [
        { value: "en", label: t("lang.en") },
        { value: "pl", label: t("lang.pl") },
      ],
      c.language,
    );
    setCliLang(c.language);
  }

  // Risk notice (Discord's Terms of Service + no warranty): before anything else is checked or asked.
  const wasAccepted = !!old && riskAccepted(old);
  c.acceptedRisk = await acceptRisk(p, yes, f.acceptRisk, old?.acceptedRisk);
  if (!wasAccepted && !yes) p.ok(t("r.accepted", { date: c.acceptedRisk.at.slice(0, 10) }));

  if (p.tui) p.info([t("s.title"), t("s.intro1"), t("s.intro2"), t("s.intro3"), t("tui.intro4")].join("\n"));
  else p.intro(t("s.title"), [t("s.intro1"), t("s.intro2"), t("s.intro3"), t("s.intro4")]);

  // Requirements
  if (!p.tui) p.note(t("s.req"), []);
  p.ok(`Node.js ${process.version}`);
  if (f.discordApiOrigin) c.testing = { discordApiOrigin: f.discordApiOrigin };
  const w0 = checkWritable(c.dataDir);
  if (w0) p.warn(t("s.reqWriteBad", { why: w0 }));
  else p.ok(t("s.reqWriteOk", { dir: c.dataDir }));
  if (w0 && yes) throw new Error(w0);
  const backend = detectBackend();
  if (old) p.ok(t("s.reqOld", { file: configPath(c.dataDir) }));
  else if (existsSync(configPath(c.dataDir))) p.warn(t("s.reqBroken", { file: configPath(c.dataDir) }));

  // Steps
  let step = 0;
  const total = 5;
  const head = (title: string) => p.step(++step, total, title);

  // 1. Where it runs
  const scenarioOld: "local" | "public" = isLocalUrl(c.publicUrl) ? "local" : "public";
  let scenario: "local" | "public" = f.publicUrl ? (isLocalUrl(f.publicUrl) ? "local" : "public") : scenarioOld;
  if (!yes && !f.publicUrl) {
    head(t("s.where"));
    scenario = await p.choose(
      "",
      [
        { value: "local", label: t("s.where.local") },
        { value: "public", label: t("s.where.public") },
      ],
      scenario,
    );
  } else step++;

  if (scenario === "local") {
    if (f.port) c.bind.port = f.port;
    if (!isLoopback(c.bind.host)) c.bind.host = "127.0.0.1";
    if (f.host) c.bind.host = f.host;
    if (!yes) p.info(`${t("s.local1")}\n${t("s.local2")}`);
  } else {
    if (f.publicUrl) c.publicUrl = f.publicUrl.replace(/\/$/, "");
    if (f.host) c.bind.host = f.host;
    if (f.port) c.bind.port = f.port;
    if (!yes && !f.publicUrl) {
      p.info(`${t("s.pub1")}\n${t("s.pub2")}`);
      const url = await p.ask(t("s.pubUrl"), isLocalUrl(c.publicUrl) ? "" : c.publicUrl, (v) => {
        const u = v.replace(/\/$/, "");
        return urlOk(u) && !isLocalUrl(u) ? undefined : t("s.pubUrlBad");
      });
      c.publicUrl = url.replace(/\/$/, "");
      if (new URL(c.publicUrl).protocol === "http:") p.warn(t("s.pubHttp"));
      p.info(`${t("s.bind1")}\n${t("s.bind2")}`);
      const avail = [...new Set(["127.0.0.1", ...localAddresses().filter((a) => !a.startsWith("fe80") && a !== "localhost" && a !== "::" && a !== "0.0.0.0" && a !== "::1")])];
      c.bind.host = await p.ask(t("s.bind"), c.bind.host, (h) => (isLocalAddress(h) ? undefined : t("s.bindBad", { host: h, list: avail.join(", ") })));
    }
    if (!urlOk(c.publicUrl)) throw new Error(t("s.badPublicUrl", { url: c.publicUrl }));
  }

  if (!isLocalAddress(c.bind.host)) throw new Error(t("s.notLocalAddr", { host: c.bind.host }));

  // Port: validated while typing (range, then busy?), a free one is suggested.
  const portProblem = async (v: string): Promise<string | undefined> => {
    const n = Number(v);
    if (!/^\d+$/.test(v.trim()) || !Number.isInteger(n) || n < 1 || n > 65535) return t("s.portRange");
    const st = await portState(c.bind.host, n);
    if (st.state !== "busy") return undefined;
    const alt = await nextFreePort(c.bind.host, n);
    return `${t("s.portBusy", { port: n, root: st.code === "EACCES" ? t("s.portBusyRoot") : "" })}${alt ? ` ${t("tui.tryPort", { port: alt })}` : ""}`;
  };
  if (!yes && !f.port) c.bind.port = Number(await p.ask(t("s.port"), String(c.bind.port || DEFAULT_PORT), portProblem));
  for (;;) {
    const st = await portState(c.bind.host, c.bind.port);
    if (st.state === "free") {
      p.ok(t("s.portFree", { port: c.bind.port }));
      break;
    }
    if (st.state === "ours") {
      p.ok(t("s.portOurs", { port: c.bind.port, version: st.version }));
      break;
    }
    // Busy (only reached with --port/--yes, or if the port got taken meanwhile).
    const alt = await nextFreePort(c.bind.host, c.bind.port);
    p.warn(t("s.portBusy", { port: c.bind.port, root: st.code === "EACCES" ? t("s.portBusyRoot") : "" }));
    if (yes || !alt) throw new Error(t("s.portBusyErr", { port: c.bind.port }));
    c.bind.port = Number(await p.ask(t("s.portOther"), String(alt), portProblem));
  }
  if (scenario === "local") c.publicUrl = f.publicUrl && isLocalUrl(f.publicUrl) ? f.publicUrl.replace(/\/$/, "") : `http://localhost:${c.bind.port}`;

  // Proxy (public only)
  if (scenario === "public") {
    if (f.trustProxy) c.trustProxy = f.trustProxy;
    else if (!yes) {
      p.info(`${t("s.proxy1")}\n${t("s.proxy2")}`);
      const v = await p.ask(t("s.proxy"), c.trustProxy.join(", ") || (isLoopback(c.bind.host) ? "127.0.0.1" : ""));
      c.trustProxy = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  } else c.trustProxy = f.trustProxy ?? [];

  // 2. Mode: chosen once, for a new instance only (koncept §2: one instance = one mode, forever).
  // "Existing" = the config says so or the database was already started (it locks the mode).
  const locked: InstanceMode | null = old?.mode ?? null;
  const avail = availableModes();
  let poolUrls: string[] = [];
  if (locked) {
    if (f.mode && f.mode !== locked) throw new Error(t("s.mode.change", { old: locked, mode: f.mode }));
    c.mode = locked;
    step++;
    if (!yes) p.info(t("s.mode.locked", { mode: c.mode }));
  } else if (f.mode || yes) {
    c.mode = f.mode ?? "metadata-only";
    if (!avail.includes(c.mode)) throw new Error(t("s.mode.soon", { mode: c.mode }));
    step++;
  } else {
    head(t("s.mode"));
    const label = { "metadata-only": t("s.mode.mo"), e2ee: t("s.mode.e2ee"), plain: t("s.mode.plain") };
    // One line per mode: what the server sees (docs/threat-model.md, one chapter per mode).
    const sees = { "metadata-only": t("s.mode.mo.sees"), e2ee: t("s.mode.e2ee.sees"), plain: t("s.mode.plain.sees") };
    c.mode = await p.choose(
      "",
      MODES.map((m) => ({ value: m, label: avail.includes(m) ? label[m] : t("s.mode.soon", { mode: m }), detail: sees[m], disabled: !avail.includes(m) })),
      "metadata-only",
    );
    p.info(t("s.mode.tm", { path: join(REPO_DIR, THREAT_MODEL_DOC), section: THREAT_MODEL_SECTION[c.mode] }));
  }

  // 2b. e2ee/plain: the instance's own channels (pool); URLs go to the encrypted table, not the config.
  if (c.mode === "plain") {
    // Optional dependency: thumbnails/previews. Missing = a clear warning, not a failure.
    const which = (b: string) => {
      try {
        return spawnSync(b, ["-version"], { stdio: "ignore", timeout: 10_000, windowsHide: true }).status === 0;
      } catch {
        return false;
      }
    };
    const ff = process.env.DDN_FFMPEG || "ffmpeg";
    const fp = process.env.DDN_FFPROBE || "ffprobe";
    if (which(ff) && which(fp)) p.ok(t("s.ffmpegOk"));
    else p.warn(t(process.platform === "win32" ? "d.ffmpegMissingWin" : process.platform === "darwin" ? "d.ffmpegMissingMac" : "d.ffmpegMissingLinux"));
  }
  if (c.mode !== "metadata-only") {
    if (f.webhooksFile) {
      try {
        poolUrls = readFileSync(f.webhooksFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      } catch (e) {
        throw new Error(t("s.poolFileBad", { why: (e as Error).message }));
      }
    } else if (!yes) {
      p.info([t("s.pool"), t("s.pool1"), t("s.pool2")].join("\n"));
      for (;;) {
        const u = (await p.secret(t("s.poolUrl"))).trim();
        if (!u) break;
        poolUrls.push(u);
      }
    }
  }

  // 3. Bot for share links
  const apiOrigin = c.testing?.discordApiOrigin;
  const setToken = async (tok: string): Promise<boolean> => {
    const r = await validateBotToken(tok, apiOrigin);
    if (!r.ok) {
      p.warn(t("s.botBad", { why: r.why }));
      return false;
    }
    c.botToken = tok;
    c.bot = { id: r.id, username: r.username };
    p.ok(t("s.botOk", { name: r.username }));
    return true;
  };
  /** Token prompt: in the TUI a wrong token is refused under the field (checked with Discord). */
  const askToken = async () => {
    botGuide().forEach((l, i) => (i === 0 ? p.info(l) : p.say(l)));
    let checked: { id: string; username: string } | null = null;
    for (;;) {
      const tok = await p.secret(
        t("s.botToken"),
        p.tui
          ? async (v) => {
              if (!v.trim()) return undefined;
              const r = await validateBotToken(v.trim(), apiOrigin);
              if (!r.ok) return t("s.botBad", { why: r.why });
              checked = { id: r.id, username: r.username };
              return undefined;
            }
          : undefined,
      );
      if (!tok) {
        p.info(skipText);
        return;
      }
      if (checked) {
        c.botToken = tok;
        c.bot = checked;
        p.ok(t("s.botOk", { name: (checked as { username: string }).username }));
        return;
      }
      if (await setToken(tok)) return;
    }
  };
  const skipText = t("s.botSkip", { cmd: COMMANDS.setup });
  if (f.noBot) {
    c.botToken = null;
    c.bot = null;
    step++;
  } else if (f.botTokenFile) {
    step++;
    if (c.botToken && !f.replaceBot && !yes && !(await p.confirm(t("s.botReplace"), false))) p.info(t("s.botKept"));
    else if (!(await setToken(tokenFromFile(f.botTokenFile)))) throw new Error(t("s.botFileBad"));
  } else if (yes) step++;
  else {
    head(t("s.bot"));
    p.info([t("s.bot1"), t("s.bot2"), t("s.bot3")].join("\n"));
    if (c.botToken) {
      p.info(t("s.botSaved", { name: c.bot?.username ?? "?" }));
      const keep = await p.choose(
        "",
        [
          { value: "keep", label: t("s.bot.keep") },
          { value: "new", label: t("s.bot.new") },
          { value: "off", label: t("s.bot.off") },
        ],
        "keep",
      );
      if (keep === "keep") {
        const r = await validateBotToken(c.botToken, apiOrigin);
        if (r.ok) p.ok(t("s.botStillOk"));
        else p.warn(t("s.botStillBad", { why: r.why, cmd: COMMANDS.setup }));
      } else if (keep === "off") {
        c.botToken = null;
        c.bot = null;
      } else await askToken();
    } else {
      const want = await p.choose(
        "",
        [
          { value: "skip", label: t("s.bot.skip") },
          { value: "now", label: t("s.bot.now") },
        ],
        "skip",
      );
      if (want === "skip") p.info(skipText);
      else await askToken();
    }
  }

  // 4. Sign-up
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
        p.step(step, total, t("s.signupLocal"));
      }
    } else if (!yes) {
      head(t("s.signup"));
      c.signup = await p.choose(
        "",
        [
          { value: "invite", label: t("s.signup.invite") },
          { value: "open", label: t("s.signup.open") },
          { value: "closed", label: t("s.signup.closed") },
        ],
        c.signup,
      );
    } else step++;
  }
  if (c.signup === "open" && scenario === "public") p.warn(t("s.signupOpenPublic"));

  // 5. Data directory (write access checked while typing)
  if (!yes && !f.dataDir) {
    head(t("s.data"));
    c.dataDir = await p.ask(t("s.dataDir"), c.dataDir, (d) => {
      const why = checkWritable(d);
      return why ? t("s.dataBad", { why }) : undefined;
    });
  } else {
    step++;
    const why = checkWritable(c.dataDir);
    if (why) throw new Error(why);
  }

  const errs = validate(c);
  if (errs.length) throw new Error(errs.join("; "));

  // Summary + save
  p.note(t("tui.summary"), [
    t("s.sum.addr", { url: c.publicUrl, local: scenario === "local" ? t("s.sum.local") : "" }),
    t("s.sum.bind", { bind: `${c.bind.host}:${c.bind.port}` }),
    ...(scenario === "public" ? [t("s.sum.proxy", { list: c.trustProxy.join(", ") || t("s.sum.none") })] : []),
    t("s.sum.mode", { mode: c.mode }),
    ...(c.mode !== "metadata-only" ? [t("s.sum.pool", { v: poolUrls.length ? String(poolUrls.length) : t("s.sum.none") })] : []),
    t("s.sum.lang", { lang: c.language === "pl" ? t("lang.pl") : t("lang.en") }),
    t("s.sum.share", { v: c.botToken ? t("s.sum.shareOn", { name: c.bot?.username ?? "?" }) : t("s.sum.shareOff") }),
    t("s.sum.signup", { v: t(`signup.${c.signup}`) }),
    t("s.sum.data", { dir: c.dataDir }),
  ]);
  if (!yes && !(await p.confirm(t("s.save"), true))) throw new Cancelled(t("s.notSaved"));
  const file = saveConfig(c);
  p.ok(t("s.saved", { file }));

  // Browser app + server part of this mode: built now (spinner), not at the first start.
  await p.task(
    t("tui.building"),
    () => buildWeb(c).catch((e: Error) => Promise.reject(new Error(t("s.webFail", { msg: e.message })))),
    () => ({ level: "ok", text: t("s.webOk") }),
  );

  // e2ee/plain: store the pool webhooks (checked with Discord, sealed with instance.key).
  if (c.mode !== "metadata-only") {
    const sm = await loadServerMode(c);
    if (poolUrls.length && sm.addPoolWebhooks) {
      try {
        const r = await sm.addPoolWebhooks(c, poolUrls);
        p.ok(t("s.poolOk", r));
      } catch (e) {
        throw new Error(t("s.poolBad", { why: String((e as Error).message).replace(/https?:\/\/\S+/g, "<url>") }));
      }
    } else if (!old) p.warn(t("s.poolNone"));
  }

  // Invite code
  let invite: SetupResult["invite"] = null;
  if (c.signup === "invite" && (f.invite ?? (yes ? true : await p.confirm(t("s.inviteQ"), true)))) {
    const db = new DatabaseSync(dbPath(c));
    try {
      invite = new InviteStore(db).create(undefined, "setup");
    } finally {
      db.close();
    }
  }

  // Start: in the background (systemd --user / Task Scheduler / LaunchAgent / XDG autostart) or in this window
  let autoState: SetupResult["autostart"] = backend === "none" ? "unavailable" : "skipped";
  let started = false;
  if (f.autostart && backend === "none") throw new Error(t("a.unavailable"));
  if (backend !== "none" && (f.autostart ?? (yes ? false : await p.confirm(t("a.q", { how: t(`a.how.${backend}`) }), scenario === "public")))) {
    const r = await autostartInstall(c.dataDir, backend);
    autoState = "installed";
    started = true;
    p.ok(t("a.ok", { how: r.replaced ? t("a.restarted") : t("a.started"), where: r.where }));
    if (lingerOff(backend)) p.warn(t("s.linger"));
  }
  let running: SetupResult["running"] = null;
  if (!started) {
    const now = f.start ?? (yes ? false : await p.confirm(t("s.startQ"), true));
    if (now) {
      const st = await portState(c.bind.host, c.bind.port);
      if (st.state === "ours") p.warn(t("s.alreadyRunning", { port: c.bind.port, cmd: COMMANDS.start }));
      else {
        running = await serve(c, () => {});
        started = true;
      }
    }
  }

  // Self-test (spinner)
  let selfTest: SetupResult["selfTest"] = null;
  if (f.selfTest ?? true) {
    const base = hostUrl(c.bind.host, c.bind.port);
    selfTest = await p.task(
      t("tui.testing"),
      async () => {
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
          return h.ok ? { ok: true, detail: t("s.selfOk", { base, version: String(h.body.version), mode: String(h.body.mode) }) } : { ok: false, detail: `${base}/v1/health: ${h.error}` };
        } finally {
          if (tmp) await tmp.close();
        }
      },
      (r) => ({ level: r.ok ? "ok" : "fail", text: t("s.selfLine", { detail: r.detail }) }),
    );
    if (scenario === "public") {
      const hp = await health(c.publicUrl, 8000);
      if (hp.ok) p.ok(t("s.pubOk", { url: c.publicUrl }));
      else p.info(t("s.pubNo", { url: c.publicUrl, err: hp.error }));
    }
  }

  // What next
  p.note(t("s.inBrowser"), [
    t("s.next1", { invite: invite ? t("s.next1code", { code: invite.code }) : c.signup === "invite" ? t("s.next1cmd", { cmd: COMMANDS.invite }) : "" }),
    t("s.next2a"),
    `   ${t("s.next2b")}`,
    t("s.next3"),
    t("s.next4"),
  ]);
  p.note(t("s.cmds", { dir: REPO_DIR }), [
    ...(autoState === "installed" ? [t(`a.cmd.${backend}` as "a.cmd.systemd", { log: join(c.dataDir, LOG_FILE) }), t("a.cmdRemove", { cmd: COMMANDS.uninstallAutostart })] : [t("s.cmdStart", { cmd: COMMANDS.start })]),
    t("s.cmdSetup", { cmd: COMMANDS.setup }),
    t("s.cmdDoctor", { cmd: COMMANDS.doctor }),
    ...(c.signup === "invite" ? [t("s.cmdInvite", { cmd: COMMANDS.invite })] : []),
    "",
    t("s.cfgFile", { file }),
    t("s.dataAt", { dir: c.dataDir }),
  ]);
  if (scenario === "public") {
    p.info(t("s.nginx"));
    p.raw(nginxSnippet(c));
  }
  if (running) p.info(t("s.running"));
  p.done(started ? t("s.doneOpen", { url: c.publicUrl }) : t("s.doneStart", { cmd: COMMANDS.start, url: c.publicUrl }));
  return { config: c, configFile: file, invite, selfTest, autostart: autoState, running };
}
