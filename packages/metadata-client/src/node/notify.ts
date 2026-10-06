// Minimal WebSocket push for new log entries (koncept §3.4 role 4).
// RFC 6455 server side over node:http "upgrade", no dependency. The server
// only sends small text frames ({"type":"head","seq":N}); the client then
// reads the entries through the normal authenticated HTTP API, so the socket
// never carries log data. Client frames are read only for close/ping/pong.
//
// Auth: browsers cannot set headers on a WebSocket, so the client first gets a
// one-shot ticket over authenticated HTTP (POST /v1/notify-ticket, 30 s) and
// opens /v1/notify?ticket=... ; the session token never appears in a URL.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const TICKET_TTL_MS = 30_000;
const PING_MS = 25_000;
const MAX_SOCKETS_PER_ACCOUNT = 50;

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : null;
  if (!head) throw new Error("frame too large");
  return Buffer.concat([head, payload]);
}

interface Client {
  socket: Duplex;
  accountId: string;
  ping: ReturnType<typeof setInterval>;
}

export class NotifyHub {
  private readonly tickets = new Map<string, { accountId: string; deviceId: string; expiresAt: number }>();
  private readonly clients = new Map<string, Set<Client>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  issueTicket(accountId: string, deviceId: string): { ticket: string; expiresAt: number } {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt <= t) this.tickets.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = t + TICKET_TTL_MS;
    this.tickets.set(ticket, { accountId, deviceId, expiresAt });
    return { ticket, expiresAt };
  }

  count(accountId: string): number {
    return this.clients.get(accountId)?.size ?? 0;
  }

  /** Handle an HTTP upgrade on /v1/notify. Returns false if the path is not ours. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, originAllowed: (o: string | undefined) => boolean): boolean {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/v1/notify") return false;
    const reject = (code: number, msg: string) => {
      socket.end(`HTTP/1.1 ${code} ${msg}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      return true;
    };
    if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
      return reject(400, "Bad Request");
    }
    const ticket = url.searchParams.get("ticket") ?? "";
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expiresAt <= this.now()) return reject(401, "Unauthorized");
    if (this.count(t.accountId) >= MAX_SOCKETS_PER_ACCOUNT) return reject(429, "Too Many Requests");

    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    const c: Client = {
      socket,
      accountId: t.accountId,
      ping: setInterval(() => socket.writable && socket.write(frame(0x9, Buffer.alloc(0))), PING_MS),
    };
    let set = this.clients.get(t.accountId);
    if (!set) this.clients.set(t.accountId, (set = new Set()));
    set.add(c);
    const drop = () => {
      clearInterval(c.ping);
      set!.delete(c);
    };
    socket.on("close", drop);
    socket.on("error", drop);
    socket.on("data", (buf: Buffer) => this.onClientData(c, buf));
    return true;
  }

  private onClientData(c: Client, buf: Buffer): void {
    // Only need to notice close (0x8) and answer ping (0x9). Client frames are masked.
    if (buf.length < 2) return;
    const opcode = buf[0]! & 0x0f;
    if (opcode === 0x8) {
      if (c.socket.writable) c.socket.end(frame(0x8, Buffer.alloc(0)));
    } else if (opcode === 0x9) {
      const len = buf[1]! & 0x7f;
      if (len < 126 && buf.length >= 6 + len) {
        const mask = buf.subarray(2, 6);
        const p = Buffer.from(buf.subarray(6, 6 + len));
        for (let i = 0; i < p.length; i++) p[i]! ^= mask[i % 4]!;
        c.socket.write(frame(0xa, p));
      }
    }
  }

  /** Tell every socket of the account that the log head moved. */
  publish(accountId: string, seq: number): void {
    const msg = frame(0x1, Buffer.from(JSON.stringify({ type: "head", seq })));
    for (const c of this.clients.get(accountId) ?? []) if (c.socket.writable) c.socket.write(msg);
  }

  closeAll(): void {
    for (const set of this.clients.values())
      for (const c of set) {
        clearInterval(c.ping);
        c.socket.destroy();
      }
    this.clients.clear();
  }
}
