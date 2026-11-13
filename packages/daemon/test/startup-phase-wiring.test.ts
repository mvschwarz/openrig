import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";

// The package setup gives startup fixture homes and stub runtimes. Nothing binds
// a port, starts a managed seat, or reaches the owner's daemon here.
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("completed startup phase observations", () => {
  it("records separate migration, reconciliation and managed-plugin intervals at real startup seams", async () => {
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const records: Record<string, unknown>[] = [];
    const daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxExec: async () => "", slowOpRecorder: {
      recordDiagnostic: record => { records.push(record); return true; },
    } });
    try {
      const phases = records.filter(record => record.schema === "openrig.startup-phase/v1");
      expect(phases.map(record => record.phase)).toEqual(["migrations", "reconciliation", "managed_plugins"]);
      for (const record of phases) {
        expect(record.pid).toBe(process.pid);
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
        expect(record.toElapsedMs).toBeGreaterThanOrEqual(record.fromElapsedMs as number);
        expect(record.durationMs).toBeCloseTo((record.toElapsedMs as number) - (record.fromElapsedMs as number));
        expect(Date.parse(record.fromUtc as string)).toBeLessThanOrEqual(Date.parse(record.toUtc as string));
        expect(Object.keys(record).sort()).toEqual(["schema", "phase", "pid", "fromUtc", "toUtc", "fromElapsedMs", "toElapsedMs", "durationMs"].sort());
      }
      expect(phases[0]!.toElapsedMs).toBeLessThanOrEqual(phases[1]!.fromElapsedMs as number);
      expect(phases[1]!.toElapsedMs).toBeLessThanOrEqual(phases[2]!.fromElapsedMs as number);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });
});
