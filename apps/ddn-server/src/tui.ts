// Arrow-key wizard interface (@clack/core prompts with our own rendering, so
// every label, hint and key help comes from i18n.ts and choices use ◉/○).
// Used by `discordrive setup` on an interactive terminal; plain prompter otherwise
// (prompt.ts). Colors through node:util styleText: NO_COLOR / FORCE_COLOR=0 and
// non-TTY streams turn them off.

import { styleText } from "node:util";
import { ConfirmPrompt, PasswordPrompt, SelectPrompt, TextPrompt, isCancel, updateSettings, wrapTextWithPrefix } from "@clack/core";
import { S_BAR, S_BAR_END, S_BAR_START, cancel as clackCancel, log, note as clackNote, outro, spinner, symbol, unicode } from "@clack/prompts";
import { cliLang, t } from "./i18n.js";
import { Cancelled, type Choice, type Prompter, type Validator } from "./prompt.js";

type Style = Parameters<typeof styleText>[0];
const st = (s: Style, text: string) => styleText(s, text);
const gray = (s: string) => st("gray", s);
const dim = (s: string) => st("dim", s);
const cyan = (s: string) => st("cyan", s);
const green = (s: string) => st("green", s);
const yellow = (s: string) => st("yellow", s);

/** ◉ selected / ○ not selected (ASCII fallback where the terminal has no Unicode). */
export const RADIO_ON = unicode ? "◉" : "(*)";
export const RADIO_OFF = unicode ? "○" : "( )";

