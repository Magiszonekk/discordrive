// Node-only parts of the metadata-only client (CLI/desktop).
export { SqliteIndexStore, nodeSqliteDriver, type ChildRow } from "./sqlite-store.js";
export { DdnServer, type Authenticator, type ServerOptions, type Session } from "./server.js";
export { Ed25519Authenticator, AuthError, CHALLENGE_TTL_MS, DEFAULT_SESSION_TTL_MS } from "./auth.js";
