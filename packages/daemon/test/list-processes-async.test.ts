// B12-T — the DISCRIMINATING test for the B12 async conversion (anti-vacuity).
//
// Every other suite injects SYNC listProcesses stubs, so nothing exercised
// runAsyncSite/defaultListProcesses: the conversion was green-by-vacuity. This test drives the
// REAL default at both sampling sites (a real `ps` invocation) and asserts the exact property the
// pre-B12 implementation violated: invoking the sampler must hand control back to the event loop
// immediately instead of blocking for the whole spawn. The old code ran ps via execSync inside the
// async body, so the CALL ITSELF stalled for the full ps duration (measured ~100-220ms on this
// class of box) and every HTTP request queued behind it. The discriminator is an ORDERING
// property, not a wall-clock bound — the inline note records why a bound was tried and dropped.
// Door test: revert the async wrap locally and this fails; on the candidate it passes.

import { describe, it, expect } from "vitest";
import { defaultListProcesses as refresherListProcesses } from "../src/domain/resume-metadata-refresher.js";
import { defaultListProcesses as codexListProcesses } from "../src/adapters/codex-runtime-adapter.js";

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
    // so a wall-clock bound is environment-hostage. The deterministic discriminator is ORDER: the
    // pre-B12 execSync implementation finished ps inside the call, so its promise settles on the
    // first microtask — ahead of any timer — and `turnedBeforeResolve` reads false there, always.
    const pending = listProcesses();

    // While ps runs, the loop must turn: a 0ms timer armed AFTER the call must fire BEFORE the
    // (much slower) spawn resolves.
    let loopTurnedFirst = false;
    setTimeout(() => { loopTurnedFirst = true; }, 0);
    const { rows, turnedBeforeResolve } = await pending.then((r) => ({ rows: r, turnedBeforeResolve: loopTurnedFirst }));

    expect(rows.length).toBeGreaterThan(0); // the non-blocking return was not an empty-result shortcut
    expect(turnedBeforeResolve).toBe(true);
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
    const { home, turnedBeforeResolve } = await withChild(async (pid) => {
      const pending = defaultResolveHomeDirByPid(pid);
      let loopTurnedFirst = false;
      setTimeout(() => { loopTurnedFirst = true; }, 0);
      return Promise.resolve(pending).then((h) => ({ home: h, turnedBeforeResolve: loopTurnedFirst }));
    });
    expect(home).toBe("/tmp/f1-probe-home"); // the fast return was not an empty shortcut
    expect(turnedBeforeResolve).toBe(true);
  });
});
