import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable per-provider sender budgets
const discord = { count: 2, available: 2 };
const telegram = { count: 2, available: 2 };

vi.mock("../../storage/discord-blobs.js", () => ({
  uploadCiphertextBlobToDiscord: vi.fn(),
  fetchCiphertextBlobFromDiscord: vi.fn(),
  deleteCiphertextBlobFromDiscord: vi.fn(),
  statDiscordBlob: vi.fn(),
  discordSenderCount: vi.fn(() => discord.count),
  discordSenderAvailability: vi.fn(() => discord.available),
}));

vi.mock("../../storage/telegram-blobs.js", () => ({
  uploadCiphertextBlobToTelegram: vi.fn(),
  fetchCiphertextBlobFromTelegram: vi.fn(),
  deleteCiphertextBlobFromTelegram: vi.fn(),
  statTelegramBlob: vi.fn(),
  telegramSenderCount: vi.fn(() => telegram.count),
  telegramSenderAvailability: vi.fn(() => telegram.available),
}));

import { getPrimaryPool } from "../../storage/provider.js";

describe("primary pool selection (striping)", () => {
  beforeEach(() => {
    delete process.env.STORAGE_PRIMARY_PROVIDERS;
    delete process.env.BLOB_STORAGE_KIND;
    discord.count = 2;
    discord.available = 2;
    telegram.count = 2;
    telegram.available = 2;
  });

  afterEach(() => {
    delete process.env.STORAGE_PRIMARY_PROVIDERS;
    delete process.env.BLOB_STORAGE_KIND;
  });

  it("falls back to BLOB_STORAGE_KIND when no provider list is set", () => {
    process.env.BLOB_STORAGE_KIND = "DISCORD";
    expect(getPrimaryPool().kind).toBe("DISCORD");
    process.env.BLOB_STORAGE_KIND = "TELEGRAM";
    expect(getPrimaryPool().kind).toBe("TELEGRAM");
    delete process.env.BLOB_STORAGE_KIND;
    expect(getPrimaryPool().kind).toBe("LOCAL");
  });

  it("alternates providers round-robin when budgets are equal", () => {
    process.env.STORAGE_PRIMARY_PROVIDERS = "DISCORD,TELEGRAM";
    const picks = Array.from({ length: 4 }, () => getPrimaryPool().kind);
    expect(new Set(picks)).toEqual(new Set(["DISCORD", "TELEGRAM"]));
    expect(picks[0]).not.toBe(picks[1]);
    expect(picks[1]).not.toBe(picks[2]);
    expect(picks[2]).not.toBe(picks[3]);
  });

  it("sheds all load to the provider with free budget when the other is saturated", () => {
    process.env.STORAGE_PRIMARY_PROVIDERS = "DISCORD,TELEGRAM";
    discord.available = 0;
    const picks = Array.from({ length: 5 }, () => getPrimaryPool().kind);
    expect(picks).toEqual(["TELEGRAM", "TELEGRAM", "TELEGRAM", "TELEGRAM", "TELEGRAM"]);
  });

  it("skips providers with no configured senders", () => {
    process.env.STORAGE_PRIMARY_PROVIDERS = "DISCORD,TELEGRAM";
    telegram.count = 0;
    const picks = Array.from({ length: 3 }, () => getPrimaryPool().kind);
    expect(picks).toEqual(["DISCORD", "DISCORD", "DISCORD"]);
  });

  it("throws when no listed provider has senders", () => {
    process.env.STORAGE_PRIMARY_PROVIDERS = "DISCORD,TELEGRAM";
    discord.count = 0;
    telegram.count = 0;
    expect(() => getPrimaryPool()).toThrow(/No primary storage provider/);
  });

  it("rejects unknown providers in the list", () => {
    process.env.STORAGE_PRIMARY_PROVIDERS = "DISCORD,DROPBOX";
    expect(() => getPrimaryPool()).toThrow(/Unsupported storage provider/);
  });

  it("rejects unknown BLOB_STORAGE_KIND", () => {
    process.env.BLOB_STORAGE_KIND = "BROKEN";
    expect(() => getPrimaryPool()).toThrow("Unsupported BLOB_STORAGE_KIND: BROKEN");
  });
});
