# DiscorDrive v4 — Plugins

- [Using plugins](#using-plugins)
- [Creating a plugin](./creating.md)
- [Example: audit-log plugin](./example-audit-log.ts)

---

## Using plugins

Plugins are plain TypeScript/JavaScript files (or npm packages) that export a `DiscodrivePlugin` object.
The API server loads them at startup via the `DISCORDRIVE_PLUGINS` environment variable.

### Loading plugins

Set `DISCORDRIVE_PLUGINS` in your `.env` to a comma-separated list of plugin paths:

```bash
# Single plugin — absolute or relative path, or an npm package name
DISCORDRIVE_PLUGINS=/home/me/plugins/my-plugin.ts

# Multiple plugins
DISCORDRIVE_PLUGINS=/home/me/plugins/audit-log.ts,/home/me/plugins/webhook-notify.ts

# npm package (must be installed in the monorepo root)
DISCORDRIVE_PLUGINS=discordrive-plugin-s3-mirror
```

Then start (or restart) the API:

```bash
npm run dev:api
# [plugins] Loaded: audit-log@1.0.0
# [plugins] Loaded: webhook-notify@1.0.0
```

If a plugin fails to load the error is logged and the server continues — other plugins and core functionality are unaffected.

---

### Calling plugin REST routes

Every plugin can register HTTP routes. They are all served under:

```
/api/plugin/:pluginName/<route-path>
```

For example, if the `audit-log` plugin registers `GET /events`, call it as:

```bash
curl http://localhost:3000/api/plugin/audit-log/events \
  -H "X-API-Key: $API_KEY"
```

Route parameters work exactly like the rest of the API:

```bash
# Plugin "inventory" with route GET /items/:id
curl http://localhost:3000/api/plugin/inventory/items/abc123
```

---

### Plugin GraphQL extensions

Plugins can add new types, queries, and mutations to the GraphQL schema.
They appear in the same schema as the built-in types — no extra endpoint needed.

```graphql
# query added by the audit-log plugin
query {
  auditLog {
    event
    fileId
    userId
    ts
  }
}
```

Use GraphiQL at `http://localhost:3000/graphql` to explore what a plugin added.

---

### Teardown

When the API server shuts down it calls `teardown()` on every loaded plugin in reverse load order.
This gives plugins a chance to flush buffers, close connections, or clean up timers.
You do not need to do anything special as a consumer — it is automatic.
