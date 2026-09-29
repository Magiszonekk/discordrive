// Standalone runner for the simulation.
// Usage: npx tsx test/run-sim.ts <seed> <runs>
// Before each case it writes the case to $TMPDIR/sim-current.json, so if the
// process hangs (killed by `timeout`), the offending case is on disk.
// Replay one case: npx tsx test/run-sim.ts --case <file.json>

import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import { actionArb, newStats, runCase, type Action } from "./sim.js";

const tmp = process.env.TMPDIR ?? "/tmp";
const stats = newStats();

if (process.argv[2] === "--case") {
  const c = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as Action[];
  runCase(c, stats);
  console.log(`case ok, log ${stats.entries}`);
} else {
  const seed = Number(process.argv[2] ?? 1);
  const runs = Number(process.argv[3] ?? 50);
  const cases = fc.sample(fc.array(actionArb, { minLength: 30, maxLength: 300, size: "max" }), { seed, numRuns: runs });
  const t0 = Date.now();
  cases.forEach((c, i) => {
    writeFileSync(`${tmp}/sim-current.json`, JSON.stringify(c));
    const t = Date.now();
    try {
      runCase(c, stats);
    } catch (e) {
      writeFileSync(`${tmp}/sim-fail-${seed}-${i}.json`, JSON.stringify(c));
      console.log(`FAIL seed ${seed} case ${i}: ${String((e as Error).message).slice(0, 2000)}`);
      process.exit(1);
    }
    const dt = Date.now() - t;
    if (dt > 1000) console.log(`slow case ${i}: ${dt} ms`);
  });
  console.log(`ok seed ${seed}: ${runs} cases in ${Date.now() - t0} ms, avg log ${(stats.entries / Math.max(1, stats.runs)).toFixed(1)}`);
  console.log(JSON.stringify(stats));
}
