import { afterEach, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { daemonStartupAdmission } from "../src/domain/daemon-startup-admission.js";
import type { StartupAdmissionSnapshot } from "../src/domain/startup-admission.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

vi.mock("../src/domain/startup-memory.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/domain/startup-memory.js")>(),
  observeStartupMemory: async () => ({ observedAt: Date.now(), source: "fixture", totalBytes: 1000, availableBytes: 800, pressure: "normal" }),
}));
vi.mock("../src/domain/native-process-lineage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/domain/native-process-lineage.js")>(), verifyPaneIdleShell: async () => false,
}));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("OPENRIG_STARTUP_SETTLE_MS", "0"); vi.stubEnv("OPENRIG_STARTUP_SETTLE_LIMIT_MS", "0");
  const db = createFullTestDb(), events = new EventBus(db), registry = new SessionRegistry(db), rigs = new RigRepository(db);
  const rig = rigs.createRig("admission-fixture"), node = rigs.addNode(rig.id, "worker", { runtime: "codex", model: "selected-model", effort: "high" });
  const probeSession = vi.fn(async (_target: string) => ({ state: "absent" as "present" | "absent" | "unknown" }));
  const tmux = { probeSession } as unknown as TmuxAdapter;
  return { db, events, registry, rig, node, tmux, probeSession, controller: () => daemonStartupAdmission(db, events, registry, tmux) };
}
it("persists native dispatch and completion on the existing event surface with the original node settings", async () => {
  const f = fixture();
  try {
    const controller = f.controller();
    expect(await controller.run(f.node.id, "startup", async () => { controller.beforeDispatch(f.node.id, "worker@admission-fixture"); return "original conversation"; })).toBe("original conversation");
    const rows = f.db.prepare("SELECT payload FROM events WHERE type='node.startup_admission' ORDER BY seq").all() as Array<{payload: string}>;
    const snapshots = rows.map(row => JSON.parse(row.payload).admission as StartupAdmissionSnapshot);
    expect(snapshots.some(row => row.phase === "starting" && row.nativeTarget === "worker@admission-fixture")).toBe(true);
    expect(snapshots.at(-1)?.phase).toBe("complete");
    expect(f.controller().status(f.node.id)?.phase).toBe("complete");
    expect(f.db.prepare("SELECT model,effort FROM nodes WHERE id=?").get(f.node.id)).toEqual({ model: "selected-model", effort: "high" });
  } finally { f.db.close(); }
});
it.each(["live", "unknown"])("retains interrupted custody when an old target is gone but the later target is %s", async state => {
  const f = fixture();
  try {
    const admission: StartupAdmissionSnapshot = { attemptId: "interrupted", nodeId: f.node.id, kind: "restore", selection: "original", phase: "starting", reason: "lost reply", observedAt: Date.now(), dispatchedAt: Date.now(), nativeTarget: "new-target", nativeTargets: ["old-target", "new-target"] };
    f.events.emit({ type: "node.startup_admission", rigId: f.rig.id, nodeId: f.node.id, admission });
    f.probeSession.mockImplementation(async target => ({ state: target === "old-target" ? "absent" : state === "live" ? "present" : "unknown" }));
    const controller = f.controller(), work = vi.fn(async () => "must not repeat");
    await expect(controller.run(f.node.id, "restore", work)).rejects.toMatchObject({ code: "startup_unreconciled" });
    expect(work).not.toHaveBeenCalled(); expect(controller.status(f.node.id)?.attemptId).toBe("interrupted");
    expect(f.probeSession.mock.calls.map(call => call[0])).toEqual(["old-target", "new-target"]);
  } finally { f.db.close(); }
});
