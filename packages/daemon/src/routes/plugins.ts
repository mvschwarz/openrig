// Phase 3a slice 3.3 — Plugins HTTP routes (read-only).
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."
//
// Endpoint shape:
//   GET /api/plugins                        → PluginEntry[]   (?runtime=, ?source= filters)
//   GET /api/plugins/:id                    → PluginDetail    (404 when unknown)
//   GET /api/plugins/:id/used-by            → AgentReference[]
//
// All endpoints return 503 when the service is not provisioned in context
// (consistent with the existing daemon route pattern for optional services).

import { Hono } from "hono";
import type {
  PluginDiscoveryService,
  PluginRuntime,
  PluginSourceKind,
} from "../domain/plugin-discovery-service.js";

type ContextGetter = (key: string) => unknown;

function getService(c: { get: ContextGetter }): PluginDiscoveryService | undefined {
  return c.get("pluginDiscoveryService" as never) as PluginDiscoveryService | undefined;
}

function parseRuntimeFilter(value: string | undefined): PluginRuntime | undefined {
  if (value === "claude" || value === "codex") return value;
  return undefined;
}

function parseSourceFilter(value: string | undefined): PluginSourceKind | undefined {
  if (value === "vendored" || value === "claude-cache" || value === "codex-cache") return value;
  return undefined;
}

export function pluginsRoutes(): Hono {
  const router = new Hono();

  // GET / — list discoverable plugins
  router.get("/", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const runtimeFilter = parseRuntimeFilter(c.req.query("runtime"));
    const sourceFilter = parseSourceFilter(c.req.query("source"));
    // Slice 3.3 fix-C — DESIGN §5.4 union 4th category: rig-bundled
    // <cwd>/.claude/plugins/* + <cwd>/.codex/plugins/*. The API caller
    // (UI in rig context, CLI in slice 3.4) passes ?cwd=<path> when
    // they want the rig-cwd discoveries included; the Library page
    // omits it (cross-cutting view).
    const cwd = c.req.query("cwd");
    const cwdScanRoots = cwd ? [cwd] : undefined;
    const plugins = service.listPlugins({ runtimeFilter, sourceFilter, cwdScanRoots });
    return c.json(plugins);
  });

  // GET /:id/used-by — reverse query for agents referencing this plugin.
  // Mounted BEFORE /:id so the literal sub-path doesn't get eaten by the
  // bare-param catchall (per spec-library-routes Phase A R1 SSE route-order
  // lesson banked in that file).
  router.get("/:id/used-by", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    return c.json(service.findUsedBy(id));
  });

  // GET /:id — plugin detail
  router.get("/:id", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    return c.json(detail);
  });

  return router;
}
