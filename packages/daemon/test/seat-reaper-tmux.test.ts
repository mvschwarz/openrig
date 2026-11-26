import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";

const exec = promisify(execFile);

it.each([false, true])("exercises real isolated tmux without an agent provider (observe=%s)", async observe => {
  // Given a private tmux server, real checked-stop services, and deterministic idle/capture inputs.
  const socket = `reaper-test-${randomUUID()}`;
  const run = async (...args: string[]) => (await exec("tmux", ["-L", socket, ...args], { timeout: 10_000 })).stdout;
  const pane = (await run("-f", "/dev/null", "new-session", "-d", "-s", "worker@test", "-P", "-F", "#{pane_id}", "sleep 300")).trim();
  // A sibling session keeps the server alive after the seat session is killed, so absence is a
  // positive tmux answer (transport_unavailable would mean the server, not just the seat, was gone).
  await run("new-session", "-d", "-s", "keeper", "sleep 300");
  // The seat's tmux session carries its own OpenRig marker, as a launched seat does; a session
  // without it is left alone by the checked stop (adopted/foreign sessions).
  await run("set-environment", "-t", "worker@test", "OPENRIG_NODE_ID", "a");
  try {
    const f = fixture(); f.settings.observe = observe;
    f.db.prepare("UPDATE bindings SET tmux_pane=?").run(pane);
    const tmux = new TmuxAdapter(async command => {
      if (!/^kill -(TERM|KILL) \d+$/.test(command)) throw Error("argv execution required");
      return (await exec("sh", ["-c", command], { timeout: 10_000 })).stdout;
    }, undefined,
      async argv => {
        const [file, ...args] = argv;
        if (!file) throw Error("missing executable");
        return (await exec(file, args, { timeout: 10_000 })).stdout;
      }, ["-L", socket]);
    const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name)); tmux.deliveryGuard = guard;
    const lifecycle = new SeatLifecycleService({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), eventBus: f.bus, tmuxAdapter: tmux });
    let at = 0;
    const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
    // When the reaper crosses the configured threshold.
    for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
    // Then real process liveness matches observe/enforce, and durable seat history survives.
    expect((await tmux.probeSession("worker@test")).state).toBe("present");
    expect((await run("display-message", "-p", "-t", pane, "#{pane_id}:#{pane_dead}")).trim()).toBe(`${pane}:${observe ? 0 : 1}`);
    expect(new SessionRegistry(f.db).getBindingForNode("a")?.tmuxPane).toBe(pane);
    expect(getNodeInventory(f.db, "r")[0]?.standbyStopped).toBe(observe ? undefined : true);
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id='s'").get()).toEqual({ resume_token: "/fixture/session.jsonl" });
    expect(f.db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(f.events().at(-1)).toMatchObject(observe ? { decision: "would-reap-observe" } : { phase: "effect", result: { ok: true } });
  } finally {
    try { await run("kill-server"); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("no server running")) throw error; }
  }
});
