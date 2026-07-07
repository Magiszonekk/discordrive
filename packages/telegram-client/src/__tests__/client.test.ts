import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramRateLimiter } from "../rate-limiter.js";
import { deleteMessage, downloadDocument, getFilePath, uploadDocument, type TgBotInfo } from "../client.js";

const bot: TgBotInfo = { id: "TG_BOT_1", token: "123:abc", chatId: "-100999" };

function tgOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function tgError(status: number, description: string, retryAfter?: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: status,
      description,
      ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
    }),
    { status },
  );
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadDocument", () => {
  it("uploads and returns message/file coordinates", async () => {
    fetchMock.mockResolvedValueOnce(
      tgOk({ message_id: 42, chat: { id: -100999 }, document: { file_id: "FILE_A" } }),
    );

    const limiter = new TelegramRateLimiter(60_000);
    const result = await uploadDocument(bot, new Uint8Array([1, 2, 3]).buffer, "x.bin", limiter);

    expect(result).toMatchObject({ messageId: "42", chatId: "-100999", fileId: "FILE_A", attemptCount: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bot123:abc/sendDocument");
    expect((init as RequestInit).method).toBe("POST");
    // Send interval is enforced after a successful send
    expect(limiter.canUse(bot.id)).toBe(false);
    expect(limiter.getStateSnapshot(bot.id).inFlight).toBe(0);
  });

  it("honours retry_after from a 429 body, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(tgError(429, "Too Many Requests: retry after 0", 0))
      .mockResolvedValueOnce(
        tgOk({ message_id: 7, chat: { id: -100999 }, document: { file_id: "FILE_B" } }),
      );

    const limiter = new TelegramRateLimiter(0);
    const result = await uploadDocument(bot, new Uint8Array([9]).buffer, "y.bin", limiter);

    expect(result.fileId).toBe("FILE_B");
    expect(result.attemptCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when Telegram returns no file_id", async () => {
    fetchMock.mockResolvedValueOnce(tgOk({ message_id: 1, chat: { id: -100999 } }));

    await expect(
      uploadDocument(bot, new Uint8Array([1]).buffer, "z.bin", new TelegramRateLimiter(0)),
    ).rejects.toThrow(/no file_id/);
  });

  it("surfaces auth errors without retrying", async () => {
    fetchMock.mockResolvedValueOnce(tgError(401, "Unauthorized"));

    await expect(
      uploadDocument(bot, new Uint8Array([1]).buffer, "z.bin", new TelegramRateLimiter(0)),
    ).rejects.toThrow(/AUTH_ERROR/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getFilePath / downloadDocument", () => {
  it("resolves file_path and streams the file body", async () => {
    const payload = new Uint8Array([5, 6, 7]);
    fetchMock
      .mockResolvedValueOnce(tgOk({ file_path: "documents/file_0.bin" }))
      .mockResolvedValueOnce(new Response(payload, { status: 200 }));

    const stream = await downloadDocument(bot, "FILE_A", new TelegramRateLimiter(0));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

    expect(Array.from(bytes)).toEqual([5, 6, 7]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/getFile?file_id=FILE_A");
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://api.telegram.org/file/bot123:abc/documents/file_0.bin",
    );
  });

  it("re-resolves an expired file_path when the CDN fetch 404s", async () => {
    const payload = new Uint8Array([1]);
    fetchMock
      .mockResolvedValueOnce(tgOk({ file_path: "documents/expired.bin" }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }))
      .mockResolvedValueOnce(tgOk({ file_path: "documents/fresh.bin" }))
      .mockResolvedValueOnce(new Response(payload, { status: 200 }));

    const stream = await downloadDocument(bot, "FILE_A", new TelegramRateLimiter(0));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

    expect(Array.from(bytes)).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("maps missing files to a not-found error", async () => {
    fetchMock.mockResolvedValueOnce(tgError(400, "Bad Request: invalid file_id"));

    await expect(getFilePath(bot, "BOGUS", new TelegramRateLimiter(0))).rejects.toThrow(/not found/);
  });
});

describe("deleteMessage", () => {
  it("deletes a message", async () => {
    fetchMock.mockResolvedValueOnce(tgOk(true));

    await deleteMessage(bot, "-100999", "42", new TelegramRateLimiter(0));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bot123:abc/deleteMessage");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      chat_id: "-100999",
      message_id: 42,
    });
  });

  it("treats an already-deleted message as success", async () => {
    fetchMock.mockResolvedValueOnce(tgError(400, "Bad Request: message to delete not found"));

    await expect(deleteMessage(bot, "-100999", "42", new TelegramRateLimiter(0))).resolves.toBeUndefined();
  });
});

describe("TelegramRateLimiter", () => {
  it("blocks a sender for the retry_after window", () => {
    const limiter = new TelegramRateLimiter(0);
    expect(limiter.canUse("TG_BOT_1")).toBe(true);

    limiter.recordRetryAfter("TG_BOT_1", 30);
    expect(limiter.canUse("TG_BOT_1")).toBe(false);
    expect(limiter.getNextResetMs(["TG_BOT_1"])).toBeGreaterThan(25_000);
  });

  it("serializes in-flight sends per sender", () => {
    const limiter = new TelegramRateLimiter(0);
    limiter.reserve("TG_BOT_1");
    expect(limiter.canUse("TG_BOT_1")).toBe(false);
    limiter.release("TG_BOT_1");
    expect(limiter.canUse("TG_BOT_1")).toBe(true);
  });
});
