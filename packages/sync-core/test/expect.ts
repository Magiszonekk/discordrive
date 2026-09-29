// Minimal expect() so sim.ts runs both under vitest and under plain tsx.
import { deepStrictEqual, strictEqual } from "node:assert";

export function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      strictEqual(actual, expected);
    },
    toEqual(expected: unknown): void {
      deepStrictEqual(actual, expected);
    },
  };
}
