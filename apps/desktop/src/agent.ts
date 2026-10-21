// The agent: a Node process (Electron utilityProcess) that will host the application core
// (sync, keys, transfers over its own HTTP/2 connections, SQLite on disk). The window reaches it over a
// MessagePort and speaks the same {id, method, args} -> {id, ok, result | error} protocol as the browser
// worker. Unknown methods are refused here, not in the window.
import { DatabaseSync } from "node:sqlite";

interface Call {
  id: number;
  method: string;
  args: unknown[];
}
type Port = Electron.MessagePortMain;

/** Methods the window may call. Everything else is refused. */
const methods: Record<string, (...a: unknown[]) => unknown> = {
  ping: () => ({ ok: true, node: process.versions.node, sqlite: new DatabaseSync(":memory:").prepare("select sqlite_version() v").get()?.v }),
};

export function isCall(m: unknown): m is Call {
  const c = m as Call;
  return !!c && typeof c === "object" && Number.isSafeInteger(c.id) && typeof c.method === "string" && Array.isArray(c.args);
}

function serve(port: Port) {
  port.on("message", async (e) => {
    const m = e.data as unknown;
    if (!isCall(m)) return;
    try {
      const fn = Object.hasOwn(methods, m.method) ? methods[m.method] : undefined;
      if (!fn) throw new Error(`no method ${m.method}`);
      port.postMessage({ id: m.id, ok: true, result: await fn(...m.args) });
    } catch (err) {
      port.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
    }
  });
  port.start();
}

process.parentPort?.on("message", (e) => {
  if ((e.data as { type?: string })?.type === "port" && e.ports[0]) serve(e.ports[0]);
});
