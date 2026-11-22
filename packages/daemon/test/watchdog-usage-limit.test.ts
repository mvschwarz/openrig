import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { readWatchdogUsageLimitState } from "../src/domain/watchdog-usage-limit.js";
import type { StructuralObservation } from "../src/domain/seat-structural-activity-service.js";

const seat = "worker@test", asOf = "2026-01-01T01:00:00.000Z", resetsAt = "2026-01-06T00:00:00.000Z";
const stores: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(asOf)); });
afterEach(() => { for (const db of stores.splice(0)) db.close(); vi.useRealTimers(); });
function fixture() {
  const db = new Database(":memory:"); stores.push(db); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime,account_home) VALUES ('n','r','worker','claude-code','/selected/account-a');
    INSERT INTO sessions(id,node_id,session_name,status,resume_type,resume_token) VALUES ('s','n','worker@test','running','claude_id','conversation');
    INSERT INTO bindings(id,node_id,tmux_session) VALUES ('b','n','worker@test');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g1','n',1,'gen-a','launch');`);
  const sessions = new SessionRegistry(db), bus = new EventBus(db);
  const activity = new AgentActivityStore({ db, eventBus: bus, now: () => new Date(),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, gen) => sessions.isOccupantGenerationRegistered(id, gen) });
  const record = (override: Partial<Parameters<AgentActivityStore["recordHookEvent"]>[0]> = {}) => {
    expect(activity.recordHookEvent({ sessionName: seat, runtime: "claude-code", sessionId: "conversation", generation: "gen-a",
      hookEvent: "StopFailure", subtype: "rate_limit", occurredAt: new Date().toISOString(), resetsAt, ...override }).ok).toBe(true);
  };
  const read = (current?: StructuralObservation) => readWatchdogUsageLimitState({ db, activity, structuralActivity: () => current ?? null, now: () => new Date() }, seat);
  return { db, activity, record, read };
}

it("reads the real #2917 hook through its stated reset, even after the hook's freshness window", () => {
  const f = fixture(); f.record();
  expect(f.read()).toMatchObject({ limit: { asOf, resetsAt } });
  vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
  expect(f.activity.getLatestForNode({ sessionName: seat })?.reason).toBe("stale_runtime_hook");
  expect(f.read()?.limit).toEqual({ asOf, resetsAt });
  vi.setSystemTime(new Date(resetsAt)); expect(f.read()?.limit).toBeNull();
});

it.each(["foreign conversation", "missing generation", "wrong generation", "ordinary prompt", "bad reset", "too late reset"])("does not use %s as reset evidence", kind => {
  const f = fixture();
  f.record(kind === "foreign conversation" ? { sessionId: "helper" }
    : kind === "missing generation" ? { generation: null }
    : kind === "wrong generation" ? { generation: "other" }
    : kind === "ordinary prompt" ? { hookEvent: "PermissionRequest", subtype: "permission_prompt" }
    : { resetsAt: kind === "bad reset" ? "not-a-date" : "2026-02-01T00:00:00Z" });
  expect(f.read()?.limit).toBeNull();
});

it("sees occupant and account-home changes without reading account files", () => {
  const f = fixture(); f.record(); const initial = f.read()!;
  expect(JSON.stringify(initial)).not.toContain("/selected");
  f.db.prepare("UPDATE nodes SET account_home=? WHERE id='n'").run("/selected/account-b");
  const moved = f.read()!; expect(moved.identity).not.toBe(initial.identity);
  f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','n',2,'gen-b','launch')");
  expect(f.read()?.identity).not.toBe(moved.identity); expect(f.read()?.limit).toBeNull();
});

it("does not reuse a pre-move limit after a recorded home correction, even with the same home spelling", () => {
  const f = fixture(); f.record(); const initial = f.read()!;
  f.db.prepare(`INSERT INTO seat_runtime_home_records(operation_id,node_id,runtime,revision,home,slot,previous_source,
    occupant_generation,request_hash,reason,created_at) VALUES ('move','n','claude-code',1,'/selected/account-a','account_home',
    'account-switch','gen-a','fixture','move',?)`).run("2026-01-01T01:00:01Z");
  vi.setSystemTime(new Date("2026-01-01T01:00:02Z"));
  expect(f.read()?.identity).not.toBe(initial.identity); expect(f.read()?.limit).toBeNull();
  f.record(); expect(f.read()?.limit?.asOf).toBe(new Date().toISOString());
});

it("reads a newer hook clear or existing cached positive activity; an unreadable reader fails open", () => {
  const f = fixture(); f.record(); vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
  const current: StructuralObservation = { state: "agent_active", reason: "motion",
    observedAt: new Date().toISOString(), evidence: null };
  expect(f.read(current)?.clearedAt).toBe(current.observedAt);
  f.record({ hookEvent: "UserPromptSubmit", subtype: null });
  expect(f.read()).toMatchObject({ limit: null, clearedAt: new Date().toISOString() });
  expect(readWatchdogUsageLimitState({ db: f.db, activity: { getLatestForNode: () => { throw new Error("read failed"); } } }, seat)).toBeNull();
});

it("wires the daemon's real activity store and cached seat activity into watchdog delivery and every send's record", () => {
  const src = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
  // One reader for both: the parked-row wake and the transport's usage-limit record on a send.
  expect(src).toMatch(/const readUsageLimitState = \(session: string\) => readWatchdogUsageLimitState\(\{ db, activity: agentActivityStore,\s*structuralActivity: name => seatStructuralActivityService.getStructuralActivity\(name\) \}, session\);/);
  expect(src).toMatch(/sessionTransport\.setUsageLimitObserver\(readUsageLimitState\);/);
  expect(src).toMatch(/deliver:\s*makeWatchdogDeliver\(\{[\s\S]*?\breadUsageLimitState,/);
});

it.each([1, 301])("a cached idle/redraw frame does not clear the retained limit after %s seconds", seconds => {
  const f = fixture(); f.record(); vi.setSystemTime(Date.now() + seconds * 1000);
  const state = f.read({ state: "agent_idle", reason: "idle_frame", observedAt: new Date().toISOString(), evidence: null });
  expect(state?.limit).toEqual({ asOf, resetsAt }); expect(state?.clearedAt).toBeUndefined();
});
