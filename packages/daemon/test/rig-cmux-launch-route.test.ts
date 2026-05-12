// Slice 24 Checkpoint C — POST /api/rigs/:rigId/cmux/launch route tests.
//
// Tests the route's coordination logic (rig lookup → cmux availability
// gate → NodeInventory session-name mapping → ordered-by-pod-then-member
// → chunked into MAX_PER_WORKSPACE → workspace-name conflict resolution
// → buildWorkspace per chunk) using mocked deps to keep tests fast +
// hermetic. Full cmux daemon end-to-end is QA/operator window per
// permission posture.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rigCmuxRoutes } from "../src/routes/rig-cmux.js";
import { CmuxLayoutService } from "../src/domain/cmux-layout-service.js";
import type { CmuxAdapter, CmuxResult, CmuxWorkspace } from "../src/adapters/cmux.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type Database from "better-sqlite3";

interface FakeRigOpts {
  id: string;
  name: string;
  nodes: Array<{ logicalId: string; podId: string | null; canonicalSessionName: string | null }>;
}

function makeRigRepoStub(rigs: Record<string, FakeRigOpts>): RigRepository {
  return {
    getRig: (rigId: string) => {
      const rig = rigs[rigId];
      if (!rig) return null;
      return {
        rig: { id: rig.id, name: rig.name } as never,
        nodes: rig.nodes.map((n) => ({
          id: n.logicalId,
          rigId: rig.id,
          logicalId: n.logicalId,
          podId: n.podId,
          binding: null,
        })) as never,
        edges: [],
      };
    },
  } as unknown as RigRepository;
}

function makeNodeInventoryStub(rigs: Record<string, FakeRigOpts>) {
  return (rigId: string) => {
    const rig = rigs[rigId];
    if (!rig) return [];
    return rig.nodes
      .filter((n) => n.canonicalSessionName != null)
      .map((n) => ({
        logicalId: n.logicalId,
        canonicalSessionName: n.canonicalSessionName!,
        podId: n.podId,
      })) as never;
  };
}

function makeMockAdapter(opts: {
  available: boolean;
  existingWorkspaces?: string[];
  splitOk?: boolean;
  createOk?: boolean;
  failOn?: "createWorkspace" | "splitSurface" | "sendText" | "listWorkspaces";
}): CmuxAdapter {
  const existing = opts.existingWorkspaces ?? [];
  const adapter = {
    isAvailable: () => opts.available,
    getStatus: () => ({ available: opts.available, capabilities: {} }),
    connect: async () => {},
    listWorkspaces: async (): Promise<CmuxResult<CmuxWorkspace[]>> => {
      if (opts.failOn === "listWorkspaces") {
        return { ok: false, code: "request_failed", message: "list failed" };
      }
      return { ok: true, data: existing.map((name, i) => ({ id: `workspace:${i + 100}`, name })) };
    },
    createWorkspace: async (name: string): Promise<CmuxResult<string>> => {
      if (opts.failOn === "createWorkspace") {
        return { ok: false, code: "request_failed", message: "duplicate name" };
      }
      return { ok: true, data: `workspace:new-${name}` };
    },
    listSurfaces: async (): Promise<CmuxResult<unknown[]>> => ({
      ok: true,
      data: [{ id: "surface:default", title: "", type: "terminal" }],
    }),
    splitSurface: async (): Promise<CmuxResult<string>> => {
      if (opts.failOn === "splitSurface") {
        return { ok: false, code: "request_failed", message: "split failed" };
      }
      return { ok: true, data: `surface:${Math.random().toString(36).slice(2, 8)}` };
    },
    sendText: async (): Promise<CmuxResult<void>> => {
      if (opts.failOn === "sendText") {
        return { ok: false, code: "request_failed", message: "send failed" };
      }
      return { ok: true, data: undefined };
    },
    closeWorkspace: async (): Promise<CmuxResult<void>> => ({ ok: true, data: undefined }),
    listPaneSurfaces: async (): Promise<CmuxResult<unknown[]>> => ({ ok: true, data: [] }),
  };
  return adapter as unknown as CmuxAdapter;
}

