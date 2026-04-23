import { describe, expect, it } from "vitest";
import { db } from "@ddv4/database";

describe("Prisma DB connection", () => {
  it("connects and returns user count", async () => {
    const count = await db.user.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
