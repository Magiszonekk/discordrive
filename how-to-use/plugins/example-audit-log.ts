// DiscorDrive v4 — Example Plugin: Audit Log
//
// Demonstrates all plugin capabilities in one file:
//   - lifecycle hooks  (file:uploaded, file:deleted, user:registered)
//   - REST routes      GET /events, GET /events/:id, DELETE /events
//   - GraphQL extension  query { auditLog { ... } }
//
// Load it:
//   DISCORDRIVE_PLUGINS=/path/to/example-audit-log.ts
//
// Then call:
//   curl http://localhost:3000/api/plugin/audit-log/events
//   curl -X DELETE http://localhost:3000/api/plugin/audit-log/events

import type { DiscodrivePlugin } from "@discordrive/plugin-sdk";

// ---------------------------------------------------------------------------
// In-memory store — replace with a database for production use
// ---------------------------------------------------------------------------

interface AuditEvent {
  id: string;
  event: string;
  fileId?: string;
  userId?: string;
  detail?: string;
  ts: string;
}

let events: AuditEvent[] = [];
let seq = 0;

function record(
  event: string,
  fields: Omit<AuditEvent, "id" | "event" | "ts">,
): void {
  events.push({
    id: String(++seq),
    event,
    ts: new Date().toISOString(),
    ...fields,
  });
  // Keep only the last 1 000 events in memory
  if (events.length > 1000) events = events.slice(-1000);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const auditLogPlugin: DiscodrivePlugin = {
  name: "audit-log",
  version: "1.0.0",

  // ── Lifecycle hooks ───────────────────────────────────────────────────────

  async setup(ctx) {
    ctx.hooks.on("file:uploaded", (data) => {
      record("file:uploaded", {
        fileId: data.fileId,
        userId: data.userId,
        detail: `${data.mimeType} · ${(Number(data.size) / 1024 / 1024).toFixed(2)} MB`,
      });
    });

    ctx.hooks.on("file:deleted", (data) => {
      record("file:deleted", { fileId: data.fileId, userId: data.userId });
    });

    ctx.hooks.on("user:registered", (data) => {
      record("user:registered", {
        userId: data.userId,
        detail: data.email,
      });
    });
  },

  async teardown() {
    // Nothing to flush for an in-memory store, but a real plugin would:
    //   await db.flush();
    //   clearInterval(flushTimer);
    events = [];
  },

  // ── REST routes ───────────────────────────────────────────────────────────
  // Accessible at /api/plugin/audit-log/<path>

  routes: [
    {
      method: "GET",
      path: "/events",
      async handler(_req, _params) {
        return Response.json({ total: events.length, events: [...events].reverse() });
      },
    },

    {
      method: "GET",
      path: "/events/:id",
      async handler(_req, params) {
        const ev = events.find((e) => e.id === params.id);
        if (!ev) return new Response("Not found", { status: 404 });
        return Response.json(ev);
      },
    },

    {
      method: "DELETE",
      path: "/events",
      async handler(_req, _params) {
        const cleared = events.length;
        events = [];
        seq = 0;
        return Response.json({ cleared });
      },
    },
  ],

  // ── GraphQL extension ─────────────────────────────────────────────────────

  graphql: {
    typeDefs: `
      type AuditEvent {
        id: ID!
        event: String!
        fileId: String
        userId: String
        detail: String
        ts: String!
      }

      extend type Query {
        """Returns the most recent audit events, newest first."""
        auditLog(limit: Int): [AuditEvent!]!
      }
    `,
    resolvers: {
      Query: {
        auditLog: (_: unknown, args: { limit?: number }) => {
          const limit = args.limit ?? 100;
          return [...events].reverse().slice(0, limit);
        },
      },
    },
  },
};

export default auditLogPlugin;
