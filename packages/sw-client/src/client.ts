// @ddv4/sw-client — Ddv4Client class

import type { FileRegistration, FileHandle, Ddv4ClientOptions } from "./types.js";
import { ensureSW, postToSW } from "./sw-bridge.js";

export class Ddv4Client {
  private swPath: string;
  private swScope: string;
  private reg: ServiceWorkerRegistration | null = null;
  private handles = new Map<string, FileHandle>();

  constructor(options?: Ddv4ClientOptions) {
    this.swPath = options?.swPath ?? "/ddv4-sw.js";
    this.swScope = options?.swScope ?? "/";
  }

  /**
   * Initialize the Service Worker. Called lazily on first registerFile(),
   * but can be called eagerly at app boot.
   */
  async init(): Promise<void> {
    if (this.reg) return;
    this.reg = await ensureSW(this.swPath, this.swScope);
  }

  /**
   * Register a file with the decryption proxy SW.
   * Returns a FileHandle with the URL and an unregister() method.
   *
   * The fekRaw ArrayBuffer is transferred (zero-copy) to the SW.
   */
  async registerFile(registration: FileRegistration): Promise<FileHandle> {
    await this.init();

    const id = crypto.randomUUID();
    const fekRaw = registration.fekRaw;
    const sw = this.reg!.active!;

    // Use MessageChannel so we can await the SW's ack after importKey() completes.
    // Without this, triggerDownload() fires before the SW has processed REGISTER_FILE,
    // causing the fetch to /ddv4-file/:id to arrive before files.set() — SW returns 404.
    const mc = new MessageChannel();
    const ackPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        mc.port1.close();
        reject(new Error("SW file registration timeout"));
      }, 10_000);
      mc.port1.onmessage = (e) => {
        clearTimeout(timer);
        mc.port1.close();
        if (e.data?.type === "FILE_REGISTERED") resolve();
        else reject(new Error(`SW registration error: ${String(e.data?.error ?? "unknown")}`));
      };
    });

    // Transfer port2 + fekRaw zero-copy to the SW
    sw.postMessage(
      {
        type: "REGISTER_FILE",
        id,
        fekRaw,
        chunkUrlTemplate: registration.chunkUrlTemplate,
        headers: registration.headers ?? {},
        chunkSize: registration.chunkSize,
        chunkCount: registration.chunkCount,
        totalSize: registration.totalSize,
        mimeType: registration.mimeType,
        fileName: registration.fileName ?? "",
        chunksAhead: registration.chunksAhead ?? 3,
        chunksBehind: registration.chunksBehind ?? 2,
      },
      [mc.port2, fekRaw],
    );

    // Wait until the SW has imported the key and called files.set()
    await ackPromise;

    const handle: FileHandle = {
      id,
      url: `/ddv4-file/${id}`,
      downloadUrl: `/ddv4-file/${id}?download=1`,
      unregister: () => this.unregisterFile(id),
    };

    this.handles.set(id, handle);
    return handle;
  }

  /**
   * Unregister a file and free its SW resources.
   */
  async unregisterFile(id: string): Promise<void> {
    const reg = this.reg ?? (await navigator.serviceWorker.getRegistration(this.swScope));
    if (reg) {
      postToSW(reg, { type: "UNREGISTER_FILE", id });
    }
    this.handles.delete(id);
  }

  /**
   * Unregister all files and free all SW resources.
   */
  async destroy(): Promise<void> {
    for (const id of this.handles.keys()) {
      await this.unregisterFile(id);
    }
  }
}
