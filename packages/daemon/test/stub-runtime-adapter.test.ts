// Slice 51-01 stub-runtime — TEST-ONLY RED for the undisputed mechanical FACT 5 (readiness honesty).
//
// Production is HELD (pre-edit gate). The stub adapter class does not exist yet, so each test
// dynamic-imports `../src/adapters/stub-runtime-adapter.js` INSIDE the test — the file still collects
// (its other siblings, if any, stay green) and each fact reds INDEPENDENTLY at the import. But per Guard
// REV1, the bodies are FULLY EXECUTABLE after the import: a bare `StubRuntimeAdapter` export still fails
// these readiness assertions (it must return ready only for live evidence and not-ready for
// absent/exited/stale evidence). FACT3 (ordered dual-delivery) and FACT4 (pod-aware resumed dispatch)
// live at production altitude in startup-orchestrator.test.ts / restore-orchestrator.test.ts respectively.
//
// The EXACT readiness mechanism (sidecar file vs pane marker vs …) is a revised-packet / first-production
// -RED design point (Guard). These pin only the INTERFACE-LEVEL contract via concrete injected fs/tmux
// evidence: ReadinessResult.ready is true for a live/ready seat and false for absent/exited/stale. The
// injected evidence shape below is provisional-to-design and is finalized when the adapter ships.
//
// FROZEN: encodes NONE of the disputed surface (hook channel / structured usage_limit / compaction /
// script packaging). Readiness only.
import { describe, it, expect, vi } from "vitest";

const STUB_ADAPTER_MODULE = "../src/adapters/stub-runtime-adapter.js";

// Provisional injected-dependency shapes (finalized against the shipped constructor). A live seat: the
// tmux session exists AND a ready marker/state is present. Dead: session gone / exited / stale.
function memFs(files: Record<string, string> = {}) {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" }); },
    exists: (p: string) => p in files,
    writeFile: vi.fn(),
  };
}
function tmuxWith(opts: { hasSession?: boolean; pane?: string }) {
  return {
    hasSession: vi.fn(async () => opts.hasSession ?? false),
    capturePaneContent: vi.fn(async () => opts.pane ?? ""),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  };
}
const binding = { tmuxSession: "dev-impl@test-rig", cwd: "/work" };

describe("StubRuntimeAdapter.checkReady — readiness honesty (RED: adapter absent until production CLEAR)", () => {
  // FACT5a — READY-POSITIVE control: a live seat (session present + ready evidence) reports ready.
  // Without this positive control a permanently-not-ready implementation would pass every negative.
  it("FACT5a: reports READY for a live seat with ready evidence", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean; code?: string }> } }; // RED now: module absent
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: true, pane: "STUB_READY\n" }), fsOps: memFs({ "/work/.openrig/stub/state.json": JSON.stringify({ ready: true }) }) });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "a live/ready stub seat must report ready").toBe(true);
  });

  // FACT5b — ABSENT negative: no session, no state → not ready.
  it("FACT5b: reports NOT ready when the stub seat is absent (no session/state)", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean }> } }; // RED now
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: false }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "an absent stub seat must not report ready").toBe(false);
  });

  // FACT5c — EXITED negative: a recorded exit → not ready.
  it("FACT5c: reports NOT ready when the stub process has exited", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean }> } }; // RED now
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: true }), fsOps: memFs({ "/work/.openrig/stub/state.json": JSON.stringify({ ready: false, exited: { code: 1 } }) }) });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "an exited stub process must not report ready").toBe(false);
  });

  // FACT5d — STALE negative: stale pane bytes with no live evidence must NOT prove current liveness.
  it("FACT5d: reports NOT ready on stale pane bytes without live evidence", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean }> } }; // RED now
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: false, pane: "STUB_READY (stale)\n" }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "stale pane bytes must not prove current liveness").toBe(false);
  });
});
