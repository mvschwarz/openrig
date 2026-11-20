import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginStartupPhase, recordStartupPhase } from "../src/domain/startup-phase-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("startup interval recording", () => {
  it("keeps the migration boundary when submission waits for recorder initialization", () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const finish = beginStartupPhase("migrations");
    now = 35;
    const record = finish();
    now = 1000; // unrelated recorder setup must not inflate the migration interval
    const sink = vi.fn(() => true);
    recordStartupPhase({ recordDiagnostic: sink }, record);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ phase: "migrations", fromElapsedMs: 10, toElapsedMs: 35, durationMs: 25 }));
  });

  it("does not wait on a sink acknowledgement, and tolerates a dropped, absent or throwing sink", () => {
    const record = beginStartupPhase("reconciliation")();
    const sink = vi.fn(() => false);
    expect(recordStartupPhase({ recordDiagnostic: sink }, record)).toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(() => recordStartupPhase(undefined, record)).not.toThrow();
    expect(() => recordStartupPhase({ recordDiagnostic: () => { throw new Error("sink unavailable"); } }, record)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(1024);
  });

  it("ends bind timing at the actual listening callback, not when serve returns", async () => {
    const records: Record<string, unknown>[] = [];
    const sink = { recordDiagnostic: (record: Record<string, unknown>) => { records.push(record); return true; } };
    const finish = beginStartupPhase("bind", "primary");
    let onListening!: () => void;
    const listening = new Promise<void>(resolve => { onListening = resolve; });
    const server = serve({ fetch: () => new Response("ready"), hostname: "127.0.0.1", port: 0 }, () => {
      recordStartupPhase(sink, finish());
      onListening();
    });
    try {
      expect(records).toHaveLength(0);
      await listening;
      expect(records).toEqual([expect.objectContaining({ schema: "openrig.startup-phase/v1", phase: "bind", listener: "primary", pid: process.pid })]);
      expect(records[0]!.toElapsedMs).toBeGreaterThanOrEqual(records[0]!.fromElapsedMs as number);
      expect(Object.keys(records[0]!).sort()).toEqual(["schema", "phase", "pid", "fromUtc", "toUtc", "fromElapsedMs", "toElapsedMs", "durationMs", "listener"].sort());
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("keeps both ordinary and guest bind observations inside the production listening callbacks", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const endBind = beginStartupPhase\("bind",[\s\S]*?const srv = serve\([^;]*?\(info\) => \{\s*recordStartupPhase\(deps.slowOpRecorder, endBind\(\)\)/);
    expect(source).toMatch(/const endGuestBind = beginStartupPhase\("bind", "guest"\)[\s\S]*?const guestServer = serve\([^;]*?\(\) => \{\s*recordStartupPhase\(deps.slowOpRecorder, endGuestBind\(\)\)/);
  });
});
