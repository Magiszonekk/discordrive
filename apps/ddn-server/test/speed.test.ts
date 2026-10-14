// Live speed of the upload queue / download panel (web-mo src/speed.ts): moving average over 5 s, ETA, average at the end.
import { describe, expect, it } from "vitest";
import { SpeedMeter, fmtDuration } from "../../web-mo/src/speed.js";

describe("SpeedMeter", () => {
  it("rate over the last 5 s, ETA from it, average over the whole transfer", () => {
    const m = new SpeedMeter(100e6, 0);
    expect(m.rate(200)).toBeNull(); // too early to say
    for (let s = 1; s <= 10; s++) m.add(s * 10e6, s * 1000);
    expect(m.rate(10_000)).toBeCloseTo(10e6, -3);
    // 5 MB/s for 10 s, then 2 MB/s for 5 s: the window sees only the last 5 s.
    const n = new SpeedMeter(100e6, 0);
    for (let s = 1; s <= 10; s++) n.add(s * 5e6, s * 1000);
    for (let s = 11; s <= 15; s++) n.add(50e6 + (s - 10) * 2e6, s * 1000);
    expect(n.rate(15_000)).toBeCloseTo(2e6, -3);
    expect(n.etaMs(15_000)).toBe(20_000); // 40 MB left at 2 MB/s
    n.finish(15_000);
    expect(n.average(99_999)).toBeCloseTo(60e6 / 15, -3);
    expect(n.durationMs(99_999)).toBe(15_000);
  });

  it("a stall shows as 0 and no ETA", () => {
    const m = new SpeedMeter(10e6, 0);
    m.add(1e6, 1000);
    expect(m.rate(9000)).toBe(0);
    expect(m.etaMs(9000)).toBeNull();
  });

  it("durations", () => {
    expect(fmtDuration(12_400)).toBe("12 s");
    expect(fmtDuration(65_000)).toBe("1:05");
    expect(fmtDuration(3_723_000)).toBe("1:02:03");
  });
});
