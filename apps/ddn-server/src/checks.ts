// Checks shared by setup and doctor: port, bind address, health, bot token.

import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { checkBotToken } from "@ddv4/metadata-client/node";
import { t } from "./i18n.js";

export type PortState = { state: "free" } | { state: "ours"; version: string } | { state: "busy"; code: string };

export function localAddresses(): string[] {
  const out = ["127.0.0.1", "::1", "0.0.0.0", "::", "localhost"];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.push(a.address);
  return out;
}

export function isLocalAddress(host: string): boolean {
  return localAddresses().includes(host);
}

export const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

function tryListen(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "ERR"));
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(null)));
  });
}

export function hostUrl(host: string, port: number): string {
  const h = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

export async function health(base: string, timeoutMs = 4000): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = (await r.json()) as Record<string, unknown>;
    if (body.service !== "discordrive-next") return { ok: false, error: t("c.otherService") };
    return { ok: true, body };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, error: err.cause?.code ?? err.name ?? String(e) };
  }
}

export async function portState(host: string, port: number): Promise<PortState> {
  const err = await tryListen(host, port);
  if (!err) return { state: "free" };
  if (err === "EADDRINUSE") {
    const h = await health(hostUrl(host, port), 2000);
    if (h.ok) return { state: "ours", version: String(h.body.version) };
  }
  return { state: "busy", code: err };
}

export async function nextFreePort(host: string, from: number): Promise<number | null> {
  for (let p = from + 1; p < from + 50 && p < 65536; p++) if ((await tryListen(host, p)) === null) return p;
  return null;
}

export async function validateBotToken(token: string, apiOrigin?: string): Promise<{ ok: true; id: string; username: string } | { ok: false; why: string }> {
  try {
    const r = await checkBotToken(token, apiOrigin);
    if (r.ok) return r;
    return { ok: false, why: r.status === 401 ? t("c.tok401") : t("c.tokHttp", { status: r.status }) };
  } catch (e) {
    return { ok: false, why: t("c.tokNet", { name: (e as Error).name }) };
  }
}