export function tuiPrompter(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Prompter {
  updateSettings({ messages: { cancel: t("tui.spinCancel"), error: t("tui.spinError") } });
  const io = { input, output };
  /**
   * Step header: becomes the title of the next prompt, or is printed on its own
   * when text comes first (then the prompt repeats the step title as its question).
   */
  let pending: { counter: string; title: string } | null = null;
  let lastTitle = "";
  const stepLine = (h: { counter: string; title: string }) => `${cyan(h.counter)} ${dim("·")} ${st("bold", h.title)}`;
  const flush = () => {
    if (pending === null) return;
    output.write(`${gray(S_BAR)}\n${cyan(unicode ? "◇" : "o")}  ${stepLine(pending)}\n`);
    pending = null;
  };
  const title = (q: string) => {
    if (q) {
      flush();
      return q;
    }
    if (pending) {
      const h = stepLine(pending);
      pending = null;
      return h;
    }
    return st("bold", lastTitle);
  };
  /** An option line, wrapped under its own text (long labels stay inside the frame). */
  const optLine = (radio: string, text: string) => wrapTextWithPrefix(output, text, `${cyan(S_BAR)}    `, `${cyan(S_BAR)}  ${radio} `);
  const head = (state: string, q: string) => `${gray(S_BAR)}\n${symbol(state as never)}  ${q}\n`;
  const keys = (...k: string[]) => dim(k.join(" · "));
  const done = <T>(v: T | symbol): T => {
    if (isCancel(v)) throw new Cancelled(t("tui.cancelled"));
    return v as T;
  };
  const lines = (s: string) => s.split("\n");
  const msg = (s: string, sym?: string) => {
    flush();
    log.message(lines(s), { output, ...(sym ? { symbol: sym } : {}) });
  };

  const p: Prompter = {
    tui: true,
    intro(name, ls) {
      output.write(`${gray(S_BAR_START)}  ${st(["bgCyan", "black"], ` ${name} `)}\n`);
      if (ls.length) log.message(ls, { output });
    },
    step(n, total, h) {
      flush();
      pending = { counter: t("tui.step", { n, total }), title: h };
      lastTitle = h;
    },
    say: (s = "") => (s ? msg(s) : undefined),
    info: (s) => msg(s),
    ok: (s) => (flush(), log.message(lines(s), { output, symbol: green(unicode ? "✔" : "OK") })),
    warn: (s) => (flush(), log.warn(s, { output })),
    fail: (s) => (flush(), log.error(s, { output })),
    note(h, ls) {
      flush();
      clackNote(ls.join("\n"), h, { output });
    },
    done: (s) => (flush(), outro(st("bold", s), { output })),
    raw: (s) => (flush(), void output.write(s + "\n")),
    async task(m, fn, end) {
      flush();
      const s = spinner({ output });
      s.start(m);
      try {
        const r = await fn();
        const e = end(r);
        if (e.level === "ok") s.stop(e.text);
        else s.error(e.text);
        return r;
      } catch (e) {
        s.error((e as Error).message);
        throw e;
      }
    },
    cancelled(m) {
      pending = null;
      clackCancel(m, { output });
      output.write("\x1b[?25h"); // cursor visible again, whatever was interrupted
    },

    async choose<T extends string>(q: string, options: Choice<T>[], dflt: T): Promise<T> {
      const message = title(q);
      const opt = (o: Choice<T>, active: boolean) => {
        const hint = o.hint ? ` (${o.hint})` : "";
        // The detail line stays visible under every option (not only the active one).
        const detail = o.detail ? "\n" + wrapTextWithPrefix(output, dim(o.detail), `${cyan(S_BAR)}    `) : "";
        if (o.disabled) return optLine(gray(RADIO_OFF), gray(o.label + hint)) + detail;
        return (active ? optLine(green(RADIO_ON), o.label + hint) : optLine(dim(RADIO_OFF), dim(o.label))) + detail;
      };
      const v = await new SelectPrompt<Choice<T>>({
        ...io,
        options,
        initialValue: dflt,
        render() {
          const top = head(this.state, message);
          const cur = this.options[this.cursor]!;
          if (this.state === "submit") return `${top}${gray(S_BAR)}  ${dim(cur.label)}`;
          if (this.state === "cancel") return `${top}${gray(S_BAR)}  ${st(["strikethrough", "dim"], cur.label)}\n${gray(S_BAR)}`;
          const body = this.options.map((o, i) => opt(o, i === this.cursor)).join("\n");
          return `${top}${body}\n${cyan(S_BAR_END)}  ${keys(t("tui.nav"), t("tui.enter"))}\n`;
        },
      }).prompt();
      return done(v) as T;
    },

    async confirm(q, dflt) {
      const message = title(q);
      const yes = t("tui.yes");
      const no = t("tui.no");
      const pr = new ConfirmPrompt({
        ...io,
        active: yes,
        inactive: no,
        initialValue: dflt,
        render() {
          const top = head(this.state, message);
          const val = this.value ? yes : no;
          if (this.state === "submit") return `${top}${gray(S_BAR)}  ${dim(val)}`;
          if (this.state === "cancel") return `${top}${gray(S_BAR)}  ${st(["strikethrough", "dim"], val)}\n${gray(S_BAR)}`;
          const a = this.value ? `${green(RADIO_ON)} ${yes}` : `${dim(RADIO_OFF)} ${dim(yes)}`;
          const b = this.value ? `${dim(RADIO_OFF)} ${dim(no)}` : `${green(RADIO_ON)} ${no}`;
          return `${top}${cyan(S_BAR)}  ${a} ${dim("/")} ${b}\n${cyan(S_BAR_END)}  ${keys(t("tui.confirmKeys"))}\n`;
        },
      });
      // Polish mode: "t" (tak) works like "y".
      if (cliLang() === "pl")
        pr.on("key", (ch?: string) => {
          if (ch?.toLowerCase() === "t") (pr as unknown as { emit(e: string, v: boolean): void }).emit("confirm", true);
        });
      return done(await pr.prompt()) as boolean;
    },

    async ask(q, dflt, validate) {
      const message = title(q);
      const v = await new TextPrompt({
        ...io,
        placeholder: dflt || undefined,
        defaultValue: dflt,
        validate: validate ? (x) => validate(x === undefined || x === "" ? (dflt ?? "") : x) : undefined,
        render() {
          const top = head(this.state, message);
          const shown = this.userInput ? this.userInputWithCursor : dflt ? st("inverse", dflt[0]!) + dim(dflt.slice(1)) : st("inverse", " ");
          if (this.state === "submit") return `${top}${gray(S_BAR)}  ${dim(this.value || dflt || "")}`;
          if (this.state === "cancel") return `${top}${gray(S_BAR)}  ${st(["strikethrough", "dim"], this.value ?? "")}\n${gray(S_BAR)}`;
          if (this.state === "error") return `${top}${yellow(S_BAR)}  ${shown}\n${yellow(S_BAR_END)}  ${yellow(this.error)}\n`;
          if (this.state === "validating") return `${top}${cyan(S_BAR)}  ${dim(this.userInput || dflt || "")}\n${cyan(S_BAR_END)}  ${dim(t("tui.validating"))}\n`;
          const help = dflt ? keys(t("tui.textDefault", { v: dflt })) : keys(t("tui.textKeys"));
          return `${top}${cyan(S_BAR)}  ${shown}\n${cyan(S_BAR_END)}  ${help}\n`;
        },
      }).prompt();
      const s = done(v) as string;
      return s === "" ? (dflt ?? "") : s;
    },

    async secret(q, validate?: Validator) {
      const message = title(q);
      const v = await new PasswordPrompt({
        ...io,
        mask: unicode ? "•" : "*",
        validate: validate ? (x) => validate(x ?? "") : undefined,
        render() {
          const top = head(this.state, message);
          const masked = this.userInputWithCursor || st("inverse", " ");
          if (this.state === "submit") return `${top}${gray(S_BAR)}  ${dim(this.masked)}`;
          if (this.state === "cancel") return `${top}${gray(S_BAR)}\n${gray(S_BAR)}`;
          if (this.state === "error") return `${top}${yellow(S_BAR)}  ${masked}\n${yellow(S_BAR_END)}  ${yellow(this.error)}\n`;
          if (this.state === "validating") return `${top}${cyan(S_BAR)}  ${dim(this.masked)}\n${cyan(S_BAR_END)}  ${dim(t("tui.validating"))}\n`;
          return `${top}${cyan(S_BAR)}  ${masked}\n${cyan(S_BAR_END)}  ${keys(t("tui.textKeys"))}\n`;
        },
      }).prompt();
      return (done(v) as string).trim();
    },

    close() {
      output.write("\x1b[?25h");
    },
  };
  return p;
}