function buildApp(opts: {
  rigs: Record<string, FakeRigOpts>;
  adapter: CmuxAdapter;
}): Hono {
  const app = new Hono();
  const rigRepo = makeRigRepoStub(opts.rigs);
  const nodeInventoryFn = makeNodeInventoryStub(opts.rigs);
  // No-op sleep so tests don't actually wait
  const layoutService = new CmuxLayoutService(opts.adapter, { sleep: async () => {} });

  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, rigRepo);
    c.set("cmuxAdapter" as never, opts.adapter);
    c.set("cmuxLayoutService" as never, layoutService);
    c.set("nodeInventoryFn" as never, nodeInventoryFn);
    c.set("db" as never, {} as Database.Database); // not used in tests via injected fn
    await next();
  });
  app.route("/api/rigs/:rigId/cmux", rigCmuxRoutes);
  return app;
}

describe("POST /api/rigs/:rigId/cmux/launch", () => {
  it("returns 404 when rig not found", async () => {
    const app = buildApp({
      rigs: {},
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/missing/cmux/launch", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rig_not_found");
  });

  it("returns 503 when cmux adapter is unavailable", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "my-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@my-rig" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: false }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("cmux_unavailable");
    expect(body.message.toLowerCase()).toMatch(/cmux/);
  });

  it("returns 412 when rig has no running tmux sessions", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "my-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: null }, // not running
            { logicalId: "b", podId: "p1", canonicalSessionName: null },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rig_not_running");
  });

  it("happy path: 3 running agents → 1 workspace named after rig", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "my-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@my-rig" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@my-rig" },
            { logicalId: "c", podId: "p2", canonicalSessionName: "c@my-rig" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ name: string; agents: string[]; blanks: number }> };
    expect(body.ok).toBe(true);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]!.name).toBe("my-rig");
    expect(body.workspaces[0]!.agents).toEqual(["a@my-rig", "b@my-rig", "c@my-rig"]);
    expect(body.workspaces[0]!.blanks).toBe(1);
  });

  it("13 agents → 2 workspaces (12 + 1)", async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@big-rig`,
    }));
    const app = buildApp({
      rigs: { "rig-1": { id: "rig-1", name: "big-rig", nodes } },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string; agents: string[] }> };
    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces[0]!.name).toBe("big-rig");
    expect(body.workspaces[0]!.agents).toHaveLength(12);
    expect(body.workspaces[1]!.name).toBe("big-rig-2");
    expect(body.workspaces[1]!.agents).toHaveLength(1);
  });

  it("auto-appends -2 suffix when workspace with rig name already exists in cmux", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "existing-rig",
          nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@existing-rig" }],
        },
      },
      adapter: makeMockAdapter({
        available: true,
        existingWorkspaces: ["existing-rig"], // name collision
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string }> };
    expect(body.workspaces[0]!.name).toBe("existing-rig-2");
  });

  it("auto-appends sequential suffix when multiple workspaces collide", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "collide",
          nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@collide" }],
        },
      },
      adapter: makeMockAdapter({
        available: true,
        existingWorkspaces: ["collide", "collide-2", "collide-3"],
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string }> };
    expect(body.workspaces[0]!.name).toBe("collide-4");
  });

  it("returns 500 with partial-workspace info when a buildWorkspace step fails mid-flight", async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@partial-rig`,
    }));
    const app = buildApp({
      rigs: { "rig-1": { id: "rig-1", name: "partial-rig", nodes } },
      adapter: makeMockAdapter({
        available: true,
        failOn: "splitSurface", // splitSurface fails on the FIRST workspace (12 agents need splits)
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("build_workspace_failed");
    expect(body.message.toLowerCase()).toMatch(/split failed/);
  });

  it("rig.nodes order (DB ORDER BY created_at = pod-then-member) is preserved in agents array", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "ordered",
          nodes: [
            // Order: pod1.lead, pod1.peer, pod2.impl, pod2.qa (created_at order = spec order)
            { logicalId: "pod1.lead", podId: "p1", canonicalSessionName: "pod1.lead@ordered" },
            { logicalId: "pod1.peer", podId: "p1", canonicalSessionName: "pod1.peer@ordered" },
            { logicalId: "pod2.impl", podId: "p2", canonicalSessionName: "pod2.impl@ordered" },
            { logicalId: "pod2.qa", podId: "p2", canonicalSessionName: "pod2.qa@ordered" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces[0]!.agents).toEqual([
      "pod1.lead@ordered",
      "pod1.peer@ordered",
      "pod2.impl@ordered",
      "pod2.qa@ordered",
    ]);
  });
});
