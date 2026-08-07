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
    sourceRead: "GET /api/scopes?detail=1 (store-direct: locks + C1 proof drops)",
    drillShape: "mission>slice",
  },
  {
    name: "needs",
    sourceRead: "GET /api/review/fleet + /api/queue/list?attention=1 (existing)",
    drillShape: "flat",
  },
];
