// B12-T — the DISCRIMINATING test for the B12 async conversion (anti-vacuity).
//
// Every other suite injects SYNC listProcesses stubs, so nothing exercised
// runAsyncSite/defaultListProcesses: the conversion was green-by-vacuity. This test drives the
// REAL default at both sampling sites (a real `ps` invocation) and asserts the exact property the
// pre-B12 implementation violated: invoking the sampler must hand control back to the event loop
// immediately instead of blocking for the whole spawn. The old code ran ps via execSync inside the
// async body, so the CALL ITSELF stalled for the full ps duration (measured ~100-220ms on this
// class of box) and every HTTP request queued behind it. The discriminator is a SETTLEMENT
// property, not a wall-clock bound — the inline note records why a bound was tried and dropped.
// Door test: revert the async wrap locally and this fails; on the candidate it passes.

import { describe, it, expect } from "vitest";
import { defaultListProcesses as refresherListProcesses } from "../src/domain/resume-metadata-refresher.js";
import { defaultListProcesses as codexListProcesses } from "../src/adapters/codex-runtime-adapter.js";

// The discriminator. Drain microtasks only — no timers, no I/O. An async ps sampler cannot settle
// here, because its child-process I/O needs an event-loop turn that no microtask provides. A sampler
// that ran ps synchronously inside the call settles within a few ticks (the pre-B12/F1 shape needs
// about 3). The depth is a bounded assumption, not a proof that nothing can block: a synchronous
// spawn hidden behind more than MICROTASK_DRAIN_TICKS awaits would also read as pending. An earlier
// version raced a 0ms timer against the result instead. Timer order can race: in a local probe, a
// 70ms synchronous stall after spawning a single-PID ps let the result settle before a 0ms timer in
// most trials. A CI failure of that version is consistent with this race (inferred; the CI timing
// was not measured), so timer order is not asserted.
const MICROTASK_DRAIN_TICKS = 20;
async function settlesWithinMicrotasks(pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < MICROTASK_DRAIN_TICKS; i++) await Promise.resolve();
  return settled;
}

const SITES = [
  ["resume-metadata-refresher", refresherListProcesses],
  ["codex-runtime-adapter", codexListProcesses],
] as const;

describe.each(SITES)("B12-T real async list_processes — %s", (_site, listProcesses) => {
  it("runs the REAL ps path and sees this very process in the table", async () => {
    const rows = await listProcesses();
    expect(rows.length).toBeGreaterThan(10);
    const self = rows.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.ppid).toBeGreaterThan(0);
  });

  it("hands control back to the event loop instead of blocking for the spawn (RED on the pre-B12 sync implementation)", async () => {
    // Note on what is NOT asserted: the invocation's synchronous-return time. Measured here, even
    // the async implementation spends 60-80ms in the call under load (child-process spawn setup),
    // so a wall-clock bound is environment-hostage. The pre-B12 execSync implementation finished ps
    // inside the call, so its promise settles within the microtask drain; the async one cannot.
    const pending = listProcesses();
    const settledEarly = await settlesWithinMicrotasks(pending);
    const rows = await pending;

    expect(rows.length).toBeGreaterThan(0); // the non-blocking return was not an empty-result shortcut
    expect(settledEarly).toBe(false);
  });
});

// F1 — resolve_home rides the same discriminator: the per-PID `ps eww` spawn must hand control
// back to the event loop (pre-F1 it ran execFileSync inside the 8-attempt capture loops — measured
// live at 28.9s/15min of burst blocking). Same ordering property as the sites above.
//
// The probe target is a SPAWNED child with a known HOME: `ps eww` cannot read the vitest worker's
// own env on this platform (measured: 21-byte output, no env), so asserting on process.pid is
// environment-hostage; a child we spawn with an explicit env is deterministic.
describe("F1 real async resolve_home — codex-thread-id", () => {
  async function withChild<T>(fn: (pid: number) => Promise<T>): Promise<T> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
      env: { HOME: "/tmp/f1-probe-home", PATH: process.env.PATH ?? "" },
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 100)); // let it exec
      return await fn(child.pid!);
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("runs the REAL ps eww path and resolves a spawned child's HOME from its environment", async () => {
    const { defaultResolveHomeDirByPid } = await import("../src/domain/codex-thread-id.js");
    const home = await withChild((pid) => defaultResolveHomeDirByPid(pid));
    expect(home).toBe("/tmp/f1-probe-home");
  });

  it("hands control back to the event loop instead of blocking for the spawn (RED on the pre-F1 sync implementation)", async () => {
    const { defaultResolveHomeDirByPid } = await import("../src/domain/codex-thread-id.js");
    const { home, settledEarly } = await withChild(async (pid) => {
      const pending = Promise.resolve(defaultResolveHomeDirByPid(pid));
      const settledEarly = await settlesWithinMicrotasks(pending);
      return { home: await pending, settledEarly };
    });
    expect(home).toBe("/tmp/f1-probe-home"); // the fast return was not an empty shortcut
    expect(settledEarly).toBe(false);
  });
});
