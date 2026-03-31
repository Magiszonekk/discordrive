# Creating a DiscorDrive Plugin

A plugin is a TypeScript file that exports a single `DiscodrivePlugin` object as its default export.
It can do any combination of:

- **React to lifecycle events** — `file:uploaded`, `file:deleted`, `user:registered`, `chunk:uploaded`
- **Add REST routes** — served under `/api/plugin/:name/...`
- **Extend the GraphQL schema** — new types, queries, mutations

A complete worked example lives at [`example-audit-log.ts`](./example-audit-log.ts).

---

## The `DiscodrivePlugin` interface

```typescript
import type { DiscodrivePlugin } from "@discordrive/plugin-sdk";

const myPlugin: DiscodrivePlugin = {
  name: "my-plugin",     // must be unique — used in route paths
  version: "1.0.0",

  async setup(ctx) {
    // runs once at server startup
    // register hooks, initialise connections, etc.
  },

  async teardown() {
    // runs once on server shutdown (reverse load order)
    // flush buffers, close connections, clear timers
  },

  routes: [],   // optional HTTP routes
  graphql: {},  // optional schema extensions
};

export default myPlugin;
```

`setup` and `teardown` are both optional. `name` and `version` are required.

---

## Lifecycle hooks

`ctx.hooks.on(event, handler)` subscribes to a typed event.
Handlers can be async — a failing handler is caught and logged without blocking other handlers or the
core response.

```typescript
async setup(ctx) {
  ctx.hooks.on("file:uploaded", async (data) => {
    // data: { fileId, userId, mimeType, size: bigint, sha256 }
    console.log(`[my-plugin] New file: ${data.fileId} (${data.mimeType})`);
  });

  ctx.hooks.on("file:deleted", async (data) => {
    // data: { fileId, userId }
  });

  ctx.hooks.on("user:registered", async (data) => {
    // data: { userId, email }
  });

  ctx.hooks.on("chunk:uploaded", async (data) => {
    // data: { fileId, index, messageId }
    // fires for every individual chunk — use for progress tracking
  });
}
```

**All four events:**

| Event | Payload fields |
|---|---|
| `file:uploaded` | `fileId`, `userId`, `mimeType`, `size` (bigint), `sha256` |
| `file:deleted` | `fileId`, `userId` |
| `user:registered` | `userId`, `email` |
| `chunk:uploaded` | `fileId`, `index`, `messageId` |

---

## REST routes

Add entries to the `routes` array. Each route needs a `method`, a `path` (relative to
`/api/plugin/:pluginName/`), and a `handler`.

Path parameters use `:param` syntax — captured params are passed as the second argument to the handler.

```typescript
import type { DiscodrivePlugin, PluginRoute } from "@discordrive/plugin-sdk";

const routes: PluginRoute[] = [
  {
    method: "GET",
    path: "/status",
    async handler(req, params) {
      return Response.json({ ok: true });
    },
  },
  {
    method: "GET",
    path: "/items/:id",
    async handler(req, params) {
      // params.id is the captured segment
      return Response.json({ id: params.id });
    },
  },
  {
    method: "POST",
    path: "/items",
    async handler(req, params) {
      const body = await req.json();
      // ... process body
      return Response.json({ created: true }, { status: 201 });
    },
  },
];
```

Routes are served at `/api/plugin/<plugin.name>/<route.path>`.
A `GET /status` route on a plugin named `my-plugin` is reachable at
`/api/plugin/my-plugin/status`.

### Using the auth helper

The setup context provides `ctx.auth.verifyJwt(req)` so plugins don't need to duplicate JWT logic:

```typescript
async setup(ctx) {
  routes.push({
    method: "GET",
    path: "/private",
    async handler(req, _params) {
      const user = ctx.auth.verifyJwt(req);
      if (!user) return new Response("Unauthorized", { status: 401 });
      return Response.json({ hello: user.email });
    },
  });
}
```

`verifyJwt` returns `{ userId, email }` on success or `null` if the token is missing or invalid.
For `backend-only` mode the API server handles `X-API-Key` auth before the request reaches plugin routes,
so you only need `verifyJwt` when `APP_MODE=full`.

---

## GraphQL extensions

Provide `graphql.typeDefs` (SDL string) and `graphql.resolvers` to add to the schema:

```typescript
const plugin: DiscodrivePlugin = {
  name: "my-plugin",
  version: "1.0.0",

  graphql: {
    typeDefs: `
      type MyEvent {
        id: ID!
        message: String!
        ts: String!
      }

      extend type Query {
        myEvents: [MyEvent!]!
      }
    `,
    resolvers: {
      Query: {
        myEvents: () => eventStore.getAll(),
      },
    },
  },
};
```

The `extend type Query` / `extend type Mutation` syntax merges your additions into the existing schema.
You can define entirely new types without `extend`.

---

## Putting it all together — minimal plugin

```typescript
// my-plugin.ts
import type { DiscodrivePlugin } from "@discordrive/plugin-sdk";

let uploadCount = 0;

const plugin: DiscodrivePlugin = {
  name: "my-plugin",
  version: "1.0.0",

  async setup(ctx) {
    ctx.hooks.on("file:uploaded", () => { uploadCount++; });
  },

  routes: [
    {
      method: "GET",
      path: "/stats",
      async handler() {
        return Response.json({ uploads: uploadCount });
      },
    },
  ],
};

export default plugin;
```

Load it:
```bash
DISCORDRIVE_PLUGINS=/path/to/my-plugin.ts npm run dev:api
```

Call it:
```bash
curl http://localhost:3000/api/plugin/my-plugin/stats
# {"uploads":3}
```

For a larger real-world example see [`example-audit-log.ts`](./example-audit-log.ts).

---

## Tips

- **Keep state in module scope** — `setup` runs once; store anything you need between requests in
  variables at the top of your file.
- **`teardown` is your cleanup hook** — clear `setInterval` timers, flush write buffers, close DB
  connections here.
- **Plugin errors are isolated** — a crash in `setup` prevents only that plugin from loading;
  a crash in a hook handler is caught and logged without affecting the response.
- **Route conflicts** — two plugins with the same `name` will shadow each other. Keep names unique.
- **TypeScript** — the SDK ships types only (`@discordrive/plugin-sdk`). Import types with
  `import type { DiscodrivePlugin } from "@discordrive/plugin-sdk"` for zero runtime overhead.
