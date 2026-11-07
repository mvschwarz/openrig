// Daemon-free fetch seam (complements cache-seed; NOT MSW / no service worker).
// Cache-seed (seed.ts) gives instant first paint, but several hooks hardcode
// staleTime:0 + refetchInterval (useNodePreview/useSessionPreview, useSettings,
// useSpecLibrary, useContextFleet, useFiles) and BACKGROUND-REFETCH even when seeded —
// with no daemon those reject and surface "Failed to fetch". This thin fetch override
// answers /api/* from the SAME typed fixtures so the force-refetch hooks resolve to fixture
// data and the twin stays 1:1 and daemon-free. Default for any unmapped /api/* is a benign
// 404 "unavailable" (the hooks' graceful-degrade path), never a rejected fetch.

import {
  rigSummary,
  psEntries,
  specLibrary,
  nodeInventoryByRig,
  attentionItems,
  rigGraphByRig,
  nodeDetailByKey,
  sessionPreviewByName,
  sliceList,
  steeringPayload,
  missionBriefMd,
  artifactsTreeByPath,
} from "./fixtures.js";
// CORRECTIVE REDESIGN 2026-07-05 — the one-structure review contract fixtures
// (typed vs useReview.ts). Lookups degrade to a benign 404 on a miss.
import {
  correctiveReviewBySlice,
  correctiveMissionReview,
  correctiveSlices,
  correctiveDetailByName,
  correctiveQitemById,
  correctiveMdByPath,
} from "./corrective/fixtures-corrective.js";

// Mission workspace root (matches /api/config workspace.root); the Steering
// tab's brief reads MISSION_BRIEF.md relative to a files-root containing the mission path.
const TWIN_WORKSPACE_ROOT = "/Users/x/code/workspace";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch: typeof fetch | undefined = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined;

