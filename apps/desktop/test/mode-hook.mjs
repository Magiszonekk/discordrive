// Node module hook for test child processes: resolves the core's virtual module `ddn:mode` to the
// metadata-only mode (vitest does the same through its alias).
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(s, c, next) {
      if (s === "ddn:mode") return { url: ${JSON.stringify(new URL("../../web-mo/src/modes/metadata-only.ts", import.meta.url).href)}, shortCircuit: true };
      return next(s, c);
    }`),
);
