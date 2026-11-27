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

function wiring(f: ReturnType<typeof fixture>, processState: "gone" | "unknown" | "survives" | "regrouped" | "backgrounded" | "exit unknown" = "gone") {
  let dead = false;
  const backgrounded = processState === "backgrounded";
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("has-session")) return "";
    if (command.includes("list-panes")) return "%1|0|/fixture|120|40|1";
    if (command.includes("show-environment")) return "OPENRIG_NODE_ID=a";
    if (command.includes("kill-session")) return "";
    if (command.includes("detach-client")) return "";
    if (command.includes("set-option")) return "";
    if (command === "kill -TERM -4300") return "";
    if (backgrounded && command === "kill -TERM -4242") { dead = true; return ""; }
    if (command === "kill -TERM 4242") { dead = true; return ""; }
    if (command.includes("#{session_windows}")) return `$7|4242|1700000000|%1|${Number(dead)}|worker@test|1|1`;
    if (command.includes("#{pane_pid}")) return "4242";
    if (command.includes("#{pane_dead}")) return String(Number(dead));
    if (command.startsWith("tmux display-message")) return "$7|4242|1700000000";
    throw Error(`unexpected command ${command}`);
  });
  tmux.standbyProcessCensus = async () => {
    if (processState === "unknown" || (dead && processState === "exit unknown")) throw new Error("process table unavailable");
    const common = { tpgid: backgrounded ? 4242 : 4300, startedAt: "fixture", executableName: "fixture", command: "fixture" };
    return { permissionHiddenPids: [], rows: [
      ...(!dead ? [{ ...common, pid: 4242, ppid: 1, pgid: 4242 }] : []),
      ...(backgrounded && !dead ? [{ ...common, pid: 4299, ppid: 4242, pgid: 4300 }] : []),
      ...(!dead || backgrounded || processState === "survives" || processState === "regrouped"
        ? [{ ...common, pid: 4300, ppid: dead ? 1 : backgrounded ? 4299 : 4242,
          pgid: dead && processState === "regrouped" ? 4400 : 4300 }] : []),
    ] };
  };
  const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name));
  tmux.deliveryGuard = guard;
  const lifecycle = new SeatLifecycleService({ db: f.db, rigRepo: new RigRepository(f.db),
    sessionRegistry: new SessionRegistry(f.db), eventBus: f.bus, tmuxAdapter: tmux,
    inPlaceRestartTiming: { timeoutMs: 100, sleep: async () => {} } });
  return { guard, lifecycle, tmux, paneExited: () => dead };
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

it.each(["unknown", "survives", "regrouped", "exit unknown"] as const)("does not record standby when runner observation is %s", async state => {
  const f = fixture();
  const { lifecycle } = wiring(f, state);
  const pre = lifecycle.stopPrecondition("worker@test");
  if (!("expected" in pre)) throw new Error("fixture missing stop selection");
  const result = await lifecycle.stopSeat({ seatRef: "worker@test", expected: pre.expected,
    operator: "daemon:seat-reaper", reason: "idle_reap" });
  expect(result.ok).toBe(false);
  expect(f.bus.replayAll(0)).not.toContainEqual(expect.objectContaining({ type: "session.stopped" }));
});

it("does not record standby when an already backgrounded runner outlives its shell and wrapper", async () => {
  const f = fixture();
  const { lifecycle, paneExited } = wiring(f, "backgrounded");
  const pre = lifecycle.stopPrecondition("worker@test");
  if (!("expected" in pre)) throw new Error("fixture missing stop selection");

  const result = await lifecycle.stopSeat({ seatRef: "worker@test", expected: pre.expected,
    operator: "daemon:seat-reaper", reason: "idle_reap" });

  expect(paneExited()).toBe(true);
  expect(result).toMatchObject({ ok: false, code: "stop_uncertain" });
  expect(f.bus.replayAll(0)).not.toContainEqual(expect.objectContaining({ type: "session.stopped" }));
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
