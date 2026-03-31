# DiscorDrive v4 — How-to-Use

Runnable examples and guides for working with DiscorDrive.

---

## Sections

### [core/](./core/README.md)

Scripts for using DiscorDrive as a pure encrypted storage backend from Node.js —
upload, download, list, share, and delete files without a browser.

Requires `APP_MODE=backend-only` and an `API_KEY`.

### [plugins/](./plugins/README.md)

Everything about the plugin system: how to load and configure third-party plugins,
and how to write your own.

Plugins can add REST routes, listen to lifecycle events (`file:uploaded`, `file:deleted`, …),
and extend the GraphQL schema — all without touching core code.
