import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";
import { classifyColdStartStop } from "../src/domain/seat-cold-start.js";

// #2829 slices 1+2 — the seam that makes the pair an architecture: the reaper stops a
// seat through the REAL checked-stop path (only OS terminal effects replaced), and cold
// start must read that exact stop as revivable; a human stop on the same seat must not be.

function wiring(f: ReturnType<typeof fixture>, opts: { unreadablePs?: boolean; runnerSurvives?: boolean } = {}) {
  // #3836 review: the standby checked-stop requires the full pane identity (pane id, dead
  // flag, session name, one-window/one-pane) and a resumable conversation, so the stub
  // answers the whole standby handshake — including the list-panes probe with pane_active.
  let killed = false;
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("has-session")) return "";
    if (command.includes("set-option")) return "";
    if (command.includes("show-environment")) return "OPENRIG_NODE_ID=a";
    if (command.includes("kill-session")) return "";
    if (command.includes("detach-client")) return "";
    if (command.includes("list-panes")) return "%1|0|/fixture|120|40|1|1";
    if (command.includes("ps -o tpgid=")) { if (opts.unreadablePs) throw Error("ps: cannot read"); return "424242\n"; }
    if (command.includes("kill -0 -424242")) { if (opts.runnerSurvives) return ""; throw Error("kill: (424242) - No such process"); }
    if (command.includes("kill -TERM -424242") || command.includes("kill -KILL -424242")) { killed = true; return ""; }
    // The pane-pid kill (no group dash) ends the shell — and with it the runner.
    if (command.includes("kill -TERM 424242") || command.includes("kill -KILL 424242")) { killed = true; return ""; }
    if (command.startsWith("tmux display-message")) {
      if (command.includes("#{session_id}|")) return `$7|424242|1700000000|%1|${killed ? "1" : "0"}|worker@test|1|1`;
      if (command.includes("#{pane_dead}")) return killed ? "1" : "0";
      if (command.includes("#{pane_pid}")) return "424242";
    }
    throw Error(`unexpected command ${command}`);
  });
  tmux.processGroupGone = async () => !opts.runnerSurvives;
  const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name));
  tmux.deliveryGuard = guard;
  const lifecycle = new SeatLifecycleService({ db: f.db, rigRepo: new RigRepository(f.db),
    sessionRegistry: new SessionRegistry(f.db), eventBus: f.bus, tmuxAdapter: tmux });
  // The standby stop requires a resumable conversation.
  f.db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible'").run();
  return { guard, lifecycle };
}

it("a reaper stop is recorded generation-exactly and classifies as revivable", async () => {
  // Given a real reaper over the real checked-stop path.
  const f = fixture();
  const { guard, lifecycle } = wiring(f);
  let at = 0;
  const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
  // When the seat crosses the threshold and is reaped.
  for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
  // Then the stop names the exact session and the daemon's own attribution.
  expect(f.bus.replayAll(0)).toContainEqual(expect.objectContaining({
    type: "session.stopped", sessionId: "s", operator: "daemon:seat-reaper", reason: "idle_reap" }));
  // And cold start reads it as reclaimable, not as an operator decision.
  expect(classifyColdStartStop(f.db, "a")).toMatchObject({ kind: "daemon_reclaim",
    operator: "daemon:seat-reaper", reason: "idle_reap" });
});

it("an unreadable foreground-group probe keeps the standby record unwritten", async () => {
  // Given a reaper whose runner-exit confirmation cannot read the foreground group.
  const f = fixture();
  const { guard, lifecycle } = wiring(f, { unreadablePs: true });
  let at = 0;
  const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
  // When the seat crosses the threshold and the stop runs unconfirmed.
  for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
  // Then no standby record is written (no session.stopped at all), and the seat stays
  // intentional to cold start — an unknown probe is never a successful stop.
  expect(f.bus.replayAll(0).filter(e => e.type === "session.stopped")).toEqual([]);
  expect(classifyColdStartStop(f.db, "a")).toMatchObject({ kind: "intentional" });
});

it("a runner surviving its shell keeps the standby record unwritten", async () => {
  // Given a reaper whose foreground group survives the TERM/KILL.
  const f = fixture();
  const { guard, lifecycle } = wiring(f, { runnerSurvives: true });
  let at = 0;
  const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
  for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
  // Then the standby record is likewise unwritten: the runner is still alive.
  expect(f.bus.replayAll(0).filter(e => e.type === "session.stopped")).toEqual([]);
  expect(classifyColdStartStop(f.db, "a")).toMatchObject({ kind: "intentional" });
});

it("a human stop of the same seat is never revivable", async () => {
  // Given the same seat stopped by an operator through the same stop path.
  const f = fixture();
  const { lifecycle } = wiring(f);
  const result = await lifecycle.stopSeat({ seatRef: "worker@test", reason: "operator request" });
  expect(result.ok).toBe(true);
  // Then cold start treats it as an intentional end state.
  expect(classifyColdStartStop(f.db, "a")).toMatchObject({ kind: "intentional" });
});
