import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";

it.each([false, true])("uses the real checked stop and lifecycle lease (uncertain=%s)", async uncertain => {
  // Given real lifecycle/guard/adapter services, with only OS terminal effects replaced.
  const f = fixture(); let killed = false;
  const commands: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    commands.push(command);
    if (command.includes("has-session")) return "";
    if (command.includes("list-panes")) return "%1|0|/fixture|120|40|1";
    if (command.includes("show-environment")) return "OPENRIG_NODE_ID=a";
    if (command.startsWith("kill -")) {
      expect(f.events().at(-1)).toMatchObject({ phase: "capture", sessionId: "s" });
      if (uncertain) throw Error("kill interrupted");
      killed = true; return "";
    }
    if (command.includes("remain-on-exit")) return "";
    if (command.includes("#{session_windows}")) return `$7|4242|1700000000|%1|${killed ? 1 : 0}|worker@test|1|1`;
    if (command.includes("#{pane_dead}")) return killed ? "1" : "0";
    if (command.includes("#{pane_pid}")) return "4343";
    throw Error(`unexpected command ${command}`);
  });
  const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name)); tmux.deliveryGuard = guard;
  const lifecycle = new SeatLifecycleService({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), eventBus: f.bus, tmuxAdapter: tmux,
    inPlaceRestartTiming: { pollMs: 1, timeoutMs: 1, sleep: async () => {} } });
  let at = 0;
  const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
  // When the eligible seat reaches its threshold under the real guard.
  for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
  // Then only the reviewed tmux session is targeted, and effects match the receipt.
  expect(commands.filter(command => command.startsWith("kill -"))).toEqual(uncertain
    ? ["kill -TERM 4343", "kill -KILL 4343"] : ["kill -TERM 4343"]);
  expect(commands.some(command => command.includes("kill-session") || command.includes("detach-client"))).toBe(false);
  expect(killed).toBe(!uncertain);
  expect(f.events()).toContainEqual(expect.objectContaining({ phase: "effect", budgetConsumed: true,
    result: expect.objectContaining(uncertain ? { ok: false, code: "stop_uncertain" } : { ok: true }) }));
  if (!uncertain) {
    expect(f.db.prepare("SELECT status,intentionally_stopped FROM sessions WHERE id='s'").get()).toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(f.bus.replayAll(0)).toContainEqual(expect.objectContaining({ type: "session.stopped", reason: "idle_reap", operator: "daemon:seat-reaper" }));
  } else {
    expect(f.db.prepare("SELECT startup_status FROM sessions WHERE id='s'").get()).toEqual({ startup_status: "attention_required" });
  }
});
