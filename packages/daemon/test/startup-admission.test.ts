import { describe, expect, it } from "vitest";
import { StartupAdmission, startupAdmissionOptions, type StartupAdmissionSnapshot, type StartupAdmissionDeps } from "../src/domain/startup-admission.js";
import { linuxStartupMemory, macStartupMemory, type StartupMemory } from "../src/domain/startup-memory.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function harness(overrides: Partial<StartupAdmissionDeps> = {}, options = {}) {
  let now = 10000;
  const records: StartupAdmissionSnapshot[] = [];
  const healthy = (): StartupMemory => ({ observedAt: now, source: "fixture", totalBytes: 1000, availableBytes: 800, pressure: "normal" });
  const controller = new StartupAdmission({ observe: async () => healthy(), selection: () => "original-generation",
    persist: snapshot => { records.push(structuredClone(snapshot)); }, history: () => [], reconcile: async () => "absent",
    now: () => now, sleep: async ms => { now += ms; }, ...overrides },
  { ...startupAdmissionOptions({}), settleMs: 10, settleLimitMs: 30, ...options });
  return { controller, records, healthy };
}

describe("owning-daemon native startup admission", () => {
  it("deduplicates before waiting for an existing lifecycle lease without consuming a startup slot", async () => {
    const lease = deferred(); let leases = 0;
    const { controller } = harness({ lifecycle: async (_node, work) => { leases++; await lease.promise; return work(); } });
    let launches = 0;
    const first = controller.run("seat", "restore", async () => { launches++; return "original identity"; }, "same request");
    const duplicate = controller.run("seat", "restore", async () => { launches++; return "duplicate"; }, "same request");
    expect(duplicate).toBe(first); expect(leases).toBe(1); await flush(); expect(launches).toBe(0);
    lease.resolve(); expect(await duplicate).toBe("original identity"); expect(launches).toBe(1);
  });
  it("does not let a caller holding the lifecycle lease deadlock on a request waiting for that lease", async () => {
    const lease = deferred(); let owned = false;
    const { controller } = harness({ ownsLifecycle: () => owned, lifecycle: async (_node, work) => { await lease.promise; return work(); } });
    const pending = controller.run("seat", "restore", async () => "original");
    owned = true;
    await expect(controller.run("seat", "restore", async () => "second")).rejects.toMatchObject({ code: "startup_in_progress" });
    owned = false; lease.resolve(); expect(await pending).toBe("original");
  });
  it("cancels while waiting for a lifecycle lease before any launch or incumbent stop", async () => {
    const lease = deferred(); let effects = 0;
    const { controller } = harness({ lifecycle: async (_node, work) => { await lease.promise; return work(); } });
    const result = controller.run("seat", "restore", async () => { effects++; }).catch(error => error);
    expect(controller.control("seat", "cancel")).toBe(true);
    expect((await result).code).toBe("startup_cancelled");
    lease.resolve(); await flush(); expect(effects).toBe(0); expect(controller.pending("seat")).toBe(false);
  });
  it("refuses a different selected request instead of joining its result", async () => {
    const ready = deferred();
    const { controller } = harness();
    const first = controller.run("seat", "restore", async () => { await ready.promise; return "original"; }, "history-one");
    await expect(controller.run("seat", "restore", async () => "changed", "history-two")).rejects.toMatchObject({ code: "startup_in_progress" });
    ready.resolve(); expect(await first).toBe("original");
  });
  it("retains every dispatched target when a restore stops an old pane then launches another", async () => {
    const { controller, records } = harness();
    await controller.run("seat", "restore", async () => { controller.beforeDispatch("seat", "old-pane"); controller.beforeDispatch("seat", "new-pane"); });
    expect(records.at(-1)?.nativeTargets).toEqual(["old-pane", "new-pane"]);
  });
  it("serializes two rigs through one readiness and settling slot", async () => {
    const { controller, records } = harness();
    const ready = deferred();
    const calls: string[] = [];
    const a = controller.run("rig-a/seat", "restore", async () => { calls.push("a"); controller.beforeDispatch("rig-a/seat"); await ready.promise; return { ok: true }; });
    const b = controller.run("rig-b/seat", "successor", async () => { calls.push("b"); controller.beforeDispatch("rig-b/seat"); return { ok: true }; });
    await flush(); expect(calls).toEqual(["a"]);
    ready.resolve(); await Promise.all([a, b]); expect(calls).toEqual(["a", "b"]);
    const completeA = records.findIndex(r => r.nodeId === "rig-a/seat" && r.phase === "complete");
    const startB = records.findIndex(r => r.nodeId === "rig-b/seat" && r.phase === "starting");
    expect(startB).toBeGreaterThan(completeA);
  });

  it("keeps the slot after readiness while fresh memory remains low, up to the settling bound", async () => {
    let reads = 0;
    const { controller, records } = harness({ observe: async () => ({ observedAt: 10000 + Math.max(0, reads - 1) * 10,
      source: "fixture", totalBytes: 1000, availableBytes: ++reads === 1 || reads > 3 ? 800 : 100, pressure: "normal" }) });
    await controller.run("seat", "startup", async () => ({ ok: true }));
    expect(records.some(r => r.phase === "settling" && r.reason.includes("memory recovery"))).toBe(true);
    expect(records.at(-1)?.phase).toBe("complete");
  });

  it("surfaces a one-seat deficit before any dispatch and allows deliberate continue-one", async () => {
    const { controller } = harness({ observe: async () => ({ observedAt: 10000, source: "fixture", totalBytes: 1000, availableBytes: 100, pressure: "high" }) });
    let calls = 0;
    const attempt = controller.run("seat", "startup", async () => { calls++; return { ok: true }; });
    await flush(); expect(calls).toBe(0);
    expect(controller.status("seat")?.reason).toContain("One-seat memory deficit");
    expect(controller.control("seat", "continue")).toBe(true);
    await attempt; expect(calls).toBe(1);
  });

  it("degraded telemetry serializes even with a larger configured cap and never permanently refuses", async () => {
    const { controller, records } = harness({ observe: async () => { throw new Error("no telemetry"); } }, { concurrency: 3 });
    const ready = deferred(); const calls: string[] = [];
    const a = controller.run("a", "startup", async () => { calls.push("a"); await ready.promise; return { ok: true }; });
    const b = controller.run("b", "startup", async () => { calls.push("b"); return { ok: true }; });
    await flush(); expect(calls).toEqual(["a"]);
    expect(records.some(r => r.protectionUnavailable && r.reason.includes("unavailable"))).toBe(true);
    ready.resolve(); await Promise.all([a, b]); expect(calls).toEqual(["a", "b"]);
  });

  it("a stale pressure reading degrades instead of becoming an indefinite pressure refusal", async () => {
    const { controller } = harness({ observe: async () => ({ observedAt: 0, source: "stale", totalBytes: 1000, availableBytes: 0, pressure: "high" }) });
    await expect(controller.run("seat", "startup", async () => "kept history")).resolves.toBe("kept history");
    expect(controller.status("seat")?.protectionUnavailable).toBe(true);
  });

  it("strict telemetry waiting is opt-in and can be cancelled before dispatch", async () => {
    const { controller } = harness({ observe: async () => { throw new Error("unreadable"); } }, { strictTelemetry: true });
    let calls = 0;
    const outcome = controller.run("seat", "startup", async () => { calls++; }).catch(error => error);
    await flush(); expect(controller.status("seat")?.reason).toContain("strict telemetry");
    expect(controller.control("seat", "cancel")).toBe(true);
    expect((await outcome).code).toBe("startup_cancelled"); expect(calls).toBe(0);
  });

  it("joins duplicate slow replies before waiting, preserving the original conversation arguments", async () => {
    const { controller } = harness(); const ready = deferred();
    const selected = { nativeId: "original", model: "chosen-model", effort: "chosen-effort" };
    const calls: unknown[] = [];
    const work = async () => { calls.push(structuredClone(selected)); await ready.promise; return selected; };
    const first = controller.run("seat", "restore", work);
    // The first caller has stopped waiting for its HTTP response; its native operation remains owned.
    const again = controller.run("seat", "restore", work);
    expect(again).toBe(first); await flush(); expect(calls).toEqual([selected]);
    ready.resolve(); expect(await again).toBe(selected); expect(await first).toBe(selected);
  });

  it("revalidates a queued selection rather than starting a later occupant", async () => {
    let generation = "old"; const ready = deferred();
    const { controller } = harness({ selection: () => generation });
    const a = controller.run("a", "restore", async () => { await ready.promise; return { ok: true }; });
    let calls = 0;
    const b = controller.run("b", "restore", async () => { calls++; }).catch(error => error);
    await flush(); generation = "new"; ready.resolve(); await a;
    expect((await b).code).toBe("startup_selection_changed"); expect(calls).toBe(0);
  });

  it("nested startup reuses the existing slot instead of deadlocking", async () => {
    const { controller } = harness();
    await expect(controller.run("seat", "restore", () => controller.run("seat", "startup", async () => "same native history")))
      .resolves.toBe("same native history");
  });

  it.each(["live", "unknown"] as const)("reconciles a persisted %s launch before retry and never duplicates it", async state => {
    const previous: StartupAdmissionSnapshot = { attemptId: "interrupted", nodeId: "seat", kind: "restore", selection: "original-generation",
      phase: "starting", reason: "dispatched", observedAt: 1, dispatchedAt: 1, dispatchSeq: 5 };
    const { controller, records } = harness({ history: () => [previous], reconcile: async () => state });
    let calls = 0;
    await expect(controller.run("seat", "restore", async () => { calls++; })).rejects.toMatchObject({ code: "startup_unreconciled" });
    expect(calls).toBe(0); expect(controller.status("seat")?.attemptId).toBe("interrupted");
    expect(records).toEqual([]);
  });

  it("recovery after proven process absence can retry, without treating absence as ready", async () => {
    const { controller } = harness({ history: () => [{ attemptId: "old", nodeId: "seat", kind: "restore", selection: "original-generation",
      phase: "uncertain", reason: "lost reply", observedAt: 1 }], reconcile: async () => "absent" });
    let calls = 0;
    await controller.run("seat", "restore", async () => { calls++; return { ok: true }; }); expect(calls).toBe(1);
  });

  it("cancels during a pending OS observation without dispatching", async () => {
    const sample = deferred<StartupMemory>();
    const { controller } = harness({ observe: () => sample.promise });
    let calls = 0;
    const result = controller.run("seat", "restore", async () => { calls++; }).catch(error => error);
    expect(controller.control("seat", "cancel")).toBe(true);
    sample.resolve({ observedAt: 10000, source: "fixture", totalBytes: 1000, availableBytes: 800, pressure: "normal" });
    expect((await result).code).toBe("startup_cancelled"); await flush(); expect(calls).toBe(0);
  });

  it("a refused preflight neither owns a native attempt nor blocks the next seat", async () => {
    const { controller, records } = harness();
    await expect(controller.run("a", "restore", async () => { throw new Error("Invalid projection"); })).rejects.toThrow("Invalid projection");
    await expect(controller.run("b", "startup", async () => "original session")).resolves.toBe("original session");
    expect(records.filter(r => r.nodeId === "a").some(r => r.phase === "uncertain")).toBe(false);
  });

  it("cancellation during preparation is enforced at the native boundary", async () => {
    const { controller } = harness(); const prepare = deferred(); let nativeCalls = 0;
    const attempt = controller.run("seat", "restore", async () => {
      await prepare.promise;
      controller.beforeDispatch("seat", "exact-pane");
      nativeCalls++;
    }).catch(error => error);
    await flush(); expect(controller.status("seat")?.phase).toBe("preparing");
    expect(controller.control("seat", "cancel")).toBe(true);
    prepare.resolve(); expect((await attempt).code).toBe("startup_cancelled"); expect(nativeCalls).toBe(0);
  });
});

describe("read-only startup memory interpretation", () => {
  it("uses Linux MemAvailable rather than MemFree", () => {
    expect(linuxStartupMemory("MemTotal: 1000 kB\nMemFree: 1 kB\nMemAvailable: 600 kB\n", 42))
      .toMatchObject({ totalBytes: 1024000, availableBytes: 614400, observedAt: 42 });
  });
  it("reads macOS query headroom and pressure independently", () => {
    expect(macStartupMemory("System-wide memory free percentage: 68%", "2\n", 1000, 42))
      .toMatchObject({ availableBytes: 680, pressure: "high" });
    expect(macStartupMemory("unrecognized output", "1", 1000, 42))
      .toMatchObject({ availableBytes: null, pressure: "normal" });
  });
});
