// Metadata-only instance: the server is an encrypted cache (koncept §3.4). Nothing to add.
import type { ServerMode } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:metadata-only";

export const serverMode: ServerMode = {
  mode: "metadata-only",
  marker: MODE_MARKER,
  parts: () => ({ extensions: [], shareRefresher: null }),
};
