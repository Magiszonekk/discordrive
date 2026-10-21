/// <reference lib="webworker" />
// Dedicated worker hosting AppCore (OPFS needs a worker). Simple RPC:
// { id, method, args } -> { id, ok, result | error }.
import { AppCore, type CoreConfig } from "./app-core.js";
import { webPlatform } from "./web-platform.js";

let core: AppCore | null = null;

self.onmessage = async (ev: MessageEvent<{ id: number; method: string; args: unknown[]; ddnPort?: string }>) => {
  // A port for a streamed download (ui.ts download → sw.ts), not an RPC call.
  if (ev.data?.ddnPort) return void core?.attachPort(ev.data.ddnPort, ev.ports[0]!);
  // The second connection (lane.ts in a sandboxed iframe).
  if ((ev.data as { ddnLane?: number })?.ddnLane) return void core?.attachLane(ev.ports[0]!);
  const { id, method, args } = ev.data;
  try {
    if (method === "init") {
      core = new AppCore(args[0] as CoreConfig, webPlatform({ wasmUrl: (args[0] as CoreConfig)?.wasmUrl }));
      core.onEvent = (event) => postMessage({ event });
      return postMessage({ id, ok: true, result: null });
    }
    if (!core) throw new Error("not initialised");
    const fn = (core as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== "function" || method.startsWith("_") || method === "constructor" || method === "onEvent" || method === "attachPort" || method === "attachLane") throw new Error(`no method ${method}`);
    const result = await fn.apply(core, args);
    postMessage({ id, ok: true, result });
  } catch (e) {
    postMessage({ id, ok: false, error: String((e as Error)?.message ?? e) });
  }
};
