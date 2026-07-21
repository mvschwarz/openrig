// slice-04 /api/ps event-loop stall — daemon regression pins + GREEN characterization.
// The D1/D2 titles carry the word "regression": they were genuine RED at the
// test-only gate and pin the target behavior. The production fix is NOT yet
// committed or shipped — these pins guard the pending candidate.
// qitem-20260721000001-ps-stall-driver. Host-shaped SYNTHETIC only (never the
// copied host DB). CI-rerunnable; reads no external lane marker.
//
// Fail-safety contract: D1/D3 restore spies and close their DB in `finally` even
// when an assertion throws; D2 uses a whole-run watchdog + parent try/finally so
// the spawned child is always TERM/KILL'd and its listener proven closed on every
// path. Regression-pin semantics / N=24 / event vector / 250ms budget are frozen.
import { describe, it, expect, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFullTestDb } from "./helpers/test-app.js";
import { seedHostShaped } from "./helpers/seed-host-shaped.js";
import { buildStallApp } from "./fixtures/ps-stall-http-child.js";
import { HEALTHZ_RESPONSIVENESS_BUDGET_MS } from "../src/domain/event-loop-monitor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const CHILD = path.resolve(HERE, "fixtures/ps-stall-http-child.ts");

// exact SQL signatures (normalized, lowercased) of the two per-node fold scans
const STARTUP_SIG = "type in ('node.startup_challenged','node.startup_proof_verified','node.startup_proof_rejected')";
const RESTORE_SIG = "type in ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled')";

function withPrepareTap(db: any) {
  const seen: string[] = [];
  const real = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    seen.push(String(sql).replace(/\s+/g, " ").trim().toLowerCase());
    return real(sql);
  }) as never);
  return { seen, restore: () => spy.mockRestore() };
}
const countHas = (seen: string[], frag: string) => seen.filter((s) => s.includes(frag)).length;

function waitExit(c: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((res) => {
    if (c.exitCode !== null || c.signalCode !== null) return res(true);
    const to = setTimeout(() => res(false), ms);
    c.once("exit", () => { clearTimeout(to); res(true); });
  });
}

// Bounded TCP closure proof: ONLY ECONNREFUSED proves the listener is closed.
// A successful connect, a timeout (indeterminate/not-responding), or any other
// error is NOT closed — a timeout is never classified as absence.
function tcpClosed(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (v: boolean) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(false));                                        // still serving
    sock.once("timeout", () => done(false));                                        // indeterminate, NOT closed
    sock.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED")); // refused => closed
  });
}

