// Prompter: what the setup wizard needs from a terminal. Two implementations:
//  - ttyPrompter (this file): plain lines, numbered choices, `[Y/n]`. Used without
//    a TTY (pipes, CI, --yes, tests, TERM=dumb, DISCORDRIVE_PLAIN=1). Lines are
//    buffered, so answers piped ahead of the question are not lost; secrets are
//    read without echo on a TTY.
//  - tuiPrompter (tui.ts): arrow keys, ◉/○, Yes/No toggle, live validation,
//    spinner, frames (@clack). Used on an interactive terminal.
// All texts come from i18n.ts.

import { createInterface, type Interface } from "node:readline";
import { unicode } from "@clack/prompts";
import { cliLang, t } from "./i18n.js";

/** Returns an error text (shown under the field / on the next line) or nothing when OK. */
export type Validator = (value: string) => string | undefined | Promise<string | undefined>;
export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  /** One more line under the option, always shown (e.g. what the server sees in a mode). */
  detail?: string;
  disabled?: boolean;
}
export type Level = "ok" | "fail";

export interface Prompter {
  /** True for the arrow-key interface. */
  readonly tui: boolean;
  /** Plain mode only: drop empty lines (`--yes` output). */
  compact?: boolean;
  ask(q: string, dflt?: string, validate?: Validator): Promise<string>;
  /** Without echo. Empty answer is allowed (= skip) unless the validator refuses it. */
  secret(q: string, validate?: Validator): Promise<string>;
  confirm(q: string, dflt: boolean): Promise<boolean>;
  /** `q` empty = the title of the current step. */
  choose<T extends string>(q: string, options: Choice<T>[], dflt: T): Promise<T>;
  /** Section header: "Step n/total" + title. */
  step(n: number, total: number, title: string): void;
  intro(title: string, lines: string[]): void;
  say(s?: string): void;
  info(s: string): void;
  ok(s: string): void;
  warn(s: string): void;
  fail(s: string): void;
  /** Framed list (summary, next steps). */
  note(title: string, lines: string[]): void;
  /** The one line that matters at the end (address to open). */
  done(s: string): void;
  /** Unprefixed text to copy (nginx snippet). */
  raw(s: string): void;
  /** Long work with a spinner; `end` says how it ended. */
  task<R>(msg: string, fn: () => Promise<R>, end: (r: R) => { level: Level; text: string }): Promise<R>;
  /** The wizard was cancelled (Esc / Ctrl+C): say so, restore the terminal. */
  cancelled(msg: string): void;
  close(): void;
}

/** Thrown by a prompter when the user cancels (Esc, Ctrl+C, end of input). Nothing is saved. */
export class Cancelled extends Error {}

const YES = ["y", "yes"];
const NO = ["n", "no"];
const YES_PL = ["t", "tak"];
const NO_PL = ["nie"];

export function ttyPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  const terminal = !!(input as { isTTY?: boolean }).isTTY;
  const rl: Interface = createInterface({ input, output, terminal });
  let muted = false;
  const rlw = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  const orig = rlw._writeToOutput?.bind(rl);
  if (orig) rlw._writeToOutput = (s: string) => (muted ? (s.includes("\n") || s.includes("\r") ? orig("\n") : undefined) : orig(s));
  const lines: string[] = [];
  const waiting: ((l: string | null) => void)[] = [];
  let ended = false;
  rl.on("line", (l) => {
    const w = waiting.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on("close", () => {
    ended = true;
    for (const w of waiting.splice(0)) w(null);
  });
  const next = (): Promise<string | null> => (lines.length ? Promise.resolve(lines.shift()!) : ended ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));
  const write = (s: string) => output.write(s);
  const line = async (prompt: string): Promise<string> => {
    write(prompt);
    const l = await next();
    if (l === null) throw new Cancelled(t("p.aborted"));
    if (!terminal) write("\n");
    return l.trim();
  };
  const indent = (s: string, pre = "  ") => s.split("\n").map((l) => pre + l).join("\n");

  const p: Prompter = {
    tui: false,
    say: (s = "") => {
      if (!s && p.compact) return;
      write(s + "\n");
    },
    info: (s) => p.say(indent(s)),
    ok: (s) => p.say(`  OK  ${s}`),
    warn: (s) => p.say(`  !!  ${s}`),
    fail: (s) => p.say(`  ${t("d.fail")}  ${s}`),
    step(n, total, title) {
      p.say("");
      p.say(`${n}/${total} ${title}`);
    },
    intro(title, ls) {
      p.say("");
      p.say(title);
      ls.forEach((l) => p.say(l));
    },
    note(title, ls) {
      p.say("");
      p.say(`${title}:`);
      ls.forEach((l) => p.say(l ? `  ${l}` : ""));
    },
    done(s) {
      const bar = (unicode ? "─" : "-").repeat(Math.min(72, Math.max(40, s.length + 4)));
      p.say("");
      p.say(bar);
      p.say(`  ${s}`);
      p.say(bar);
    },
    raw: (s) => void write(s + "\n"),
    async task(_msg, fn, end) {
      const r = await fn();
      const e = end(r);
      (e.level === "ok" ? p.ok : p.fail)(e.text);
      return r;
    },
    cancelled: (msg) => void write(`\n${msg}\n`),
    async ask(q, dflt, validate) {
      for (;;) {
        const a = await line(`${q}${dflt !== undefined && dflt !== "" ? ` [${dflt}]` : ""}: `);
        const v = a === "" ? (dflt ?? "") : a;
        const err = validate ? await validate(v) : undefined;
        if (!err) return v;
        p.info(err);
      }
    },
    async secret(q, validate) {
      for (;;) {
        write(`${q}: `);
        muted = terminal;
        let v: string;
        try {
          const l = await next();
          if (l === null) throw new Cancelled(t("p.aborted"));
          v = l.trim();
        } finally {
          muted = false;
          write("\n");
        }
        const err = validate ? await validate(v) : undefined;
        if (!err) return v;
        p.info(err);
      }
    },
    async confirm(q, dflt) {
      for (;;) {
        // Always shown as y/n; Polish mode also accepts t/tak/nie.
        const a = (await line(`${q} [${dflt ? "Y/n" : "y/N"}]: `)).toLowerCase();
        if (a === "") return dflt;
        if (YES.includes(a) || (cliLang() === "pl" && YES_PL.includes(a))) return true;
        if (NO.includes(a) || (cliLang() === "pl" && NO_PL.includes(a))) return false;
        p.say(t("p.yesNo"));
      }
    },
    async choose(q, options, dflt) {
      if (q) p.say(q);
      options.forEach((o, i) => {
        p.say(`  ${i + 1}) ${o.label}${o.value === dflt ? t("p.default") : ""}`);
        if (o.detail) p.say(`     ${o.detail}`);
      });
      for (;;) {
        const di = options.findIndex((o) => o.value === dflt) + 1;
        const a = await line(t("p.choose", { n: di }));
        const n = a === "" ? di : Number(a);
        const o = options[n - 1];
        if (!o) p.say(t("p.noOption"));
        else if (o.disabled) p.say(t("p.disabled"));
        else return o.value;
      }
    },
    close: () => rl.close(),
  };
  return p;
}

/** The arrow-key interface makes sense only on a real, capable terminal. */
export function wantTui(env: NodeJS.ProcessEnv = process.env, stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (env.TERM === "dumb" || env.CI === "true" || env.CI === "1") return false;
  if (env.DISCORDRIVE_PLAIN && env.DISCORDRIVE_PLAIN !== "0") return false;
  return true;
}
