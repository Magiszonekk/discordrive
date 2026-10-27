// UI-thread proxy to the application core. The core runs either in a dedicated worker (browser) or in the
// desktop app's background agent, reached through a MessagePort; both speak the same protocol:
// { id, method, args } -> { id, ok, result | error }, plus { event } pushed by the core.
// Blobs do not cross into the agent's process, so a Blob result travels as { [BLOB]: bytes, type } and is
// turned back into a Blob here (encodeBlobs on the agent's side).
import type { AppCore } from "./app-core.js";

import type { CoreConfig, CoreEvent } from "./app-core.js";

type Methods = { [K in keyof AppCore]: AppCore[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } & {
  /** Handled by the worker itself: creates the AppCore. */
  init(cfg: CoreConfig): Promise<null>;
};

/** Anything that carries messages both ways: a Worker or a MessagePort. */
interface Endpoint {
  postMessage(m: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export const BLOB = "__ddnBlob";

const isBlob = (x: unknown): x is Blob => typeof Blob !== "undefined" && x instanceof Blob;
const isEncoded = (x: unknown): x is { [BLOB]: Uint8Array; type?: string } => !!x && typeof x === "object" && (x as Record<string, unknown>)[BLOB] instanceof Uint8Array;

/** A Blob (the result itself, or a property of a plain result object) as bytes the agent can send. */
export async function encodeBlobs(v: unknown): Promise<unknown> {
  if (isBlob(v)) return { [BLOB]: new Uint8Array(await v.arrayBuffer()), type: v.type };
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).some(isBlob)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = isBlob(x) ? await encodeBlobs(x) : x;
    return out;
  }
  return v;
}

function decodeBlobs(v: unknown): unknown {
  if (isEncoded(v)) return new Blob([v[BLOB] as BlobPart], { type: v.type ?? "" });
  if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).some(isEncoded)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = isEncoded(x) ? decodeBlobs(x) : x;
    return out;
  }
  return v;
}

/** Is there a Blob (a File too) among the arguments, at the top or one level down (an array, a plain object)? */
export function hasBlobArg(args: unknown[]): boolean {
  const one = (x: unknown) => isBlob(x) || (Array.isArray(x) ? x.some(isBlob) : !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype && Object.values(x).some(isBlob));
  return args.some(one);
}

/**
 * `blobArgs: false` (the desktop agent, another process): a call with a Blob argument is refused at once
 * ("<method>: a file cannot be sent to the app's agent") instead of being posted, where it would never answer.
 */
export function connect(worker: Endpoint, onEvent: (e: CoreEvent) => void = () => {}, opts: { blobArgs?: boolean } = {}): Methods {
  let n = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string; event?: CoreEvent }>) => {
    if (ev.data.event) return onEvent(ev.data.event);
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(decodeBlobs(ev.data.result));
    else p.reject(new Error(ev.data.error));
  };
  return new Proxy({} as Methods, {
    get: (_t, method: string) => (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        if (opts.blobArgs === false && hasBlobArg(args)) return reject(new Error(`${method}: a file cannot be sent to the app's agent`));
        const id = ++n;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      }),
  });
}
