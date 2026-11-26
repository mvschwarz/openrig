import Database from "better-sqlite3";
import { afterEach } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";
import type { SeatReaperSettings } from "../src/domain/seat-reaper-settings.js";
import type { StopSeatResult } from "../src/domain/seat-lifecycle-service.js";
import type { ReaperActivity } from "../src/domain/seat-reaper-eligibility.js";
import type { ResumeTokenDeriveResult } from "../src/domain/resume-token-capture.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

export function fixture() {
  const db = new Database(":memory:"); databases.push(db); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime,cwd) VALUES ('a','r','worker','pi','/fixture');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status,origin,startup_status,resume_token,resume_type)
      VALUES ('s','a','worker@test','running','launched','ready','/fixture/session.jsonl','pi_session_file');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'g1','fresh');`);
  let at = 0;
  const settings: SeatReaperSettings = { enabled: true, observe: false, idleThresholdMinutes: 60,
    maxReapsPer24h: 12, protectedRigs: [], optInRigs: ["test"] };
  const state: ReaperActivity = { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, backgroundWork: null, seq: 1 };
  let workspace: "clean" | "dirty-workspace" | "defer-probe-failed" = "clean";
  const stops: unknown[] = [];
  const bus = new EventBus(db);
  let result: StopSeatResult = { ok: false, code: "selection_changed", message: "changed" };
  const deps = { db, eventBus: bus, now: () => at, settings: () => settings,
    activity: { getSeatStateBySession: (): ReaperActivity | null => state },
    guard: { lifecycle: async <T>(_ids: string[], fn: () => Promise<T>) => fn() },
    workspaceProbe: async () => workspace,
    capture: async (): Promise<ResumeTokenDeriveResult> => ({ outcome: "captured", resumeType: "pi_session_file", token: "/fixture/session.jsonl" }),
    lifecycle: { stopPrecondition: () => ({ contract: "seat-stop.v1" as const, expected: { nodeId: "a", sessionId: "s" } }),
      stopSeat: async (input: unknown) => { stops.push(input); return result; } } };
  const service = new SeatReaperService(deps);
  const tick = async (minutes = 1) => { at += minutes * 60_000; await service.tick(); };
  const mature = async () => { await tick(); for (let i = 0; i < 60; i++) await tick(); };
  const events = () => bus.replayAll(0).filter(e => e.type === "seat.reaped");
  return { db, deps, service, settings, state, stops, tick, mature, events, bus,
    workspace: (value: typeof workspace) => { workspace = value; }, result: (value: StopSeatResult) => { result = value; } };
}
