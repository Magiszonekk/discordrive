// The application core is built for one mode (`ddn:mode`, see apps/web-mo/build.ts). The command line
// talks to any instance, so it carries all three and picks the instance's mode before the first call.
// Every use of `mode` in the core reads it at call time, so this stand-in can switch underneath.
import { mode as metadataOnly } from "../../web-mo/src/modes/metadata-only.js";
import { mode as e2ee } from "../../web-mo/src/modes/e2ee.js";
import { mode as plain } from "../../web-mo/src/modes/plain.js";
import type { ModeImpl } from "../../web-mo/src/modes/types.js";
import type { ModeName } from "./profile.js";

const MODES: Record<ModeName, ModeImpl> = { "metadata-only": metadataOnly, e2ee, plain };
let current: ModeImpl | null = null;

export function selectMode(m: string): ModeName {
  const impl = MODES[m as ModeName];
  if (!impl) throw new Error(`this instance runs a mode this program does not know (${m}): update ddn`);
  current = impl;
  return m as ModeName;
}

export const mode: ModeImpl = new Proxy({} as ModeImpl, {
  get(_t, k) {
    if (!current) throw new Error("internal: instance mode not selected yet");
    return Reflect.get(current, k);
  },
  has(_t, k) {
    return !!current && k in current;
  },
});
