import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonResponseError, type DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycleDeps(): LifecycleDeps {
  const state: DaemonState = { pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-10-08T00:00:00Z" };
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function run(client: Partial<DaemonClient>, args: string[], daemonDeps: LifecycleDeps = lifecycleDeps()): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  const oldExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    const deps: StatusDeps = { lifecycleDeps: daemonDeps, clientFactory: () => client as DaemonClient };
    await createProgram({ edgeDeps: deps }).parseAsync(["node", "rig", "edge", ...args]);
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
  const exitCode = process.exitCode;
  process.exitCode = oldExitCode;
  return { out, err, exitCode };
}

const edge = {
  id: "edge-1",
  kind: "delegates_to",
  from: { logicalId: "orch.lead", nodeId: "node-a" },
  to: { logicalId: "dev.qa", nodeId: "node-b" },
};

describe("rig edge", () => {
  beforeEach(() => { vi.stubEnv("OPENRIG_HOST_SELECTED", "local"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("plans a deferred target by its address rather than printing a null node", async () => {
    const named = { ...edge, kind: "escalates_to", to: { logicalId: "review-advisor@coord", nodeId: null } };
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "would_add", edge: named } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "review-advisor@coord", "--kind", "escalates_to", "--plan"]);
    expect(result.out.join("\n")).toContain("review-advisor@coord (resolved when used)");
    expect(result.out.join("\n")).not.toContain("node null");
  });

  it.each(["add", "remove"].flatMap((operation) =>
    ["ECONNREFUSED", "EPERM"].map((causeCode) => ({ operation, causeCode })),
  ))("returns JSON without an edge request when the daemon is unavailable: $operation / $causeCode", async ({ operation, causeCode }) => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:7433");
    const unavailable: LifecycleDeps = {
      ...lifecycleDeps(),
      fetch: vi.fn(async () => { throw Object.assign(new Error(causeCode), { code: causeCode }); }),
      sleep: vi.fn(async () => {}),
    };
    const client = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    const args = operation === "add" ? ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to"]
      : ["remove", "rig-1", "edge-1"];
    const result = await run(client, [...args, "--json"], unavailable);
    expect(result.exitCode).toBe(1);
    expect(result.err).toEqual([]);
    expect(result.out).toHaveLength(1);
    const error = JSON.parse(result.out[0]!).error;
    expect(error).toMatchObject({ fact: expect.any(String), consequence: expect.any(String), action: expect.any(String) });
    if (causeCode === "ECONNREFUSED") expect(error.fact).toBe("Daemon not running.");
    else expect(error).toMatchObject({ causeCode: "EPERM", fact: expect.stringContaining("blocked") });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("keeps a missing rig distinct from a missing route", async () => {
    const post = vi.fn(async () => ({ status: 404, data: { ok: false, code: "rig_not_found", message: "rig missing" } }));
    const result = await run({ post } as never, ["add", "missing", "orch.lead", "dev.qa", "--kind", "delegates_to", "--json"]);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, code: "rig_not_found" });
    expect(result.exitCode).toBe(1);
  });

  it.each([
    { args: [] }, { args: ["orch.lead"] }, { args: ["orch.lead", "dev.qa"] },
  ])("rejects incomplete arguments before posting: $args", async ({ args }) => {
    const post = vi.fn();
    const result = await run({ post }, ["add", "rig-1", ...args, "--json"]);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, code: "validation_failed" });
    expect(result.exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["add", "remove"])("resolves an active name for %s without selecting an archived generation", async (verb) => {
    const get = vi.fn(async () => ({ status: 200, data: [
      { id: "old", name: "team", archivedAt: "2020-01-01T00:00:00Z" },
      { id: "rig-1", name: "team", archivedAt: null },
    ] }));
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "present", edge } }));
    const del = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "would_remove", edge } }));
    const args = verb === "add" ? ["add", "team", "orch.lead", "dev.qa", "--kind", "delegates_to"]
      : ["remove", "team", "edge-1", "--plan"];
    const result = await run({ get, post, delete: del } as never, args);
    expect(result.exitCode).toBeUndefined();
    expect(get).toHaveBeenCalledWith("/api/rigs/summary?includeArchived=true");
    if (verb === "add") expect(post).toHaveBeenCalledWith("/api/rigs/rig-1/edges", expect.any(Object));
    else expect(del).toHaveBeenCalledWith("/api/rigs/rig-1/edges/edge-1?plan=1");
  });

  it.each(["ambiguous", "missing"])("does not post for an %s name", async (mode) => {
    const get = vi.fn(async () => ({ status: 200, data: mode === "missing" ? [] : [
      { id: "rig-1", name: "team" }, { id: "rig-2", name: "team" },
    ] }));
    const post = vi.fn();
    const result = await run({ get, post } as never, ["add", "team", "orch.lead", "dev.qa", "--kind", "delegates_to", "--json"]);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, code: mode === "missing" ? "rig_not_found" : "rig_ambiguous" });
    expect(result.exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses name resolution with a remote selected, but keeps exact local IDs usable", async () => {
    vi.stubEnv("OPENRIG_HOST_SELECTED", "remote");
    const get = vi.fn(async () => ({ status: 200, data: [
      { id: "rig-1", name: "team", archivedAt: "2020-01-01T00:00:00Z" },
      { id: "rig-2", name: "rig-1" },
    ] }));
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "present", edge } }));
    const args = ["orch.lead", "dev.qa", "--kind", "delegates_to", "--json"];
    const remoteName = await run({ get: vi.fn(async () => ({ status: 200, data: [{ id: "rig-1", name: "team" }] })), post } as never, ["add", "team", ...args]);
    expect(JSON.parse(remoteName.out.join("\n"))).toMatchObject({ ok: false, code: "remote_host_selected" });
    expect(post).not.toHaveBeenCalled();
    const exact = await run({ get, post } as never, ["add", "rig-1", ...args]);
    expect(exact.exitCode).toBeUndefined();
    expect(post).toHaveBeenCalledWith("/api/rigs/rig-1/edges", expect.any(Object));
  });

  it("adds one edge and prints its receipt, the snapshot step and the rollback", async () => {
    const post = vi.fn(async () => ({ status: 201, data: { ok: true, rigId: "rig-1", outcome: "added", edge, rollback: "rig edge remove rig-1 edge-1" } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to"]);
    expect(post).toHaveBeenCalledWith("/api/rigs/rig-1/edges", { from: "orch.lead", to: "dev.qa", kind: "delegates_to", plan: false });
    expect(result.exitCode).toBeUndefined();
    expect(result.out).toEqual([
      "added    delegates_to orch.lead -> dev.qa  edge edge-1",
      "         rollback: rig edge remove rig-1 edge-1",
      "         capture this topology with `rig snapshot rig-1`; restore uses the selected snapshot",
    ]);
  });

  it("prints the routing an added edge moved, before the snapshot step", async () => {
    const routing = {
      orchestrator: { seat: "dev-qa@rig", from: "orch-lead@rig", to: "orch-other@rig" },
      representative: { from: "orch-lead@rig", to: null },
    };
    const post = vi.fn(async () => ({ status: 201, data: { ok: true, rigId: "rig-1", outcome: "added", edge, rollback: "rig edge remove rig-1 edge-1", routing } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to"]);
    expect(result.out).toEqual([
      "added    delegates_to orch.lead -> dev.qa  edge edge-1",
      "         rollback: rig edge remove rig-1 edge-1",
      "         routing: dev-qa@rig's orchestrator (its stuck-row findings and recovery) is now orch-other@rig, was orch-lead@rig",
      "         routing: the rig's representative (where a person's Slack message in the rig's mapped channel goes, unless that channel names an inbound seat) is now none, so such a message goes to Slack's inbound destination, was orch-lead@rig",
      "         capture this topology with `rig snapshot rig-1`; restore uses the selected snapshot",
    ]);
  });

  it("sends plan: true and prints the JSON receipt for a plan", async () => {
    const { id: _id, ...planned } = edge;
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "would_add", edge: planned } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to", "--plan", "--json"]);
    expect(post).toHaveBeenCalledWith("/api/rigs/rig-1/edges", { from: "orch.lead", to: "dev.qa", kind: "delegates_to", plan: true });
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: true, outcome: "would_add", edge: planned });
    expect(result.exitCode).toBeUndefined();
  });

  it("reports an edge that is already there as a success that wrote nothing", async () => {
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "present", edge } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to"]);
    expect(result.out).toEqual(["present  delegates_to orch.lead -> dev.qa  edge edge-1 (already there; nothing written)"]);
    expect(result.exitCode).toBeUndefined();
  });

  it("prints a refusal with its code and exits 1", async () => {
    const post = vi.fn(async () => ({ status: 400, data: { ok: false, code: "edge_cycle", message: "a delegates_to edge from dev.qa to orch.lead would make launch order cycle" } }));
    const result = await run({ post } as never, ["add", "rig-1", "dev.qa", "orch.lead", "--kind", "delegates_to"]);
    expect(result.err).toEqual(["edge_cycle: a delegates_to edge from dev.qa to orch.lead would make launch order cycle"]);
    expect(result.exitCode).toBe(1);
  });

  it.each(["plain", "json"])("names the upgrade for an old daemon's %s 404", async (format) => {
    const post = vi.fn(async () => {
      if (format === "plain") throw new DaemonResponseError(404, "404 Not Found");
      return { status: 404, data: { error: "not_found", path: "/api/rigs/rig-1/edges" } };
    });
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to", "--json"]);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, code: "edge_route_missing" });
    expect(result.exitCode).toBe(1);
  });

  it("removes exactly one edge by ID, and plans a removal without writing", async () => {
    const del = vi.fn(async (path: string) => ({
      status: 200,
      data: { ok: true, rigId: "rig-1", outcome: path.endsWith("?plan=1") ? "would_remove" : "removed", edge },
    }));
    const planned = await run({ delete: del } as never, ["remove", "rig-1", "edge-1", "--plan"]);
    expect(del).toHaveBeenLastCalledWith("/api/rigs/rig-1/edges/edge-1?plan=1");
    expect(planned.out[0]).toBe("plan     remove delegates_to orch.lead -> dev.qa  edge edge-1 from rig rig-1");
    const removed = await run({ delete: del } as never, ["remove", "rig-1", "edge-1"]);
    expect(del).toHaveBeenLastCalledWith("/api/rigs/rig-1/edges/edge-1");
    expect(removed.out).toEqual([
      "removed  delegates_to orch.lead -> dev.qa  edge edge-1",
      "         capture this topology with `rig snapshot rig-1`; restore uses the selected snapshot",
    ]);
    expect(removed.exitCode).toBeUndefined();
  });
});
