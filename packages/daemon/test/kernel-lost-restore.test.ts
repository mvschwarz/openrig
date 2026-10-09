// #1078 — daemon start restores a kernel a reboot left down, and only that kernel. Startup reconcile
// marks a seat whose tmux session is gone `detached`; `rig down` marks it `exited`. These tests run
// the real teardown and the real startup reconciler against a real database, then boot the kernel
// the way daemon start does, with the restore itself stubbed.

import { Hono } from "hono";
import { kernelStatusRoutes } from "../src/routes/kernel-status.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { bootKernelIfNeeded, classifyManagedKernel } from "../src/domain/kernel-boot.js";
import { restoreExistingRigUnattended } from "../src/domain/existing-rig-restore.js";
import type { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SEATS = ["kernel.operator", "kernel.advisor"];
const dbs: Database.Database[] = [];
const dirs: string[] = [];

afterEach(() => {
  delete process.env.OPENRIG_NO_KERNEL;
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function host(claimed = false) {
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const snapshotRepo = new SnapshotRepository(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore: new CheckpointStore(db) });
  const live = new Set<string>();
  const tmux = {
    hasSession: vi.fn(async (name: string) => live.has(name)),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    killSession: vi.fn(async (name: string) => { live.delete(name); return { ok: true }; }),
    listSessions: vi.fn(async () => [...live].map((name) => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;

  const rig = rigRepo.createRig("kernel");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("kernel-pod", rig.id, "Kernel");
  const nodes = SEATS.map((logicalId) => {
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", podId: "kernel-pod" });
    const name = `${logicalId.replace(".", "-")}@kernel`;
    const session = claimed ? sessionRegistry.registerClaimedSession(node.id, name) : sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    live.add(name);
    return { node, name };
  });

  const specsDir = mkdtempSync(join(tmpdir(), "kernel-lost-restore-")); dirs.push(specsDir);
  mkdirSync(join(specsDir, "rigs/launch/kernel"), { recursive: true });
  for (const variant of ["rig.yaml", "rig-claude-only.yaml", "rig-codex-only.yaml"]) {
    writeFileSync(join(specsDir, "rigs/launch/kernel", variant), "name: kernel\n");
  }
  const bootstrap = { bootstrap: vi.fn(async () => ({ runId: "t", status: "ok", stages: [], errors: [], warnings: [] })) };

  /** What a reboot does: every tmux session is gone, the database still says running. */
  const reboot = () => live.clear();
  /** What `rig down kernel` does. */
  const down = () => new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
  /** What daemon start does: reconcile every rig, then boot the kernel. */
  const reconcile = async () => {
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    for (const r of rigRepo.listRigs()) await reconciler.reconcile(r.id);
  };
  const daemonStart = async (restoreLostKernel?: (rigId: string) => Promise<{ errors: string[] }>) => {
    await reconcile();
    return bootKernelIfNeeded({
      rigRepo, sessionRegistry, eventBus,
      bootstrapOrchestrator: bootstrap as unknown as BootstrapOrchestrator,
      specsDir, cwdOverride: specsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
      degradedTimeoutMs: 0,
      ...(restoreLostKernel ? { restoreLostKernel } : {}),
    });
  };
  const statuses = () => (db.prepare(
    "SELECT status FROM sessions WHERE node_id IN (SELECT id FROM nodes WHERE rig_id = ?) ORDER BY created_at, id",
  ).all(rig.id) as Array<{ status: string }>).map((row) => row.status);
  return { db, rigRepo, sessionRegistry, eventBus, tmux, snapshotRepo, snapshotCapture, rig, nodes, live, reboot, down, reconcile, daemonStart, statuses, bootstrap };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("daemon start with an existing kernel rig", () => {
  it("restores a kernel a reboot left down", async () => {
    const h = host();
    h.reboot();
    const restore = vi.fn(async () => ({ errors: [] }));
    const tracker = await h.daemonStart(restore);
    expect(h.statuses()).toEqual(["detached", "detached"]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(h.rig.id);
    expect(tracker.getStatus().kernelState).toBe("booting");
    expect(h.bootstrap.bootstrap).not.toHaveBeenCalled();
  });

  it("a kernel stopped with `rig down kernel` stays stopped across daemon restarts", async () => {
    const h = host();
    const down = await h.down();
    expect(down.errors).toEqual([]);
    expect(h.statuses()).toEqual(["exited", "exited"]);
    const restore = vi.fn(async () => ({ errors: [] }));
    for (let restart = 0; restart < 3; restart++) {
      if (restart === 1) h.reboot();
      const tracker = await h.daemonStart(restore);
      expect(tracker.getStatus()).toMatchObject({ kernelState: "skipped", detail: "kernel rig already managed" });
    }
    expect(restore).not.toHaveBeenCalled();
    expect(h.bootstrap.bootstrap).not.toHaveBeenCalled();
    expect(h.statuses()).toEqual(["exited", "exited"]);
  });

  // `rig down kernel` on a kernel startup already marked detached reports it already stopped; it
  // must still count as the request to keep it down.
  it.each(["a failed automatic restore", "a --no-kernel start", "a start without the restore wired"] as const)(
    "`rig down kernel` after a reboot and %s keeps the next start skipped", async (before) => {
      const h = host();
      h.reboot();
      if (before === "a --no-kernel start") process.env.OPENRIG_NO_KERNEL = "1";
      const failed = vi.fn(async () => ({ errors: ["restore failed"] }));
      await h.daemonStart(before === "a failed automatic restore" ? failed : undefined);
      await flush();
      delete process.env.OPENRIG_NO_KERNEL;
      expect(h.statuses()).toEqual(["detached", "detached"]);
      const down = await h.down();
      expect(down).toMatchObject({ alreadyStopped: true, errors: [] });
      expect(h.statuses()).toEqual(["exited", "exited"]);
      for (const { node } of h.nodes) expect(h.sessionRegistry.getBindingForNode(node.id)).toBeNull();
      const restore = vi.fn(async () => ({ errors: [] }));
      const tracker = await h.daemonStart(restore);
      expect(tracker.getStatus()).toMatchObject({ kernelState: "skipped", detail: "kernel rig already managed" });
      expect(restore).not.toHaveBeenCalled();
    });

  it("`rig down` leaves an unclaimed detached seat and older rows as they are", async () => {
    const h = host();
    h.reboot();
    await h.reconcile();
    // Unclaim releases the operator's seat: detached with no binding. The advisor stays lost.
    const [operator, advisor] = h.nodes;
    h.sessionRegistry.clearBinding(operator!.node.id);
    await h.down();
    expect(h.statuses()).toEqual(["detached", "exited"]);
    expect(h.sessionRegistry.getBindingForNode(advisor!.node.id)).toBeNull();
  });

  it("OPENRIG_NO_KERNEL=1 never restores one", async () => {
    const h = host();
    h.reboot();
    process.env.OPENRIG_NO_KERNEL = "1";
    const restore = vi.fn(async () => ({ errors: [] }));
    const tracker = await h.daemonStart(restore);
    expect(tracker.getStatus()).toMatchObject({ kernelState: "skipped", detail: "OPENRIG_NO_KERNEL=1" });
    expect(restore).not.toHaveBeenCalled();
  });

  it("a running kernel is left alone and reported from its seats", async () => {
    const h = host();
    const restore = vi.fn(async () => ({ errors: [] }));
    const tracker = await h.daemonStart(restore);
    expect(restore).not.toHaveBeenCalled();
    expect(tracker.getStatus()).toMatchObject({ kernelState: "ready", detail: "kernel rig already managed" });
  });

  it("a running kernel with no seat ready stays skipped rather than reporting a new failure", async () => {
    const h = host();
    for (const { node } of h.nodes) {
      const session = h.sessionRegistry.getSessionsForRig(h.rig.id).find((s) => s.nodeId === node.id)!;
      h.sessionRegistry.updateStartupStatus(session.id, "attention_required");
    }
    const tracker = await h.daemonStart(vi.fn(async () => ({ errors: [] })));
    expect(tracker.getStatus().kernelState).toBe("skipped");
  });

  it("one seat stopped and one lost counts as stopped", async () => {
    const h = host();
    const [first] = h.nodes;
    const session = h.sessionRegistry.getSessionsForRig(h.rig.id).find((s) => s.nodeId === first!.node.id)!;
    h.sessionRegistry.updateStatus(session.id, "exited");
    h.reboot();
    const restore = vi.fn(async () => ({ errors: [] }));
    const tracker = await h.daemonStart(restore);
    expect(restore).not.toHaveBeenCalled();
    expect(tracker.getStatus().kernelState).toBe("skipped");
  });

  it("a restore that fails reports bootstrap_failed with its reason", async () => {
    const h = host();
    h.reboot();
    const tracker = await h.daemonStart(async () => ({ errors: ["kernel.operator: resume refused"] }));
    await flush();
    expect(tracker.getStatus()).toMatchObject({ kernelState: "bootstrap_failed", detail: "kernel.operator: resume refused" });
  });

  it("without a restore dependency a lost kernel is skipped as before", async () => {
    const h = host();
    h.reboot();
    const tracker = await h.daemonStart();
    expect(tracker.getStatus()).toMatchObject({ kernelState: "skipped", detail: "kernel rig already managed" });
  });
});

describe("classifyManagedKernel", () => {
  it("is unknown when a seat has no session", async () => {
    const h = host();
    h.rigRepo.addNode(h.rig.id, "kernel.queue", { runtime: "claude-code", podId: "kernel-pod" });
    h.reboot();
    await h.reconcile();
    expect(classifyManagedKernel(h.rigRepo, h.sessionRegistry)).toEqual({ kind: "unknown" });
  });

  it("reads each seat's newest session", async () => {
    const h = host();
    await h.down();
    // A later occupant of each seat, lost to a reboot, outranks the stopped one before it.
    for (const { node, name } of h.nodes) {
      const next = h.sessionRegistry.registerSession(node.id, name);
      h.sessionRegistry.updateStatus(next.id, "detached");
      h.sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    }
    const managed = classifyManagedKernel(h.rigRepo, h.sessionRegistry);
    expect(managed.kind).toBe("lost");
    expect("seats" in managed ? [...managed.seats].sort() : []).toEqual([...SEATS].sort());
  });
});

describe("restoreExistingRigUnattended", () => {
  const outcome = (rigResult: string, nodes: Array<{ logicalId: string; status: string; error?: string }>) => ({
    ok: true, result: { snapshotId: "s", preRestoreSnapshotId: null, rigResult, warnings: [],
      nodes: nodes.map((node) => ({ nodeId: node.logicalId, ...node })) },
  });
  async function run(result: unknown, opts: { snapshot?: boolean } = {}) {
    const h = host();
    if (opts.snapshot !== false) h.snapshotCapture.captureSnapshot(h.rig.id, "auto-pre-down");
    h.reboot();
    await h.reconcile();
    const restore = vi.fn(async () => result);
    const errors = await restoreExistingRigUnattended({
      rigRepo: h.rigRepo, snapshotRepo: h.snapshotRepo, snapshotCapture: h.snapshotCapture,
      restoreOrchestrator: { restore } as unknown as RestoreOrchestrator,
    }, h.rig.id, () => false);
    return { errors, restore };
  }

  it("restores from the rig's restore snapshot and reports no errors when it comes back", async () => {
    const { errors, restore } = await run(outcome("fully_restored", [{ logicalId: "kernel.operator", status: "resumed" }]));
    expect(errors).toEqual({ errors: [] });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("a partial restore is not a failure", async () => {
    const { errors } = await run(outcome("partially_restored", [
      { logicalId: "kernel.operator", status: "resumed" },
      { logicalId: "kernel.advisor", status: "failed", error: "resume refused" },
    ]));
    expect(errors).toEqual({ errors: [] });
  });

  it("a failed restore reports each seat's error", async () => {
    const { errors } = await run(outcome("failed", [
      { logicalId: "kernel.operator", status: "failed", error: "resume refused" },
      { logicalId: "kernel.advisor", status: "failed" },
    ]));
    expect(errors).toEqual({ errors: ["kernel.operator: resume refused"] });
  });

  it("a restore that was not attempted says so", async () => {
    expect((await run(outcome("not_attempted", []))).errors).toEqual({ errors: ["restore not_attempted"] });
  });

  it("a refused restore reports its message", async () => {
    const { errors } = await run({ ok: false, code: "rig_locked", message: "Rig is being restored" });
    expect(errors).toEqual({ errors: ["Rig is being restored"] });
  });

  it("reports the reason when the rig cannot be restored at all", async () => {
    const h = host();
    const errors = await restoreExistingRigUnattended({
      rigRepo: h.rigRepo, snapshotRepo: h.snapshotRepo, snapshotCapture: h.snapshotCapture,
    }, "no-such-rig", () => false);
    expect(errors).toEqual({ errors: ["Rig no-such-rig not found"] });
  });
});

// Boundaries from dev-review's review of ed95ff48.
describe("existing-kernel boundaries", () => {
  it("does not auto-restore intentionally unclaimed seats", async () => {
    const h = host(true);
    const setup = createTestApp(h.db, { tmux: h.tmux });
    for (const { name } of h.nodes) {
      const released = await setup.rigLifecycleService.unclaimSession(name);
      expect(released.ok).toBe(true);
    }
    expect(h.live.size).toBe(2);
    expect(h.statuses()).toEqual(["detached", "detached"]);
    expect(h.rigRepo.getRig(h.rig.id)!.nodes.every(node => node.binding === null)).toBe(true);
    const restore = vi.fn(async () => ({ errors: [] }));
    const tracker = await h.daemonStart(restore);
    tracker.stop();
    expect(restore).not.toHaveBeenCalled();
  });

  it("a missing kernel seat does not project full readiness", async () => {
    const h = host();
    h.rigRepo.addNode(h.rig.id, "kernel.queue", { runtime: "claude-code", podId: "kernel-pod" });
    const restore = vi.fn(async () => ({ errors: [] }));
    const tracker = await h.daemonStart(restore);
    tracker.stop();
    expect(restore).not.toHaveBeenCalled();
    expect(tracker.getStatus().kernelState).not.toBe("ready");
  });
});

describe("kernel status public response", () => {
  it("preserves the down flag for a gone seat", async () => {
    const h = host();
    h.live.delete(h.nodes[0]!.name);
    const tracker = await h.daemonStart(vi.fn(async () => ({ errors: [] })));
    const app = new Hono();
    app.use("*", async (c,next) => { c.set("kernelBootTracker" as never, tracker as never); await next(); });
    app.route("/api/kernel", kernelStatusRoutes);
    const response = await app.request("/api/kernel/status");
    const body = await response.json();
    tracker.stop();
    expect(body).toMatchObject({ kernel_state: "partial_ready", agents: expect.arrayContaining([
      expect.objectContaining({ session_name: h.nodes[0]!.name, down: true }),
    ]) });
  });
});

describe("a seat whose newest session was superseded", () => {
  it("reads down, so the kernel is not ready with nothing running", async () => {
    const h = host();
    const tracker = await h.daemonStart(vi.fn(async () => ({ errors: [] })));
    expect(tracker.getStatus().kernelState).toBe("ready");
    const rolledBack = h.sessionRegistry.registerSession(h.nodes[0]!.node.id, h.nodes[0]!.name);
    h.sessionRegistry.updateStartupStatus(rolledBack.id, "ready");
    h.sessionRegistry.updateStatus(rolledBack.id, "superseded");
    const status = tracker.getStatus();
    tracker.stop();
    expect(status.kernelState).toBe("partial_ready");
    expect(status.agents.find((agent) => agent.sessionName === h.nodes[0]!.name)).toMatchObject({ down: true });
  });
});

describe("kernel status names an existing-kernel restore", () => {
  const status = async (tracker: Awaited<ReturnType<ReturnType<typeof host>["daemonStart"]>>) => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("kernelBootTracker" as never, tracker as never); await next(); });
    app.route("/api/kernel", kernelStatusRoutes);
    return (await app.request("/api/kernel/status")).json();
  };

  it("in progress while the restore runs, finished once it returns, and absent on any other boot", async () => {
    const h = host();
    h.reboot();
    let finish!: (result: { errors: string[] }) => void;
    const tracker = await h.daemonStart(() => new Promise((resolve) => { finish = resolve; }));
    expect(await status(tracker)).toMatchObject({ kernel_state: "booting", existing_restore: "in_progress" });
    finish({ errors: ["restore failed"] });
    await flush();
    expect(await status(tracker)).toMatchObject({ kernel_state: "bootstrap_failed", existing_restore: "finished" });
    tracker.stop();

    const running = host();
    const live = await running.daemonStart(vi.fn(async () => ({ errors: [] })));
    expect(await status(live)).not.toHaveProperty("existing_restore");
    live.stop();
  });
});
