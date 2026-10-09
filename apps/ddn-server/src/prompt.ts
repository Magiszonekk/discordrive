// Tiny interactive prompter (Polish UI). Works on a TTY and on piped stdin
// (tests, `script` pty runs): lines are buffered, so answers typed or piped
// ahead of the question are not lost. Secrets are read without echo on a TTY.

import { createInterface, type Interface } from "node:readline";

export interface Prompter {
  ask(q: string, dflt?: string): Promise<string>;
  secret(q: string): Promise<string>;
  confirm(q: string, dflt: boolean): Promise<boolean>;
  choose<T extends string>(q: string, options: { value: T; label: string; disabled?: boolean }[], dflt: T): Promise<T>;
  say(s?: string): void;
  close(): void;
}

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
    if (l === null) throw new Error("Koniec wejścia: kreator przerwany.");
    if (!terminal) write("\n");
    return l.trim();
  };

  const p: Prompter = {
    say: (s = "") => void write(s + "\n"),
    async ask(q, dflt) {
      const a = await line(`${q}${dflt !== undefined && dflt !== "" ? ` [${dflt}]` : ""}: `);
      return a === "" ? (dflt ?? "") : a;
    },
    async secret(q) {
      write(`${q}: `);
      muted = terminal;
      try {
        const l = await next();
        if (l === null) throw new Error("Koniec wejścia: kreator przerwany.");
        return l.trim();
      } finally {
        muted = false;
        write("\n");
      }
    },
    async confirm(q, dflt) {
      for (;;) {
        const a = (await line(`${q} [${dflt ? "T/n" : "t/N"}]: `)).toLowerCase();
        if (a === "") return dflt;
        if (["t", "tak", "y", "yes"].includes(a)) return true;
        if (["n", "nie", "no"].includes(a)) return false;
        p.say("  Odpowiedz t (tak) albo n (nie).");
      }
    },
    async choose(q, options, dflt) {
      p.say(q);
      options.forEach((o, i) => p.say(`  ${i + 1}) ${o.label}${o.value === dflt ? "  (domyślnie)" : ""}`));
      for (;;) {
        const di = options.findIndex((o) => o.value === dflt) + 1;
        const a = await line(`Wybierz numer [${di}]: `);
        const n = a === "" ? di : Number(a);
        const o = options[n - 1];
        if (!o) p.say("  Nie ma takiej opcji.");
        else if (o.disabled) p.say("  Ta opcja jeszcze nie jest dostępna.");
        else return o.value;
      }
    },
    close: () => rl.close(),
  };
  return p;
}
