// Health1305: one watchdog pass used to hold the event loop for every due job: an evaluate that does its work without
// real I/O resolves at once, and awaiting it only runs microtasks. The pass now takes an event-loop turn between jobs
// (the #2649 pattern), keeps their order, and doesn't evaluate a job stopped, or anything after a shutdown, meanwhile.
import { describe, expect, it } from "vitest";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";

function harness(ids: string[], onEvaluate: (id: string, scheduler: () => WatchdogScheduler) => void) {
  const state = new Map(ids.map(id => [id, "active"]));
  const jobs = ids.map(jobId => ({ jobId, policy: "test", specYaml: "", registeredAt: "2026-11-27T00:00:00.000Z",
    intervalSeconds: 60, scanIntervalSeconds: null, lastEvaluationAt: null, state: "active" }));
  const evaluated: string[] = [];
  let scheduler!: WatchdogScheduler;
  scheduler = new WatchdogScheduler({
    jobsRepo: { listActive: () => jobs, getById: (id: string) => ({ ...jobs.find(j => j.jobId === id)!, state: state.get(id) }) } as never,
    policyEngine: { evaluate: async (job: { jobId: string }) => { evaluated.push(job.jobId); onEvaluate(job.jobId, () => scheduler); },
      deliverHeldReminders: async () => {} } as never,
    setTimer: () => 0 as never, clearTimer: () => {},
  });
  return { scheduler, evaluated, state };
}

describe("watchdog pass yields to the event loop between jobs", () => {
  it("runs queued event-loop work between two jobs, not after the whole pass, in job order", async () => {
    const order: string[] = [];
    const h = harness(["job-1", "job-2"], id => {
      order.push(id);
      if (id === "job-1") setImmediate(() => order.push("event loop"));   // a macrotask queued during job 1
    });
    await h.scheduler.runTickNow();
    expect(order).toEqual(["job-1", "event loop", "job-2"]);
  });

  it("doesn't evaluate a job stopped during the turn, and goes on to the next", async () => {
    const h = harness(["job-1", "job-2", "job-3"], id => { if (id === "job-1") setImmediate(() => h.state.set("job-2", "stopped")); });
    await h.scheduler.runTickNow();
    expect(h.evaluated).toEqual(["job-1", "job-3"]);
  });

  it("evaluates nothing more once the scheduler stops during the turn", async () => {
    const h = harness(["job-1", "job-2"], (id, s) => { if (id === "job-1") setImmediate(() => { void s().stop(); }); });
    await h.scheduler.runTickNow();
    expect(h.evaluated).toEqual(["job-1"]);
  });
});
