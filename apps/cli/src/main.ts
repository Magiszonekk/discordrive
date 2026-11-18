// Process entry of `ddn`: wires the terminal (stdin, stdout, a progress line on stderr) to main().
import { main } from "./cli.js";

const tty = process.stderr.isTTY;
let shown = false;
const code = await main(process.argv.slice(2), {
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => {
    if (shown) (process.stderr.write("\r\x1b[2K"), (shown = false));
    process.stderr.write(l + "\n");
  },
  progress: tty
    ? (l) => {
        if (l === null) {
          if (shown) process.stderr.write("\r\x1b[2K");
          shown = false;
          return;
        }
        process.stderr.write(`\r\x1b[2K${l.slice(0, (process.stderr.columns || 80) - 1)}`);
        shown = true;
      }
    : undefined,
  stdin: async () => {
    if (process.stdin.isTTY) process.stderr.write("> ");
    const parts: Buffer[] = [];
    for await (const d of process.stdin) {
      parts.push(d as Buffer);
      // One line is enough for a pasted key.
      if (Buffer.concat(parts).toString("utf8").includes("\n") && Buffer.concat(parts).toString("utf8").trim().startsWith("ddn-")) break;
    }
    return Buffer.concat(parts).toString("utf8");
  },
  stdout: process.stdout,
  // Tests and local development: a stand-in for Discord's API (the smoke test's fake).
  discordApiOrigin: process.env.DDN_TEST_DISCORD_ORIGIN || undefined,
  confirm: async (q) => {
    if (!process.stdin.isTTY) return false;
    process.stderr.write(`${q} [y/N] `);
    for await (const d of process.stdin) return /^y(es)?$/i.test(String(d).trim());
    return false;
  },
});
process.exitCode = code;
// Open handles (HTTP/2 sessions, a websocket) must not keep a finished command alive.
setTimeout(() => process.exit(code), 50).unref();
await new Promise((r) => setTimeout(r, 0));
process.exit(code);