describe("slice-04 ps/summary event-loop regression", () => {
  // ---------- D1 (regression pin): split-classifier scan counts ----------
  it("D1 regression: summary performs exactly ONE fleet startup-orientation + ONE restore-outcome scan", async () => {
    const db = createFullTestDb();
    seedHostShaped(db);
    const app = buildStallApp(db);
    const tap = withPrepareTap(db);
    try {
      tap.seen.length = 0;
      const psRes = await app.request("/api/ps");
      expect(psRes.status).toBe(200);
      // /api/ps is already fleet-batched — the GREEN baseline for the two signatures.
      expect(countHas(tap.seen, STARTUP_SIG)).toBe(1);
      expect(countHas(tap.seen, RESTORE_SIG)).toBe(1);

      tap.seen.length = 0;
      const sumRes = await app.request("/api/rigs/summary");
      expect(sumRes.status).toBe(200);
      // Genuine RED at the test-only gate. Pre-fix, /api/rigs/summary re-scanned per
      // active rig (10 startup + 10 restore); the target fix must batch both to
      // exactly ONE fleet scan each — this pin asserts 1 + 1.
      expect(countHas(tap.seen, STARTUP_SIG)).toBe(1);
      expect(countHas(tap.seen, RESTORE_SIG)).toBe(1);
    } finally {
      tap.restore();
      db.close();
    }
  }, 60_000);

  // ---------- D3 (GREEN): membership/fields/freshness + fail-loud pin ----------
  it("D3 GREEN: archive membership + fields + request-boundary freshness + existing 500", async () => {
    const db = createFullTestDb();
    const shape = seedHostShaped(db);
    const app = buildStallApp(db);
    let spy: { mockRestore: () => void } | null = null;
    try {
      const def = (await (await app.request("/api/ps")).json()) as unknown[];
      expect(def).toHaveLength(10); // default excludes archived (active 10/75)
      const incl = (await (await app.request("/api/ps?includeArchived=true")).json()) as unknown[];
      expect(incl).toHaveLength(27);
      const arch = (await (await app.request("/api/ps?archived=only")).json()) as unknown[];
      expect(arch).toHaveLength(17);
      for (const f of ["status", "nodeCount", "runningCount"]) expect(def[0]).toHaveProperty(f);

      // slice-04 (guard Correction 1): pin /api/rigs/summary membership + lifecycleState
      // too — same archive contract as /api/ps (previously only /api/ps was pinned),
      // so the scoped-fold fix cannot silently change which rigs summary returns.
      const sumDef = (await (await app.request("/api/rigs/summary")).json()) as unknown[];
      expect(sumDef).toHaveLength(10);
      const sumIncl = (await (await app.request("/api/rigs/summary?includeArchived=true")).json()) as unknown[];
      expect(sumIncl).toHaveLength(27);
      const sumArch = (await (await app.request("/api/rigs/summary?archived=only")).json()) as unknown[];
      expect(sumArch).toHaveLength(17);
      expect(sumDef[0]).toHaveProperty("lifecycleState");

      // request-boundary freshness: a mutation between two polls is reflected (no stale snapshot)
      db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run("2026-07-06 00:00:00", shape.activeRigIds[0]);
      const def2 = (await (await app.request("/api/ps")).json()) as unknown[];
      expect(def2).toHaveLength(9);

      // fail-loud: a deterministic prepare throw at the ps boundary returns the EXISTING 500,
      // no partial/stale payload published; a subsequent call recovers fully.
      const real = db.prepare.bind(db);
      spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (String(sql).includes("running_count")) throw new Error("injected ps-boundary failure");
        return real(sql);
      }) as never);
      const failRes = await app.request("/api/ps");
      expect(failRes.status).toBe(500);
      const body = await failRes.text();
      expect(body).not.toContain("runningCount"); // no partial ps payload
      spy.mockRestore();
      spy = null;
      const rec = (await (await app.request("/api/ps")).json()) as unknown[];
      expect(rec).toHaveLength(9); // no cached partial; full correct response
    } finally {
      if (spy) spy.mockRestore();
      db.close();
    }
  }, 60_000);

  // ---------- D2 (regression pin): real localhost N=24 burst health budget ----------
  it("D2 regression: N=24 real-HTTP ps+summary burst keeps worst /healthz < budget", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_HOME", "OPENRIG_HOST", "OPENRIG_DB",
      "RIGGED_URL", "RIGGED_PORT", "RIGGED_HOME", "RIGGED_HOST", "RIGGED_DB"]) delete env[k];

    const CAP = 64 * 1024;
    let out = "", err = "", outTrunc = false, errTrunc = false;
    let child: ChildProcess | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let watchdogKill: ReturnType<typeof setTimeout> | null = null;
    let probe: Promise<void> | null = null;
    let stop = false;
    const probeAbort = new AbortController(); // owns the health-probe fetches
    let base = "";
    let port = 0;
    let readyStatus = 0;
    const psStatuses: number[] = [];
    const sumStatuses: number[] = [];
    const health: { ms: number; status: number }[] = [];
    let pidGone = false;
    let portClosed = false;

    try {
      child = spawn(process.execPath, ["--import", "tsx", CHILD], {
        cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"],
      });
      // whole-run watchdog: force-terminate the child if the run overruns 45s.
      watchdog = setTimeout(() => {
        try { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } catch { /* noop */ }
        // TRACKED escalation timer; re-checks liveness before KILL so it can never
        // signal a stale/OS-reused PID after the child already exited.
        watchdogKill = setTimeout(() => {
          try { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* noop */ }
        }, 3_000);
      }, 45_000);

      child.stdout!.on("data", (d) => {
        if (out.length < CAP) out += String(d);
        if (out.length >= CAP && !outTrunc) { out = out.slice(0, CAP) + "\n…[stdout truncated]"; outTrunc = true; }
      });
      child.stderr!.on("data", (d) => {
        if (err.length < CAP) err += String(d);
        if (err.length >= CAP && !errTrunc) { err = err.slice(0, CAP) + "\n…[stderr truncated]"; errTrunc = true; }
      });

      port = await new Promise<number>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("no READY within 40s; stderr=" + err)), 40_000);
        child!.stdout!.on("data", () => {
          const m = out.match(/READY (\d+)/);
          if (m) { clearTimeout(to); resolve(Number(m[1])); }
        });
        child!.on("exit", (code) => { clearTimeout(to); reject(new Error(`child exited ${code} before READY; stderr=${err}`)); });
      });
      base = `http://127.0.0.1:${port}`;

      // post-READY proof BEFORE the burst: child still alive + listener/diagnostic-health 200.
      expect(port).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull();
      const readyHealth = await fetch(base + "/healthz");
      readyStatus = readyHealth.status;
      await readyHealth.text();
      expect(readyStatus).toBe(200);

      // one sequential paced health-probe loop, awaited after the burst
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      probe = (async () => {
        while (!stop) {
          const t = performance.now();
          let status = 0;
          try { const r = await fetch(base + "/healthz", { signal: probeAbort.signal }); status = r.status; await r.text().catch(() => {}); }
          catch { status = 0; }
          health.push({ ms: +(performance.now() - t).toFixed(1), status });
          if (!stop) await sleep(100);
        }
      })();

      const reqs: Promise<unknown>[] = [];
      for (let i = 0; i < 24; i++) {
        reqs.push(fetch(base + "/api/ps").then((r) => { psStatuses.push(r.status); return r.text(); }));
        reqs.push(fetch(base + "/api/rigs/summary").then((r) => { sumStatuses.push(r.status); return r.text(); }));
      }
      await Promise.all(reqs);
      stop = true;
      await probe;
      probe = null;
    } finally {
      // Stop + ABORT the probe first so its in-flight fetch cannot stall the drain.
      stop = true;
      probeAbort.abort();
      try {
        // Terminate + await the child BEFORE draining the probe, with the whole-run
        // watchdog STILL ARMED (timers are cleared only in the nested finally below,
        // after the child has exited) — so a stall here can never leak the child.
        if (child) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const exited = await waitExit(child, 5_000);
            if (!exited) { child.kill("SIGKILL"); await waitExit(child, 5_000); }
          }
          pidGone = child.exitCode !== null || child.signalCode !== null;
          // Only ECONNREFUSED proves closed; timeout/other => not closed.
          portClosed = port > 0 ? await tcpClosed("127.0.0.1", port, 2_000) : false;
        }
        // Drain the now-aborted probe (its fetch carries probeAbort.signal, so it settles).
        if (probe) await probe.catch(() => {});
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (watchdogKill) clearTimeout(watchdogKill);
      }
    }

    // Teardown is guaranteed done above; now assert (the budget pin is the LAST assertion).
    expect(psStatuses).toHaveLength(24);
    expect(psStatuses.every((s) => s === 200)).toBe(true);
    expect(sumStatuses).toHaveLength(24);
    expect(sumStatuses.every((s) => s === 200)).toBe(true);
    expect(health.length).toBeGreaterThan(0);
    expect(health.every((h) => h.status === 200)).toBe(true);
    expect(pidGone).toBe(true);
    expect(portClosed).toBe(true);

    const worst = Math.max(0, ...health.map((h) => h.ms));
    // Genuine RED at the test-only gate. Under N=24 the synchronous ps/summary folds
    // starve the loop so worst /healthz exceeds the shipped 250ms responsiveness
    // budget; this pin asserts the target fix keeps it under (the acceptance test).
    expect(worst).toBeLessThan(HEALTHZ_RESPONSIVENESS_BUDGET_MS);
  }, 60_000);
});
