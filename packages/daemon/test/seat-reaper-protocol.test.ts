import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";

it("does not stop if capture persistence fails", async () => {
  // Given an event store that rejects the capture.
  const f = fixture(); f.db.exec(`CREATE TRIGGER reject_capture BEFORE INSERT ON events
    WHEN json_extract(NEW.payload,'$.phase')='capture' BEGIN SELECT RAISE(ABORT,'capture unavailable'); END;`);
  // When an eligible seat reaches threshold.
  await f.mature();
  // Then the prerequisite failure prevents the checked stop.
  expect(f.stops).toEqual([]); expect(f.events().at(-1)).toMatchObject({ decision: "defer-probe-failed" });
});

it.each(["probe", "token", "queue", "activity", "kill-switch", "observe", "workspace"])("defers when %s changes during capture", async change => {
  // Given a capture that encounters or reveals a broken precondition.
  const f = fixture(); const capture = f.deps.capture;
  f.deps.capture = async () => {
    switch (change) {
      case "probe": throw Error("read failed");
      case "token": return { outcome: "skipped", reason: "missing_sidecar" };
      case "queue": f.db.exec(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body)
        VALUES ('q',datetime('now'),datetime('now'),'sender@test','worker@test','pending','work')`); break;
      case "activity": f.state.activity = "working"; f.state.seq++; break;
      case "kill-switch": f.settings.enabled = false; break;
      case "observe": f.settings.observe = true; break;
      case "workspace": f.workspace("dirty-workspace"); break;
      default: throw Error(`unexpected change ${change}`);
    }
    return capture();
  };
  // When the capture phase is attempted.
  await f.mature();
  // Then no stale proof authorizes a stop.
  expect(f.stops).toEqual([]);
});

it("stops the pass and persists attention and terminal state on stop_uncertain", async () => {
  // Given a checked stop with a partial terminal effect.
  const f = fixture(); f.result({ ok: false, code: "stop_uncertain", message: "detach uncertain", partialEffect: true, stopPhase: "kill_attempted" });
  // When a mature seat is reaped and the daemon restarts.
  await f.mature(); await new SeatReaperService(f.deps).tick(); await f.tick();
  // Then it is never retried blindly and consumes authority conservatively.
  expect(f.stops).toHaveLength(1);
  expect(f.events()).toContainEqual(expect.objectContaining({ phase: "effect", budgetConsumed: true, attentionRequired: true, stopPhase: "kill_attempted" }));
  expect(f.events().at(-1)).toMatchObject({ phase: "terminal", decision: "stop_uncertain" });
  expect(f.db.prepare("SELECT attention_required FROM seat_reap_state").get()).toEqual({ attention_required: 1 });
});

it("terminates at the rolling twelve-effect cap without attempting another stop", async () => {
  // Given twelve successful effects in the rolling window, plus an older one.
  const f = fixture();
  for (let i = 0; i < 12; i++) f.bus.emit({ type: "seat.reaped", phase: "effect", passId: `previous-${i}`, timestampMs: 0,
    operator: "daemon:seat-reaper", reason: "idle_reap", budgetConsumed: true });
  // When the next pass starts.
  await f.tick(); await f.tick();
  // Then the breaker self-terminates once, without any lifecycle call.
  expect(f.stops).toEqual([]); expect(f.events().filter(e => e.phase === "terminal")).toHaveLength(1);
  expect(f.events().at(-1)).toMatchObject({ decision: "reap-cap" });
});

it("terminates after three consecutive failed workspace passes", async () => {
  // Given a consistently failed git probe.
  const f = fixture(); f.workspace("defer-probe-failed");
  // When three scheduled passes fail.
  await f.tick(); await f.tick(); await f.tick(); await f.tick();
  // Then a durable terminal receipt ends the job.
  expect(f.events().filter(e => e.phase === "terminal")).toEqual([expect.objectContaining({ decision: "failed-passes" })]);
  expect(f.stops).toEqual([]);
});

it("does not count capture intents, refusals or expired effects toward the cap", async () => {
  // Given an event history containing no recent completed or partial stop.
  const f = fixture(); f.settings.observe = true;
  for (const phase of ["capture", "effect"] as const) f.bus.emit({ type: "seat.reaped", phase, passId: phase, timestampMs: 0,
    operator: "daemon:seat-reaper", reason: "idle_reap", budgetConsumed: false });
  f.bus.emit({ type: "seat.reaped", phase: "effect", passId: "expired", timestampMs: -86_400_001,
    operator: "daemon:seat-reaper", reason: "idle_reap", budgetConsumed: true });
  // When observing a mature seat.
  await f.mature();
  // Then observation is still allowed.
  expect(f.events().at(-1)).toMatchObject({ decision: "would-reap-observe" });
});
