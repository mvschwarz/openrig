import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { nodesRoutes } from "../src/routes/sessions.js";
import { Command } from "commander";
import { psCommand, compactNodeProjection } from "../../cli/src/commands/ps.js";
import { DaemonClient } from "../../tui/src/daemon-client.js";
import { hydrateSnapshot } from "../../tui/src/hydrate.js";
import type { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { AgentActivityStore } from "../src/domain/agent-activity-store.js";

const closes: Array<() => void> = [];
afterEach(() => { closes.splice(0).forEach(close => close()); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("served seat attention across the rig, CLI and TUI", () => {
  it.each([
    { name: "observed input", signal: true, hook: "idle", cause: "none", expected: true },
    { name: "observed clear overrides the hook", signal: false, hook: "needs_input", cause: "none", expected: false },
    { name: "absent evidence retains the hook fallback", signal: null, hook: "needs_input", cause: "none", expected: true },
    { name: "absent evidence stays absent without a hook", signal: null, hook: null, cause: "none", expected: false },
    { name: "startup attention survives observed clear", signal: false, hook: "idle", cause: "attention_required", expected: true },
    { name: "failed startup survives observed clear", signal: false, hook: "idle", cause: "failed", expected: true },
    { name: "held seat survives observed clear", signal: false, hook: "idle", cause: "held", expected: true },
    { name: "recorded error survives observed clear", signal: false, hook: "idle", cause: "error", expected: true },
    // A Codex seat at an approval prompt that no hook reports: only the cached pane reading sees it (ring 2, ovh07).
    { name: "a prompt only the pane reading sees", signal: null, hook: null, cause: "none", pane: true, expected: true },
    { name: "the pane reading after a stale hook", signal: null, hook: "unknown", cause: "none", pane: true, expected: true },
    { name: "after a daemon restart, with no arbitrated state yet", signal: null, hook: null, cause: "none", pane: true, restart: true, expected: true },
    { name: "an observed clear overrides the pane reading", signal: false, hook: null, cause: "none", pane: true, expected: false },
    { name: "a current running hook outranks the pane reading", signal: null, hook: "running", cause: "none", pane: true, expected: false },
    { name: "an OpenClaw local turn was not recovered", signal: null, hook: null, cause: "none", pane: true, openclaw: true, expected: true },
  ])("$name", async ({ signal, hook, cause, expected, pane = false, restart = false, openclaw = false }) => {
    const db = createFullTestDb(); closes.push(() => db.close());
    db.exec(`INSERT INTO rigs(id,name) VALUES('rig','team');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES('node','rig','worker','codex');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES('binding','node','worker@team','%1');
      INSERT INTO sessions(id,node_id,session_name,status,startup_status) VALUES('session','node','worker@team','running','ready');`);
    if (openclaw) {
      db.prepare("UPDATE nodes SET runtime='openclaw'").run();
      new SessionRegistry(db).recordCommunityHarnessSelection("session", "openclaw");
    }
    if (cause === "attention_required" || cause === "failed") db.prepare("UPDATE sessions SET startup_status=?").run(cause);
    if (cause === "held") {
      db.exec("UPDATE sessions SET status='exited'");
      db.exec(`INSERT INTO events(rig_id,node_id,type,payload) VALUES('rig','node','node.held','{"reason":"held for recovery"}')`);
    }
    if (cause === "error") {
      db.exec("UPDATE sessions SET startup_status='pending'");
      db.exec(`INSERT INTO events(rig_id,node_id,type,payload) VALUES('rig','node','node.startup_failed','{"error":"launch error"}')`);
    }
    const evidence = signal == null ? null : { rung: "needs-input-chrome", observedAt: "2026-10-23T20:00:00Z" };
    const seatActivity = { getSeatActivity: () => null, getSeatStateBySession: () => restart ? null : ({
      activity: "working", needsInput: { count: signal ? 1 : 0, reason: signal ? "visible dialog" : null },
      needsInputEvidence: evidence, decidedBy: "window-sampling", seq: 1, lastSwap: null,
    }) } as unknown as SeatActivityService;
    const structuralActivity = openclaw
      ? new SeatStructuralActivityService({ capturePaneContent: async () => readFileSync(new URL("./fixtures/openclaw-local-turn-refused.txt", import.meta.url), "utf8") })
      : { getStructuralActivity: () => pane
        ? { state: "attention", reason: "selection_prompt", evidence: "› 1. Yes, proceed", observedAt: new Date().toISOString() } : null };
    if (structuralActivity instanceof SeatStructuralActivityService) {
      await structuralActivity.pollSeat("worker@team", undefined, "openclaw", "openclaw");
    }
    const attentionReason = openclaw ? "OpenClaw turn not recovered; inspect the pane before retrying" : "selection_prompt";
    const activityStore = { getLatestForNode: () => hook == null ? null : ({
      state: hook, reason: "hook reason", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), evidence: null,
    }) } as unknown as AgentActivityStore;
    const ps = new PsProjectionService({ db, seatActivity, agentActivity: activityStore, structuralActivity });
    const tmux = { getPaneCommand: vi.fn(async () => "node"), capturePaneContent: vi.fn(async () => null) };
    const app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ rigRepo: new RigRepository(db), tmuxAdapter: tmux,
        seatActivityService: seatActivity, agentActivityStore: activityStore, seatStructuralActivityService: structuralActivity })) c.set(key as never, value);
      await next();
    });
    app.route("/api/rigs/:rigId/nodes", nodesRoutes);
    app.get("/api/ps", c => c.json(ps.getEntries()));
    const response = await app.request("/api/rigs/rig/nodes");
    expect(response.status).toBe(200);
    const nodes = await response.json();
    expect(nodes[0]).toMatchObject({ needsAttention: expected, arbitratedNeedsInput: signal, needsInputEvidence: evidence });
    expect(ps.getEntries()[0]!.attentionCount).toBe(nodes.filter((n: { needsAttention: boolean }) => n.needsAttention).length);
    const cli = compactNodeProjection(nodes)[0]!;
    expect(cli).toMatchObject({ needsAttention: expected });
    if (pane && expected) {
      // The served activity and the attention flag tell the same truth, and the reason survives into the compact read.
      expect(nodes[0].agentActivity).toMatchObject({ state: "needs_input", reason: attentionReason, evidenceSource: "pane_heuristic" });
      expect(cli).toMatchObject({ agentActivity: { state: "needs_input", reason: attentionReason } });
    }
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("ATTENTION_FIXTURE_TOKEN", "fixture-only");
    const command = new Command().addCommand(psCommand({
      lifecycleDeps: {} as never,
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "fixture", transport: "http", url: "http://fixture", bearer_env: "ATTENTION_FIXTURE_TOKEN" }] } }) as never,
      clientFactory: () => ({ get: async (path: string) => {
        const result = await app.request(path); return { status: result.status, data: await result.json() };
      } }) as never,
    }));
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture", "--nodes", "--rig", "team", "--json", "--limit", "10", "--fields", "needsAttention,arbitratedNeedsInput,needsInputEvidence"]);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)![0])).entries[0]).toMatchObject({ needsAttention: expected, arbitratedNeedsInput: signal, needsInputEvidence: evidence });
    if (pane && expected) {
      // The table a person reads: the reason and ATTN, not "working, —".
      stdout.mockClear();
      await command.parseAsync(["node", "rig", "ps", "--host", "fixture", "--nodes", "--rig", "team"]);
      const row = stdout.mock.calls.map(call => String(call[0])).find(line => line.includes("worker@team"));
      expect(row).toMatch(/\byes\b/);
      expect(row).toContain(attentionReason);
    }
    stdout.mockRestore();
    // The TUI's actual HTTP reader consumes the exact node response, not an independently authored node fixture.
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/rigs/rig/nodes") return app.request(path);
      if (path === "/api/rigs/summary") return Response.json([{ id: "rig", name: "team", lifecycleState: "running" }]);
      if (path === "/healthz") return Response.json({ ok: true, selfHostId: "fixture" });
      return new Response("not provided", { status: 404 });
    }) as typeof fetch });
    const snapshot = await hydrateSnapshot(client);
    const seat = snapshot.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    expect(seat).toMatchObject({ needsAttention: expected, arbitratedNeedsInput: signal, needsInputEvidence: evidence });
    if (!expected) expect(seat.status).not.toMatch(/attention|needs_input/);
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });
});
