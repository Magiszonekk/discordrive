/// <reference lib="webworker" />
// Dedicated worker hosting AppCore (OPFS needs a worker). Simple RPC:
// { id, method, args } -> { id, ok, result | error }.
import { AppCore, type CoreConfig } from "./app-core.js";

let core: AppCore | null = null;

self.onmessage = async (ev: MessageEvent<{ id: number; method: string; args: unknown[] }>) => {
  const { id, method, args } = ev.data;
  try {
    if (method === "init") {
      core = new AppCore(args[0] as CoreConfig);
      return postMessage({ id, ok: true, result: null });
    }
    if (!core) throw new Error("not initialised");
    const fn = (core as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== "function" || method.startsWith("_") || method === "constructor") throw new Error(`no method ${method}`);
    const result = await fn.apply(core, args);
    postMessage({ id, ok: true, result });
  } catch (e) {
    postMessage({ id, ok: false, error: String((e as Error)?.message ?? e) });
  }
};
