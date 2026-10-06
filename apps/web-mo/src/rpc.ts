// UI-thread proxy to the worker's AppCore.
import type { AppCore } from "./app-core.js";

import type { CoreConfig } from "./app-core.js";

type Methods = { [K in keyof AppCore]: AppCore[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } & {
  /** Handled by the worker itself: creates the AppCore. */
  init(cfg: CoreConfig): Promise<null>;
};

export function connect(worker: Worker): Methods {
  let n = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.result);
    else p.reject(new Error(ev.data.error));
  };
  return new Proxy({} as Methods, {
    get: (_t, method: string) => (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++n;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      }),
  });
}
