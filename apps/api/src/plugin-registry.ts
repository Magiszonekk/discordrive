// DiscorDrive v4 — Plugin Registry
// Loads plugins from DDV_PLUGINS env var, manages lifecycle and event dispatch.

import { EventEmitter } from "node:events";
import type { DdvPlugin, PluginEventMap, PluginHooks } from "@ddv4/plugin-sdk";
import { matchRoute } from "@ddv4/plugin-sdk/route";
import { verifySessionToken } from "./middleware/auth.js";

// ---------------------------------------------------------------------------
// Typed async emitter — full type safety, no extra dependencies
// ---------------------------------------------------------------------------

class TypedEmitter implements PluginHooks {
  private e = new EventEmitter();

  on<K extends keyof PluginEventMap>(
    event: K,
    handler: (d: PluginEventMap[K]) => void | Promise<void>,
  ): void {
    this.e.on(event, handler as never);
  }

  async emitAsync<K extends keyof PluginEventMap>(
    event: K,
    data: PluginEventMap[K],
  ): Promise<void> {
    const listeners = this.e.listeners(event) as Array<
      (d: PluginEventMap[K]) => void | Promise<void>
    >;
    // allSettled: a failing plugin doesn't block others or the core response
    const results = await Promise.allSettled(listeners.map((fn) => fn(data)));
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`[plugins] Hook error (${event}):`, r.reason);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------

class PluginRegistry {
  private plugins: DdvPlugin[] = [];
  private emitter = new TypedEmitter();

  // Auth helper injected into setup context — plugins don't need to copy JWT logic
  private readonly authHelper = {
    async verifyJwt(req: Request): Promise<{ userId: string; email: string } | null> {
      const header = req.headers.get("authorization");
      if (!header?.startsWith("Bearer ")) return null;
      try {
        return await verifySessionToken(header.slice(7));
      } catch {
        return null;
      }
    },
  };

  async load(): Promise<void> {
    const pluginPaths = (process.env.DDV_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const path of pluginPaths) {
      try {
        const mod = await import(path);
        const plugin: DdvPlugin = mod.default ?? mod;
        await plugin.setup?.({ hooks: this.emitter, auth: this.authHelper });
        this.plugins.push(plugin);
        console.log(`[plugins] Loaded: ${plugin.name}@${plugin.version}`);
      } catch (err) {
        console.error(`[plugins] Failed to load plugin at "${path}":`, err);
      }
    }
  }

  async unload(): Promise<void> {
    // Tear down in reverse load order
    for (const plugin of [...this.plugins].reverse()) {
      await plugin
        .teardown?.()
        .catch((e) =>
          console.error(`[plugins] Teardown error (${plugin.name}):`, e),
        );
    }
    this.plugins = [];
  }

  /**
   * Attempt to dispatch an HTTP request to a plugin route.
   * Returns null if no plugin/route matched (caller should return 404).
   * Pathname format: /api/plugin/:pluginName/...rest
   */
  dispatch(req: Request, pathname: string): Promise<Response> | null {
    const parts = pathname.split("/"); // ["", "api", "plugin", name, ...rest]
    const pluginName = parts[3];
    const subPath = "/" + parts.slice(4).join("/");

    const plugin = this.plugins.find((p) => p.name === pluginName);
    if (!plugin?.routes?.length) return null;

    for (const route of plugin.routes) {
      const params = matchRoute(subPath, route.path);
      if (params && req.method === route.method) {
        return route.handler(req, params);
      }
    }
    return null;
  }

  /** Emit a typed event to all registered plugin hooks. */
  async emitAsync<K extends keyof PluginEventMap>(
    event: K,
    data: PluginEventMap[K],
  ): Promise<void> {
    await this.emitter.emitAsync(event, data);
  }

  /** Collect GraphQL extensions from all loaded plugins. */
  getGraphqlExtensions(): {
    typeDefs: string[];
    resolvers: Record<string, unknown>[];
  } {
    return {
      typeDefs: this.plugins.flatMap((p) =>
        p.graphql?.typeDefs ? [p.graphql.typeDefs] : [],
      ),
      resolvers: this.plugins.flatMap((p) =>
        p.graphql?.resolvers ? [p.graphql.resolvers] : [],
      ),
    };
  }
}

export const pluginRegistry = new PluginRegistry();
