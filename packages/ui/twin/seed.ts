// OPR.0.4.1.11.1 (FR-2) — cache-seed seam. Seed the react-query cache under the EXACT
// queryKeys the real hooks use (grounded from packages/ui/src/hooks), so the real App
// renders fully from dummy data with NO daemon and NO fetch. Mutations are inert.
//
// Gate-0 scope: the Dashboard surface (rigs/summary + ps + spec-library). Per-rig node
// inventory is also seeded so a topology surface works without new wiring. The FULL build
// (post Gate-0) extends this to the complete queryKey enumeration (D-4).

import type { QueryClient } from "@tanstack/react-query";
import {
  rigSummary,
  psEntries,
  specLibrary,
  nodeInventoryByRig,
  attentionItems,
  rigGraphByRig,
  nodeDetailByKey,
  sessionPreviewByName,
} from "./fixtures.js";

// Line counts the preview surfaces poll with (node-details=100, others 50/80). Seed all so
// first paint is instant regardless of surface; the fetch stub then serves any other N.
const PREVIEW_LINE_COUNTS = [50, 80, 100, 200];

export function seedTwinCache(qc: QueryClient): void {
  // Dashboard + AppShell core surface.
  qc.setQueryData(["rigs", "summary"], rigSummary);
  qc.setQueryData(["ps"], psEntries);
  // C10 Dashboard v2: usePsEntries keys by selected host (["ps", hostId]);
  // the base key above stays for prefix-invalidations, the host-suffixed
  // keys below are what the Dashboard tiles + Rigs table actually read.
  qc.setQueryData(["ps", "local"], psEntries);
  qc.setQueryData(["spec-library", "all"], specLibrary);
  // Spec Library filtered views (Library surface + node-details "agent" lens).
  qc.setQueryData(["spec-library", "agent"], specLibrary.filter((s) => s.kind === "agent"));

  // Per-rig topology surfaces, keyed by rig id.
  for (const rig of rigSummary) {
    qc.setQueryData(["rig", rig.id, "nodes"], nodeInventoryByRig[rig.id] ?? []);
    // C10: useNodeInventory / useAllAgents key ["rig", rigId, "nodes", hostId].
    qc.setQueryData(["rig", rig.id, "nodes", "local"], nodeInventoryByRig[rig.id] ?? []);
    // Hard surface 1 — topology GRAPH (xyflow nodes/edges).
    qc.setQueryData(["rig", rig.id, "graph"], rigGraphByRig[rig.id] ?? { nodes: [], edges: [] });
  }

  // Hard surface 2 — LIVE NODE DETAILS, keyed ["rig", rigId, "nodes", logicalId].
  for (const detail of Object.values(nodeDetailByKey)) {
    qc.setQueryData(["rig", detail.rigId, "nodes", detail.logicalId], detail);
  }

  // Embedded live-terminal preview (session-keyed), seeded across the polled line counts.
  for (const preview of Object.values(sessionPreviewByName)) {
    for (const n of PREVIEW_LINE_COUNTS) {
      qc.setQueryData(["session-preview", preview.sessionName, n], { ...preview, lines: n });
    }
  }

  // C10 Dashboard v2 — the keys the Dashboard body actually reads.
  qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
  qc.setQueryData(["attention-items", 50, false], attentionItems);
  qc.setQueryData(["daemon", "health"], { status: "ok" });
  qc.setQueryData(["kernel", "status"], { error: "kernel_boot_tracker_unavailable", message: "twin" });
  // C18: seed real settings so SettingsTab's SettingsRow never reads
  // `.value` off undefined (twin cache shadows the fetch stub, staleTime:0
  // still serves initialData first). Mirrors twin/fetch-stub.ts /api/config.
  qc.setQueryData(["settings", "all"], {
    settings: {
      "daemon.port": { value: 7433, source: "default", defaultValue: 7433 },
      "daemon.host": { value: "127.0.0.1", source: "default", defaultValue: "127.0.0.1" },
      "db.path": { value: "~/.openrig/openrig.db", source: "default", defaultValue: "~/.openrig/openrig.db" },
      "transcripts.enabled": { value: true, source: "default", defaultValue: true },
      "transcripts.path": { value: "~/.openrig/transcripts", source: "default", defaultValue: "~/.openrig/transcripts" },
      "workspace.root": { value: "/Users/x/code/workspace", source: "file", defaultValue: "" },
      "workspace.slices_root": { value: "/Users/x/code/workspace/slices", source: "default", defaultValue: "" },
      "workspace.steering_path": { value: "/Users/x/code/workspace/steering", source: "default", defaultValue: "" },
      "workspace.specs_root": { value: "/Users/x/code/workspace/specs", source: "default", defaultValue: "" },
      "workspace.projects_root": { value: "/Users/x/code/workspace/projects", source: "default", defaultValue: "" },
      "workspace.catalog_path": { value: "/Users/x/code/workspace/catalog.json", source: "default", defaultValue: "" },
      "files.allowlist": { value: "workspace:/Users/x/code/workspace", source: "default", defaultValue: "" },
      "progress.scan_roots": { value: "workspace:/Users/x/code/workspace", source: "env", defaultValue: "" },
      "ui.preview.default_lines": { value: 100, source: "default", defaultValue: 100 },
      "ui.preview.refresh_interval_seconds": { value: 3, source: "default", defaultValue: 3 },
    },
  });
}
