// DiscorDrive v4 — Encryption Web Worker
// Receives raw FEK bytes, encrypts chunks via crypto.subtle (AES-GCM).
// Runs off the main thread to avoid blocking the upload loop.

const IV_LENGTH = 12; // AES-GCM standard IV length

let fek: CryptoKey;

const workerSelf = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerSelf.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      fek = await crypto.subtle.importKey(
        "raw",
        msg.fekRaw,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      workerSelf.postMessage({ type: "ready" });
    } catch (err) {
      workerSelf.postMessage({
        type: "error",
        index: -1,
        message: err instanceof Error ? err.message : "Key import failed",
      });
    }
  } else if (msg.type === "encrypt") {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        fek,
        msg.chunk,
      );

      const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
      output.set(iv, 0);
      output.set(new Uint8Array(ciphertext), iv.byteLength);

      workerSelf.postMessage(
        { type: "encrypted", index: msg.index, data: output.buffer },
        [output.buffer],
      );
    } catch (err) {
      workerSelf.postMessage({
        type: "error",
        index: msg.index,
        message: err instanceof Error ? err.message : "Encryption failed",
      });
    }
  }
};
