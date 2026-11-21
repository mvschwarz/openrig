// daemon.identity_poll_interval_ms (OPENRIG_IDENTITY_POLL_INTERVAL_MS): the cadence of the seat identity reconciler.
// On a large fleet its fixed 5 s sweep (tmux pane reads for every running seat, process-table reads for some) had no
// knob to trade identity freshness for that load. The default is unchanged; the setting only slows the reconciler
// down, up to a cap on the cadence of sweep attempts (not a freshness deadline; see the MAX_IDENTITY_POLL_INTERVAL_MS
// comment in seat-identity-reconciler.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IDENTITY_POLL_INTERVAL_MS, IDENTITY_POLL_INTERVAL_KEY, MAX_IDENTITY_POLL_INTERVAL_MS,
  MIN_IDENTITY_POLL_INTERVAL_MS, SeatIdentityReconciler, resolveIdentityPollIntervalMs, startIdentityReconciler,
} from "../src/domain/seat-identity-reconciler.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixed = (value: unknown, source = "file") => () => ({ value, source });

describe("resolveIdentityPollIntervalMs (the typed setting daemon.identity_poll_interval_ms)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("takes a whole number of milliseconds in 5000..30000, without a warning", () => {
    const warn = vi.fn();
    for (const v of [5000, 15000, 30000]) expect(resolveIdentityPollIntervalMs(fixed(v), warn)).toBe(v);
    expect(warn).not.toHaveBeenCalled();
    expect([MIN_IDENTITY_POLL_INTERVAL_MS, MAX_IDENTITY_POLL_INTERVAL_MS]).toEqual([5000, 30000]);
  });

  it("keeps the default, with a warning, for a value the store could not check (outside 5000..30000 or not a number)", () => {
    for (const v of [4999, 30001, 0, 1000, 7500.5, "abc", null]) {
      const warn = vi.fn();
      expect(resolveIdentityPollIntervalMs(fixed(v), warn)).toBe(DEFAULT_IDENTITY_POLL_INTERVAL_MS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`using ${DEFAULT_IDENTITY_POLL_INTERVAL_MS} ms`);
    }
  });

  it("keeps the default, with a warning, when the setting cannot be read", () => {
    const warn = vi.fn();
    expect(resolveIdentityPollIntervalMs(() => { throw new Error("bad config.json"); }, warn)).toBe(DEFAULT_IDENTITY_POLL_INTERVAL_MS);
    expect(warn.mock.calls[0][0]).toContain("bad config.json");
  });

  it("reads the real store: config.json, then OPENRIG_IDENTITY_POLL_INTERVAL_MS over it; an env value out of range is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-poll-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, JSON.stringify({ daemon: { identityPollIntervalMs: 10000 } }));
      const store = new SettingsStore(cfg);
      const read = () => store.resolveOne(IDENTITY_POLL_INTERVAL_KEY as never);
      vi.stubEnv("OPENRIG_IDENTITY_POLL_INTERVAL_MS", "");
      expect(read()).toMatchObject({ value: 10000, source: "file" });
      expect(resolveIdentityPollIntervalMs(read)).toBe(10000);
      vi.stubEnv("OPENRIG_IDENTITY_POLL_INTERVAL_MS", "20000");
      expect(read()).toMatchObject({ value: 20000, source: "env" });
      expect(resolveIdentityPollIntervalMs(read)).toBe(20000);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.stubEnv("OPENRIG_IDENTITY_POLL_INTERVAL_MS", "1000");
      expect(read()).toMatchObject({ value: 10000, source: "file" });  // the bad env is dropped, with a warning
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("daemon.identity_poll_interval_ms");
      stderr.mockRestore();
      expect(() => store.set(IDENTITY_POLL_INTERVAL_KEY as never, "30001")).toThrow(/\[5000, 30000\]/);
      expect(() => store.set(IDENTITY_POLL_INTERVAL_KEY as never, "4999")).toThrow(/\[5000, 30000\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startIdentityReconciler: the reconciler runs at the configured cadence", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const sweepsPerMinute = (read: () => { value: unknown; source?: string }): { ms: number; sweeps: number } => {
    const rec = Object.create(SeatIdentityReconciler.prototype) as SeatIdentityReconciler;
    let sweeps = 0;
    (rec as unknown as { reconcileAll: () => Promise<void> }).reconcileAll = async () => { sweeps++; };
    const ms = startIdentityReconciler(rec, read, vi.fn());
    vi.advanceTimersByTime(60_000);
    rec.stop();
    return { ms, sweeps };
  };

  it("sweeps a third as often at 15000 ms as at the default", () => {
    vi.useFakeTimers();
    expect(sweepsPerMinute(fixed(5000, "default"))).toEqual({ ms: 5000, sweeps: 12 });
    expect(sweepsPerMinute(fixed(15000))).toEqual({ ms: 15000, sweeps: 4 });
  });

  it("with no reconciler, returns the cadence without starting anything", () => {
    expect(startIdentityReconciler(undefined, fixed(15000), vi.fn())).toBe(15000);
  });
});
