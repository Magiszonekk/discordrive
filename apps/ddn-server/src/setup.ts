// `discordrive setup`: interactive wizard (English by default, Polish with --lang pl,
// DISCORDRIVE_LANG=pl or the first question), Enter accepts the value in brackets.
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
import { setCliLang, t, type CliLang } from "./i18n.js";
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
  /** Language of the wizard and the instance default (skips the first question). */
  lang?: CliLang;
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
};

export const botGuide = (): string[] => [t("s.guide0"), t("s.guide1"), t("s.guide2"), t("s.guide3"), t("s.guide4"), t("s.guide5")];

export async function setup(f: SetupFlags, p0: Prompter = ttyPrompter()): Promise<SetupResult> {
  const yes = !!f.yes;
  // In --yes mode the step separators (empty lines) are noise.
  const p: Prompter = yes ? { ...p0, say: (s?: string) => (s ? p0.say(s) : undefined) } : p0;
  const dataDir0 = f.dataDir ?? defaultDataDir();
  const old = tryLoadConfig(dataDir0);
  const c: InstanceConfig = old ? structuredClone(old) : defaults(dataDir0);
  c.dataDir = dataDir0;

  // Language: flag/env, else ask first (Enter = the saved one, else English).
  c.language = f.lang ?? old?.language ?? "en";
  setCliLang(c.language);
  if (!yes && !f.lang) {
    p.say("");
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

  p.say("");
  p.say(t("s.title"));
  p.say(t("s.intro1"));
  p.say(t("s.intro2"));
  p.say(t("s.intro3"));
  p.say(t("s.intro4"));

  // Requirements
  p.say("");
  p.say(t("s.req"));
  p.say(`  OK  Node.js ${process.version}`);
  if (f.discordApiOrigin) c.testing = { discordApiOrigin: f.discordApiOrigin };
  const w0 = checkWritable(c.dataDir);
  p.say(w0 ? t("s.reqWriteBad", { why: w0 }) : t("s.reqWriteOk", { dir: c.dataDir }));
  if (w0 && yes) throw new Error(w0);
  const sysd = systemdAvailable();
  if (old) p.say(t("s.reqOld", { file: configPath(c.dataDir) }));
  else if (existsSync(configPath(c.dataDir))) p.say(t("s.reqBroken", { file: configPath(c.dataDir) }));

  // Kroki
  let step = 0;
  const total = 5;
  const head = (t: string) => {
    p.say("");
    p.say(`${++step}/${total} ${t}`);
  };

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
    if (!yes) {
      p.say(t("s.local1"));
      p.say(t("s.local2"));
    }
  } else {
    if (f.publicUrl) c.publicUrl = f.publicUrl.replace(/\/$/, "");
    if (f.host) c.bind.host = f.host;
    if (f.port) c.bind.port = f.port;
    if (!yes && !f.publicUrl) {
      p.say(t("s.pub1"));
      p.say(t("s.pub2"));
      for (;;) {
        const v = (await p.ask(t("s.pubUrl"), isLocalUrl(c.publicUrl) ? "" : c.publicUrl)).replace(/\/$/, "");
        if (urlOk(v) && !isLocalUrl(v)) {
          c.publicUrl = v;
          break;
        }
        p.say(t("s.pubUrlBad"));
      }
      if (new URL(c.publicUrl).protocol === "http:") p.say(t("s.pubHttp"));
      p.say(t("s.bind1"));
      p.say(t("s.bind2"));
      const avail = [...new Set(["127.0.0.1", ...localAddresses().filter((a) => !a.startsWith("fe80") && a !== "localhost" && a !== "::" && a !== "0.0.0.0" && a !== "::1")])];
      for (;;) {
        const h = await p.ask(t("s.bind"), c.bind.host);
        if (isLocalAddress(h)) {
          c.bind.host = h;
          break;
        }
        p.say(t("s.bindBad", { host: h, list: avail.join(", ") }));
      }
    }
    if (!urlOk(c.publicUrl)) throw new Error(t("s.badPublicUrl", { url: c.publicUrl }));
  }

  if (!isLocalAddress(c.bind.host)) throw new Error(t("s.notLocalAddr", { host: c.bind.host }));

  // Port
  if (!yes && !f.port) {
    for (;;) {
      const v = Number(await p.ask(t("s.port"), String(c.bind.port || DEFAULT_PORT)));
      if (Number.isInteger(v) && v > 0 && v < 65536) {
        c.bind.port = v;
        break;
      }
      p.say(t("s.portRange"));
    }
  }
  for (;;) {
    const st = await portState(c.bind.host, c.bind.port);
    if (st.state === "free") {
      p.say(t("s.portFree", { port: c.bind.port }));
      break;
    }
    if (st.state === "ours") {
      p.say(t("s.portOurs", { port: c.bind.port, version: st.version }));
      break;
    }
    const alt = await nextFreePort(c.bind.host, c.bind.port);
    p.say(t("s.portBusy", { port: c.bind.port, root: st.code === "EACCES" ? t("s.portBusyRoot") : "" }));
    if (yes || !alt) throw new Error(t("s.portBusyErr", { port: c.bind.port }));
    const v = Number(await p.ask(t("s.portOther"), String(alt)));
    if (Number.isInteger(v) && v > 0 && v < 65536) c.bind.port = v;
  }
  if (scenario === "local") c.publicUrl = f.publicUrl && isLocalUrl(f.publicUrl) ? f.publicUrl.replace(/\/$/, "") : `http://localhost:${c.bind.port}`;

  // Proxy (public only)
  if (scenario === "public") {
    if (f.trustProxy) c.trustProxy = f.trustProxy;
    else if (!yes) {
      p.say(t("s.proxy1"));
      p.say(t("s.proxy2"));
      const v = await p.ask(t("s.proxy"), c.trustProxy.join(", ") || (isLoopback(c.bind.host) ? "127.0.0.1" : ""));
      c.trustProxy = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  } else c.trustProxy = f.trustProxy ?? [];

  // 2. Mode
  if (yes) {
    c.mode = "metadata-only";
    step++;
  } else {
    head(t("s.mode"));
    c.mode = await p.choose(
      "",
      [
        { value: "metadata-only", label: t("s.mode.mo") },
        { value: "e2ee" as "metadata-only", label: t("s.mode.e2ee"), disabled: true },
        { value: "plain" as "metadata-only", label: t("s.mode.plain"), disabled: true },
      ],
      "metadata-only",
    );
  }

  // 3. Bot for share links
  const apiOrigin = c.testing?.discordApiOrigin;
  const setToken = async (tok: string): Promise<boolean> => {
    const r = await validateBotToken(tok, apiOrigin);
    if (!r.ok) {
      p.say(t("s.botBad", { why: r.why }));
      return false;
    }
    c.botToken = tok;
    c.bot = { id: r.id, username: r.username };
    p.say(t("s.botOk", { name: r.username }));
    return true;
  };
  const skipText = t("s.botSkip", { cmd: COMMANDS.setup });
  if (f.noBot) {
    c.botToken = null;
    c.bot = null;
    step++;
  } else if (f.botTokenFile) {
    step++;
    if (c.botToken && !f.replaceBot && !yes && !(await p.confirm(t("s.botReplace"), false))) p.say(t("s.botKept"));
    else if (!(await setToken(tokenFromFile(f.botTokenFile)))) throw new Error(t("s.botFileBad"));
  } else if (yes) step++;
  else {
    head(t("s.bot"));
    p.say(t("s.bot1"));
    p.say(t("s.bot2"));
    p.say(t("s.bot3"));
    if (c.botToken) {
      p.say(t("s.botSaved", { name: c.bot?.username ?? "?" }));
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
        p.say(r.ok ? t("s.botStillOk") : t("s.botStillBad", { why: r.why, cmd: COMMANDS.setup }));
      } else if (keep === "off") {
        c.botToken = null;
        c.bot = null;
      } else {
        botGuide().forEach((l) => p.say(l));
        for (;;) {
          const tok = await p.secret(t("s.botToken"));
          if (!tok) {
            p.say(skipText);
            break;
          }
          if (await setToken(tok)) break;
        }
      }
    } else {
      const want = await p.choose(
        "",
        [
          { value: "skip", label: t("s.bot.skip") },
          { value: "now", label: t("s.bot.now") },
        ],
        "skip",
      );
      if (want === "skip") p.say(skipText);
      else {
        botGuide().forEach((l) => p.say(l));
        for (;;) {
          const tok = await p.secret(t("s.botToken"));
          if (!tok) {
            p.say(skipText);
            break;
          }
          if (await setToken(tok)) break;
        }
      }
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
        p.say("");
        p.say(t("s.signupLocal", { step, total }));
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
  if (c.signup === "open" && scenario === "public") p.say(t("s.signupOpenPublic"));

  // 5. Data directory
  if (!yes && !f.dataDir) {
    head(t("s.data"));
    for (;;) {
      const d = await p.ask(t("s.dataDir"), c.dataDir);
      const why = checkWritable(d);
      if (!why) {
        c.dataDir = d;
        break;
      }
      p.say(t("s.dataBad", { why }));
    }
  } else {
    step++;
    const why = checkWritable(c.dataDir);
    if (why) throw new Error(why);
  }

  const errs = validate(c);
  if (errs.length) throw new Error(errs.join("; "));

  // Summary + save
  p.say("");
  p.say(t("s.sum"));
  p.say(t("s.sum.addr", { url: c.publicUrl, local: scenario === "local" ? t("s.sum.local") : "" }));
  p.say(t("s.sum.bind", { bind: `${c.bind.host}:${c.bind.port}` }));
  if (scenario === "public") p.say(t("s.sum.proxy", { list: c.trustProxy.join(", ") || t("s.sum.none") }));
  p.say(t("s.sum.mode", { mode: c.mode }));
  p.say(t("s.sum.lang", { lang: c.language === "pl" ? t("lang.pl") : t("lang.en") }));
  p.say(t("s.sum.share", { v: c.botToken ? t("s.sum.shareOn", { name: c.bot?.username ?? "?" }) : t("s.sum.shareOff") }));
  p.say(t("s.sum.signup", { v: t(`signup.${c.signup}`) }));
  p.say(t("s.sum.data", { dir: c.dataDir }));
  if (!yes && !(await p.confirm(t("s.save"), true))) throw new Error(t("s.notSaved"));
  const file = saveConfig(c);
  p.say(t("s.saved", { file }));

  // Browser app: built now, not at the first start.
  try {
    ensureWebBuilt(c, (s) => p.say(`  ${s}`));
    p.say(t("s.webOk"));
  } catch (e) {
    throw new Error(t("s.webFail", { msg: (e as Error).message }));
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

  // Start: systemd (Linux) or in this window
  p.say("");
  let sysdState: SetupResult["systemd"] = sysd ? "skipped" : "unavailable";
  let started = false;
  if (f.systemd && !sysd) throw new Error(t("s.noSystemd"));
  if (sysd && (f.systemd ?? (yes ? false : await p.confirm(t("s.systemdQ"), scenario === "public")))) {
    const r = installAndStart(c.dataDir);
    sysdState = "installed";
    started = true;
    p.say(t("s.systemdOk", { how: r.restarted ? t("s.systemdRestarted") : t("s.systemdStarted"), unit: unitPath() }));
    if (lingerEnabled() === false) p.say(t("s.linger"));
  }
  let running: SetupResult["running"] = null;
  if (!started) {
    const now = f.start ?? (yes ? false : await p.confirm(t("s.startQ"), true));
    if (now) {
      const st = await portState(c.bind.host, c.bind.port);
      if (st.state === "ours") p.say(t("s.alreadyRunning", { port: c.bind.port, cmd: COMMANDS.start }));
      else {
        running = await serve(c, () => {});
        started = true;
      }
    }
  }

  // Self-test
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
      selfTest = h.ok ? { ok: true, detail: t("s.selfOk", { base, version: String(h.body.version), mode: String(h.body.mode) }) } : { ok: false, detail: `${base}/v1/health: ${h.error}` };
      p.say(t("s.selfLine", { tag: h.ok ? "OK " : t("s.selfErrTag"), detail: selfTest.detail }));
      if (scenario === "public") {
        const hp = await health(c.publicUrl, 8000);
        p.say(hp.ok ? t("s.pubOk", { url: c.publicUrl }) : t("s.pubNo", { url: c.publicUrl, err: hp.error }));
      }
    } finally {
      if (tmp) await tmp.close();
    }
  }

  // What next
  const bar = "─".repeat(Math.min(72, Math.max(40, c.publicUrl.length + 24)));
  p.say("");
  p.say(bar);
  p.say(started ? t("s.doneOpen", { url: c.publicUrl }) : t("s.doneStart", { cmd: COMMANDS.start, url: c.publicUrl }));
  p.say(bar);
  p.say("");
  p.say(t("s.inBrowser"));
  p.say(t("s.next1", { invite: invite ? t("s.next1code", { code: invite.code }) : c.signup === "invite" ? t("s.next1cmd", { cmd: COMMANDS.invite }) : "" }));
  p.say(t("s.next2a"));
  p.say(t("s.next2b"));
  p.say(t("s.next3"));
  p.say(t("s.next4"));
  p.say("");
  p.say(t("s.cfgFile", { file }));
  p.say(t("s.dataAt", { dir: c.dataDir }));
  p.say(t("s.cmds", { dir: REPO_DIR }));
  if (sysdState === "installed") p.say(t("s.cmdSystemd"));
  else p.say(t("s.cmdStart", { cmd: COMMANDS.start }));
  p.say(t("s.cmdSetup", { cmd: COMMANDS.setup }));
  p.say(t("s.cmdDoctor", { cmd: COMMANDS.doctor }));
  if (c.signup === "invite") p.say(t("s.cmdInvite", { cmd: COMMANDS.invite }));
  if (scenario === "public") {
    p.say("");
    p.say(t("s.nginx"));
    p.say(nginxSnippet(c));
  }
  if (running) {
    p.say("");
    p.say(t("s.running"));
  }
  return { config: c, configFile: file, invite, selfTest, systemd: sysdState, running };
}