function route(pathname: string, search: URLSearchParams): Response {
  if (pathname === "/api/rigs/summary") return json(rigSummary);
  if (pathname === "/api/ps") return json(psEntries);
  // C10 Dashboard v2: attention (Needs you), daemon health, hosts, kernel, settings.
  if (pathname === "/api/queue/attention-aggregate") return json(attentionItems);
  if (pathname === "/api/queue/list") return json(attentionItems.items);
  if (pathname === "/healthz") return json({ status: "ok" });
  if (pathname === "/api/hosts") return json({ ownName: "localhost", selected: "local", hosts: [] });
  if (pathname === "/api/kernel/status") return json({ error: "kernel_boot_tracker_unavailable", message: "twin" });
  // Settings (useSettings, staleTime:0). workspace.root unblocks the /project surface
  // (useWorkspaceName); preview settings keep the terminal pane consistent.
  if (pathname === "/api/config") {
    return json({
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
  if (pathname.startsWith("/api/spec-library") || pathname.startsWith("/api/library")) return json(specLibrary);
  // Workspace slices (the /project surface; missions derive from these).
  // The corrective demo slices merge into the base list (same fictional family).
  if (pathname === "/api/slices") {
    return json({ ...sliceList, slices: [...sliceList.slices, ...correctiveSlices], totalCount: sliceList.slices.length + correctiveSlices.length });
  }

  // CORRECTIVE — the composed one-structure review contract (§3.1).
  let cr = pathname.match(/^\/api\/review\/slice\/([^/]+)$/);
  if (cr) {
    const v = correctiveReviewBySlice[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }
  cr = pathname.match(/^\/api\/review\/mission\/([^/]+)$/);
  if (cr) {
    const v = correctiveMissionReview[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }
  if (pathname === "/api/review/agents") {
    const scope = search.get("scope") ?? "";
    const m07 = correctiveReviewBySlice["EX.2.0.0.07"];
    if (scope.startsWith("slice:")) {
      const v = correctiveReviewBySlice[scope.slice("slice:".length)];
      return v ? json(v.agents) : json({ error: "not_found" }, 404);
    }
    return m07 ? json({ ...m07.agents, scope }) : json({ error: "not_found" }, 404);
  }
  // Slice-page prerequisite (useSliceDetail) — miss → the page's honest 404.
  cr = pathname.match(/^\/api\/slices\/([^/]+)$/);
  if (cr) {
    const v = correctiveDetailByName[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }
  // useQueueItemMap — feed-card actionability + NeedsYou drill.
  cr = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (cr) {
    const v = correctiveQitemById[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }

  // Mission Steering tab.
  // Panel 1: GET /api/steering -> the STEERING.md projection payload.
  if (pathname === "/api/steering") return json(steeringPayload);
  // useMission -> mission root path (Panel 2 reads MISSION_BRIEF.md relative to it).
  let mm = pathname.match(/^\/api\/missions\/([^/]+)$/);
  if (mm) {
    const missionId = decodeURIComponent(mm[1]!);
    return json({ missionId, missionPath: `${TWIN_WORKSPACE_ROOT}/missions/${missionId}`, slices: [] });
  }
  // useFilesRoots -> a root that CONTAINS the mission path (so useScopeMarkdown resolves).
  if (pathname === "/api/files/roots") {
    return json({ roots: [{ name: "workspace", path: TWIN_WORKSPACE_ROOT }] });
  }
  // useFilesList (the Artifacts navigator): per-folder entries.
  if (pathname === "/api/files/list") {
    const p = search.get("path") ?? "";
    return json({ root: "workspace", path: p, entries: artifactsTreeByPath[p] ?? [] });
  }
  // useFilesRead -> MISSION_BRIEF.md (Panel 2) + the corrective evidence md
  // (the §7.2 RIGHT drawer is LIVE in the twin); other files unavailable.
  if (pathname === "/api/files/read") {
    const p = search.get("path") ?? "";
    if (p.endsWith("MISSION_BRIEF.md")) {
      return json({ content: missionBriefMd, mtime: "2026-06-23T08:30:00.000Z", contentHash: "twin-brief" });
    }
    const md = correctiveMdByPath[p];
    if (md) return json({ content: md, mtime: "2025-09-01T02:40:00.000Z", contentHash: `twin-${p}` });
    return json({ error: "not_found" }, 404);
  }

  // Embedded terminal preview (session-keyed).
  let m = pathname.match(/^\/api\/sessions\/([^/]+)\/preview$/);
  if (m) {
    const name = decodeURIComponent(m[1]!);
    const lines = Number(search.get("lines") ?? 100);
    const fx = sessionPreviewByName[name];
    // Echo the requested line count; content is the same dummy regardless of N.
    return fx ? json({ ...fx, lines }) : json({ unavailable: true, reason: "preview_unavailable" }, 404);
  }
  // Node-keyed preview is unused on the seeded surfaces -> graceful unavailable.
  if (/^\/api\/rigs\/[^/]+\/nodes\/[^/]+\/preview$/.test(pathname)) {
    return json({ unavailable: true, reason: "preview_unavailable" }, 404);
  }

  m = pathname.match(/^\/api\/rigs\/([^/]+)\/nodes\/([^/]+)$/);
  if (m) {
    const detail = nodeDetailByKey[`${decodeURIComponent(m[1]!)}::${decodeURIComponent(m[2]!)}`];
    return detail ? json(detail) : json({ error: "not_found" }, 404);
  }
  m = pathname.match(/^\/api\/rigs\/([^/]+)\/nodes$/);
  if (m) return json(nodeInventoryByRig[decodeURIComponent(m[1]!)] ?? []);
  m = pathname.match(/^\/api\/rigs\/([^/]+)\/graph$/);
  if (m) return json(rigGraphByRig[decodeURIComponent(m[1]!)] ?? { nodes: [], edges: [] });

  // Benign default: graceful "unavailable", never a rejected fetch.
  return json({ unavailable: true, reason: "twin_offline" }, 404);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  try {
    const u = new URL(url, "http://twin.local");
    if (u.pathname.startsWith("/api/")) return route(u.pathname, u.searchParams);
  } catch {
    /* fall through to real fetch */
  }
  if (realFetch) return realFetch(input, init);
  return json({ unavailable: true, reason: "twin_offline" }, 404);
}) as typeof fetch;

export {};
