import type { SectionDef } from "./types.js";

/** The sole section registry consumed by state and command parsing. */
export const SECTION_REGISTRY: readonly SectionDef[] = [
  {
    name: "topology",
    sourceRead: "GET /api/rigs/:id/graph + /api/ps + /api/rigs/summary (existing)",
    drillShape: "host>rig>pod>agent",
  },
  {
    name: "specs",
    sourceRead: "GET /api/specs/library + /api/rigs/:rigId/spec (existing)",
    drillShape: "kind>spec",
  },
  {
    name: "scopes",
    sourceRead: "GET /api/scopes/projects + project-scoped scopes, execution and slice projections",
    drillShape: "project>mission>execution-row>slice/source",
  },
  { name: "terminals", sourceRead: "GET /api/terminal/views?detail=1 + /api/terminal/preview (passive)", drillShape: "saved/derived>view>page" },
  {
    name: "needs",
    sourceRead: "GET /api/attention + /api/queue/human-updates?limit=20 (passive queue, delivered updates, proof and health)",
    drillShape: "flat",
  },
  { name: "system", sourceRead: "GET /api/health (canonical instance findings)", drillShape: "health/configuration/connections" },
  { name: "config", sourceRead: "GET /healthz + /api/config?view=browser + /api/gateway/connections (passive)", drillShape: "category>setting" },
  { name: "connections", sourceRead: "GET /healthz + /api/gateway/connections (passive projection)", drillShape: "instance>human/routes>work" },
  { name: "usage", sourceRead: "GET /api/provider/status (memory-only read; never the refresh) + /api/config?view=browser only when usage is absent", drillShape: "provider>allowance>window; seats" },
];

/** Display grouping only; compatible configuration/connection coordinates remain. */
export const SYSTEM_SECTIONS = ["system", "config", "connections", "usage"];
