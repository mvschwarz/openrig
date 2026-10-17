import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { createTestApp } from "./helpers/test-app.js";

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

describe.skipIf(!nativeAvailable)("claimed-session custody with native tmux", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let run: (...args: string[]) => Promise<string>;

  beforeEach(async () => {
    const socket = `openrig-unclaim-test-${process.pid}-${Date.now()}`;
    const execute = promisify(execFile);
    run = async (...args) => (await execute("tmux", ["-L", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined,
      async argv => run(...argv.slice(1)));
    adapter.deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
    setup = createTestApp(db, { tmux: adapter });
    await run("new-session", "-d", "-s", "manual-adoption", "cat");
  });
  afterEach(async () => {
    await run("kill-server").catch(() => {});
    db.close();
  });

  async function claimSeat() {
    const rig = setup.rigRepo.createRig("native-adoption");
    const node = setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "terminal" });
    const pane = (await run("display-message", "-p", "-t", "=manual-adoption:", "#{pane_id}")).trim();
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-adoption", tmuxPane: pane, cwd: "/tmp",
      activeCommand: "cat", runtimeHint: "terminal", confidence: "high",
    });
    const bind = () => setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    const first = await bind();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    return { node, discovered, first, bind };
  }

  async function livePanePid(): Promise<number> {
    const reading = (await run("display-message", "-p", "-t", "=manual-adoption:", "#{pane_pid}")).trim();
    expect(reading).toMatch(/^[1-9]\d*$/);
    const pid = Number(reading);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    return pid;
  }

  it("preserves the physical session and its new metadata after an old-ID retry", async () => {
    const { node, first, bind } = await claimSeat();
    expect((await setup.rigLifecycleService.unclaimSession(first.sessionId)).ok).toBe(true);
    expect((await bind()).ok).toBe(true);
    const before = await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id");
    expect(before.trim()).toBe(node.id);
    const pid = await livePanePid();
    const response = await setup.app.request(`/api/sessions/${first.sessionId}/unclaim`, { method: "POST" });
    expect(await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).toBe(before);
    expect(await livePanePid()).toBe(pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(response.status).toBe(409);
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("manual-adoption");
  });

  it("ordinary unclaim clears only managed metadata and leaves the external process alive", async () => {
    const { node, discovered, first } = await claimSeat();
    expect((await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).trim()).toBe(node.id);
    const pid = await livePanePid();
    const response = await setup.app.request(`/api/sessions/${first.sessionId}/unclaim`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).trim()).toBe("");
    expect(await livePanePid()).toBe(pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("active");
  });

  it("keeps successor metadata through a real claim lease and a queued stale unclaim", async () => {
    const { node, discovered, first, bind } = await claimSeat();
    expect((await setup.rigLifecycleService.unclaimSession(first.sessionId)).ok).toBe(true);
    const pid = await livePanePid();
    let entered!: () => void, finish!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { finish = resolve; });
    const adapter = setup.tmuxAdapter;
    const setOption = adapter.setSessionOption.bind(adapter);
    let waiting = true;
    vi.spyOn(adapter, "setSessionOption").mockImplementation(async (name, key, value) => {
      const result = await setOption(name, key, value);
      if (waiting && key === "@rigged_node_id" && value === node.id) {
        waiting = false;
        entered();
        await resume;
      }
      return result;
    });
    const claim = bind();
    await paused;
    expect((await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).trim()).toBe(node.id);
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const discovery = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    const detached = db.prepare("SELECT count(*) AS n FROM events WHERE type = 'session.detached'").get();
    const notify = vi.spyOn(setup.eventBus, "notifySubscribers");
    let completed = false;
    const request = setup.app.request(`/api/sessions/${first.sessionId}/unclaim`, { method: "POST" })
      .then(response => { completed = true; return response; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedDuringClaim = completed;
    finish();
    const successor = await claim;
    const response = await request;
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error(successor.error);
    const rig = setup.rigRepo.getRig(node.rigId)!;
    const expected: Record<string, string> = {
      "@rigged_node_id": node.id, "@rigged_session_name": "manual-adoption",
      "@rigged_rig_id": node.rigId, "@rigged_rig_name": rig.rig.name, "@rigged_logical_id": node.logicalId,
    };
    for (const [key, value] of Object.entries(expected)) {
      expect((await run("show-options", "-qv", "-t", "=manual-adoption:", key)).trim()).toBe(value);
    }
    expect(response.status).toBe(409);
    expect(completedDuringClaim).toBe(false);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)).toEqual(discovery);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(successor.sessionId)).toEqual({ status: "running" });
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'session.detached'").get()).toEqual(detached);
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session.detached" }));
    expect(await livePanePid()).toBe(pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
});
