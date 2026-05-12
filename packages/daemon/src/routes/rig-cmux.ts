// Slice 24 — POST /api/rigs/:rigId/cmux/launch.
//
// Per-rig "Launch in CMUX" endpoint. Coordination:
//   1. rigRepo.getRig(rigId)         → 404 if missing
//   2. cmuxAdapter.isAvailable()     → 503 if cmux not connected
//   3. nodeInventoryFn(rigId)        → map logicalId → canonicalSessionName
//   4. order agents by rig.nodes DB order (ORDER BY created_at = pod-then-member from spec)
//   5. filter to running (has canonicalSessionName)  → 412 if none running
//   6. chunkAgents into MAX_PER_WORKSPACE-sized chunks
//   7. pick non-colliding workspace name per chunk
//      (auto-append -2/-3/... per README R2 + multi-workspace handling)
//   8. cmuxLayoutService.buildWorkspace per chunk (sequential)
//      → 500 with partial info if any buildWorkspace fails mid-flight
//   9. 200 with { ok, workspaces[] }
//
// Deps wired via Hono context (see server.ts deps wiring block).

import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import { CmuxLayoutService } from "../domain/cmux-layout-service.js";

export const rigCmuxRoutes = new Hono();

interface NodeInventoryStubEntry {
  logicalId: string;
  canonicalSessionName: string;
}

type NodeInventoryFn = (rigId: string) => NodeInventoryStubEntry[];

interface RigCmuxDeps {
  rigRepo: RigRepository;
  cmuxAdapter: CmuxAdapter;
  cmuxLayoutService: CmuxLayoutService;
  nodeInventoryFn: NodeInventoryFn;
}

function getDeps(c: { get: (key: string) => unknown }): RigCmuxDeps {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
    cmuxLayoutService: c.get("cmuxLayoutService" as never) as CmuxLayoutService,
    nodeInventoryFn: c.get("nodeInventoryFn" as never) as NodeInventoryFn,
  };
}

function pickNonCollidingName(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) return baseName;
  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) suffix += 1;
  return `${baseName}-${suffix}`;
}

rigCmuxRoutes.post("/launch", async (c) => {
  const rigId = c.req.param("rigId")!;
  const { rigRepo, cmuxAdapter, cmuxLayoutService, nodeInventoryFn } = getDeps(c);

  const rigWithRelations = rigRepo.getRig(rigId);
  if (!rigWithRelations) {
    return c.json(
      {
        ok: false,
        error: "rig_not_found",
        message: `Rig "${rigId}" not found — can't launch cmux workspace — try: rig ps`,
      },
      404,
    );
  }

  if (!cmuxAdapter.isAvailable()) {
    return c.json(
      {
        ok: false,
        error: "cmux_unavailable",
        message:
          "cmux is not available on this host — can't launch workspace — install cmux from https://cmux.io and run: cmux ping",
      },
      503,
    );
  }

  const inventory = nodeInventoryFn(rigId);
  const sessionByLogical = new Map(
    inventory.map((e) => [e.logicalId, e.canonicalSessionName]),
  );

  // rig.nodes is in DB ORDER BY created_at, which corresponds to spec
  // pod-then-member declaration order (pods created first, members
  // within each pod in spec order). Use that as the deterministic
  // agent ordering — no name-based sorting per README §52.
  const orderedSessions: string[] = [];
  for (const node of rigWithRelations.nodes) {
    const session = sessionByLogical.get(node.logicalId);
    if (session) orderedSessions.push(session);
  }

  if (orderedSessions.length === 0) {
    const rigName = (rigWithRelations.rig as unknown as { name: string }).name;
    return c.json(
      {
        ok: false,
        error: "rig_not_running",
        message: `Rig "${rigName}" has no running tmux sessions — can't attach to anything — run: rig up ${rigName}`,
      },
      412,
    );
  }

  // Discover existing workspaces for collision-avoidance. If
  // listWorkspaces fails, treat the existing set as empty — the
  // operator can rename the resulting workspace if needed; better to
  // ship cleanly than block on an enumeration failure.
  const listResult = await cmuxAdapter.listWorkspaces();
  const existingNames = new Set<string>(
    listResult.ok ? listResult.data.map((w) => w.name) : [],
  );

  const chunks = CmuxLayoutService.chunkAgents(orderedSessions);
  const baseName = (rigWithRelations.rig as unknown as { name: string }).name;
  const workspaces: Array<{ name: string; agents: string[]; blanks: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const desired = i === 0 ? baseName : `${baseName}-${i + 1}`;
    const name = pickNonCollidingName(desired, existingNames);
    existingNames.add(name);

    const build = await cmuxLayoutService.buildWorkspace(name, undefined, chunks[i]!);
    if (!build.ok) {
      return c.json(
        {
          ok: false,
          error: "build_workspace_failed",
          message: build.message,
          partial: workspaces,
        },
        500,
      );
    }
    workspaces.push({
      name: build.data.workspaceName,
      agents: build.data.agents,
      blanks: build.data.blanks,
    });
  }

  return c.json({ ok: true, workspaces });
});
