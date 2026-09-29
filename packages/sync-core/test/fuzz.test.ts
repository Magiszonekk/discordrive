// Randomized test driver; the simulation lives in sim.ts (runnable outside vitest too).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { actionArb, newStats, runCase } from "./sim.js";

const RUNS = Number(process.env.FUZZ_RUNS ?? 1000);
const SEED = process.env.FUZZ_SEED !== undefined ? Number(process.env.FUZZ_SEED) : undefined;

describe("randomized multi-device sync", () => {
  it(`keeps all invariants over ${RUNS} random runs`, () => {
    const stats = newStats();
    const t0 = Date.now();
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 30, maxLength: 300, size: "max" }), (actions) => {
        runCase(actions, stats);
      }),
      { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
    const ms = Date.now() - t0;
    // Coverage evidence: which rules the random runs actually exercised.
    console.log(
      JSON.stringify(
        {
          seconds: Math.round(ms / 100) / 10,
          ...stats,
          avgLog: Math.round((stats.entries / Math.max(1, stats.runs)) * 10) / 10,
        },
        null,
        1,
      ),
    );
    // Every conflict rule must be hit by the random runs, not only by unit tests.
    for (const code of [
      "rename_overrode_unseen",
      "name_suffixed",
      "restored_by_new_content",
      "content_for_purged_file",
      "moved_to_recovered",
      "node_purged",
      "move_target_in_trash",
      "move_cycle",
      "content_conflict",
      "group_rolled_back",
      "invalid_op",
    ]) {
      if (RUNS >= 200) expect(stats.notices[code] ?? 0, code).toBeGreaterThan(0);
    }
    if (RUNS >= 200) {
      expect(stats.leaseRejected, "leaseRejected").toBeGreaterThan(0);
      expect(stats.fragmentsDeleted, "fragmentsDeleted").toBeGreaterThan(0);
      expect(stats.joins, "joins").toBeGreaterThan(0);
      expect(stats.entries / stats.runs, "avg log length").toBeGreaterThan(30);
    }
  });
});
