// DiscorDrive v4 — Plugin SDK
// Public interfaces for plugin authors.

export interface DiscodrivePlugin {
  name: string;
  version: string;
  routes?: PluginRoute[];
  graphql?: {
    typeDefs?: string;
    resolvers?: Record<string, unknown>;
  };
  setup?(ctx: PluginSetupContext): Promise<void>;
  teardown?(): Promise<void>;
}

export interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to /api/plugin/:name/, e.g. "/devices/:id" */
  path: string;
  handler: (req: Request, params: Record<string, string>) => Promise<Response>;
}

export interface PluginSetupContext {
  hooks: PluginHooks;
  /** JWT validation helper — avoids duplicating auth logic in each plugin */
  auth: {
    verifyJwt(req: Request): { userId: string; email: string } | null;
  };
}

/** Typed event map — adding a new event here propagates types everywhere */
export type PluginEventMap = {
  "file:uploaded": {
    fileId: string;
    userId: string;
    mimeType: string;
    size: bigint;
    sha256: string;
  };
  "file:deleted": {
    fileId: string;
    userId: string;
  };
  "user:registered": {
    userId: string;
    email: string;
  };
  "chunk:uploaded": {
    fileId: string;
    index: number;
    messageId: string;
  };
};

export interface PluginHooks {
  on<K extends keyof PluginEventMap>(
    event: K,
    handler: (data: PluginEventMap[K]) => void | Promise<void>,
  ): void;
}
