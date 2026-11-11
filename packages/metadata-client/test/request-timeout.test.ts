// Sign-in requests to a server that never answers must fail after the limit, not hang forever
// (a hung request kept the sign-in card locked with no way out).
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { generateDeviceKey, getChallenge, isNetworkError, isTimeout, newAccountKey, rescueRegisterDevice, setRequestTimeout } from "../src/index.js";

const open: Server[] = [];
const held: ServerResponse[] = [];
afterEach(async () => {
  for (const r of held.splice(0)) r.destroy();
  for (const s of open.splice(0)) await new Promise((ok) => s.close(ok));
});

/** A server that accepts requests and then goes quiet: before the headers, or halfway through the body. */
async function silentServer(how: "no-headers" | "half-body"): Promise<string> {
  const s = createServer((req, res) => {
    req.resume();
    held.push(res);
    if (how === "half-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"challengeId":');
    }
  });
  open.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const a = s.address() as { port: number };
  return `http://127.0.0.1:${a.port}`;
}

describe("sign-in request limit", () => {
  for (const how of ["no-headers", "half-body"] as const) {
    it(`a server that goes quiet (${how}) gives a timeout error after the limit`, async () => {
      const url = await silentServer(how);
      const old = setRequestTimeout(300);
      try {
        const t0 = Date.now();
        const e = await getChallenge(url).then(() => null, (x: unknown) => x);
        const took = Date.now() - t0;
        expect(e).toBeInstanceOf(Error);
        expect(isTimeout(e) && isNetworkError(e)).toBe(true);
        expect(String((e as Error).message)).toMatch(/^server_timeout/);
        expect(took).toBeGreaterThanOrEqual(250);
        expect(took).toBeLessThan(3000);
      } finally {
        setRequestTimeout(old);
      }
    });
  }

  it("the rescue-kit sign-in path stops too (it starts with a challenge)", async () => {
    const url = await silentServer("no-headers");
    const old = setRequestTimeout(300);
    try {
      const e = await rescueRegisterDevice(url, newAccountKey(), "acct-x", await generateDeviceKey()).then(() => null, (x: unknown) => x);
      expect(String((e as Error).message)).toMatch(/^server_timeout/);
    } finally {
      setRequestTimeout(old);
    }
  });

  it("a server that answers in time is unaffected", async () => {
    const s = createServer((req, res) => {
      req.resume();
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"challengeId":"c","nonce":"n","instanceId":"i","expiresAt":0}'), 100);
    });
    open.push(s);
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const old = setRequestTimeout(2000);
    try {
      const c = await getChallenge(`http://127.0.0.1:${(s.address() as { port: number }).port}`);
      expect(c.instanceId).toBe("i");
    } finally {
      setRequestTimeout(old);
    }
  });
});
