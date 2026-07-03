import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("SuccessorSessionLauncher", () => {
  let db: Database.Database;
  let discoveryRepo: DiscoveryRepository;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    discoveryRepo = new DiscoveryRepository(db);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%7", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    // B1 — a live successor is launched via the runtime adapter (launchHarness +
    // readiness), not left as a bare shell. Default mock: launches ready with a
    // scraped resume token.
    launchHarness = vi.fn(async () => ({ ok: true, resumeToken: "codex-thread-xyz", resumeType: "codex_id" }));
    checkReady = vi.fn(async () => ({ ready: true }));
  });

  afterEach(() => db.close());

  function fakeAdapter(runtime: string): RuntimeAdapter {
    return { runtime, launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function launcher(): SuccessorSessionLauncher {
    const tmux = { createSession, listPanes, killSession } as unknown as TmuxAdapter;
    return new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_HOME: "/home" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  it("creates an UNMANAGED session (name,cwd,env) then resolves pane before upsert", async () => {
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Driver note 1: actual adapter signature createSession(name, cwd, env).
    const [name, cwd, env] = createSession.mock.calls[0]!;
    expect(name).toBe("dev-impl@rig-h1ABCDEFG");
    expect(cwd).toBe("/w");
    expect(env).toMatchObject({ OPENRIG_NODE_ID: "node-1", OPENRIG_SESSION_NAME: "dev-impl@rig-h1ABCDEFG", OPENRIG_RUNTIME: "codex", OPENRIG_HOME: "/home" });

    // Driver note 2: pane resolved after create, carried into the discovery candidate.
    expect(listPanes.mock.invocationCallOrder[0]!).toBeGreaterThan(createSession.mock.invocationCallOrder[0]!);
    expect(res.tmuxPane).toBe("%7");

    // B1: the successor was launched into a LIVE, READY agent BEFORE the upsert —
    // launchHarness + a readiness probe ran, and the launch resume token is
    // captured and returned (persisted at commit by the composer, never here).
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const [binding, launchOpts] = launchHarness.mock.calls[0]!;
    expect(binding).toMatchObject({ tmuxSession: "dev-impl@rig-h1ABCDEFG", tmuxPane: "%7", cwd: "/w" });
    expect(launchOpts).toMatchObject({ name: "dev-impl@rig-h1ABCDEFG" });
    expect(checkReady).toHaveBeenCalled();
    expect(res.resumeToken).toBe("codex-thread-xyz");
    expect(res.resumeType).toBe("codex_id");
    // launch happened AFTER pane resolve and BEFORE the discovery upsert.
    expect(launchHarness.mock.invocationCallOrder[0]!).toBeGreaterThan(listPanes.mock.invocationCallOrder[0]!);

    // Recorded as an ACTIVE, UNMANAGED discovery candidate (no binding/session created).
    const row = discoveryRepo.getDiscoveredSession(res.discoveredId);
    expect(row).toMatchObject({ tmuxSession: "dev-impl@rig-h1ABCDEFG", tmuxPane: "%7", status: "active", claimedNodeId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("B1: unwinds (kills the session, no candidate) when harness launch fails — no dead-shell successor", async () => {
    launchHarness.mockResolvedValue({ ok: false, error: "codex binary not found" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_launch_failed" });
    expect((res as { message: string }).message).toContain("codex binary not found");
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("B1: unwinds when the successor never becomes ready (readiness timeout) — no dead-shell successor", async () => {
    checkReady.mockResolvedValue({ ready: false, reason: "harness not interactive" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_not_ready" });
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("B1 code-review fix: unwinds when checkReady THROWS (adapter/socket error) — no leaked session, no candidate, structured start_agent failure", async () => {
    // A THROWN readiness probe (not a returned {ready:false}) must NOT reject
    // createSuccessor before its kill/unwind runs — otherwise the just-created
    // unmanaged successor leaks and the caller sees an unstructured 500.
    checkReady.mockRejectedValue(new Error("tmux socket closed"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_readiness_failed" });
    expect((res as { message: string }).message).toContain("tmux socket closed");
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG"); // session killed → no leak
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);    // no discovery candidate created
  });

  it("B1: unwinds when readiness reports attention_required (auth/trust gate)", async () => {
    checkReady.mockResolvedValue({ ready: false, code: "trust_gate", reason: "trust prompt" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_attention_required" });
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("B1: unwinds when no runtime adapter exists for the seat's runtime", async () => {
    const tmux = { createSession, listPanes, killSession } as unknown as TmuxAdapter;
    const noAdapter = new SuccessorSessionLauncher(tmux, discoveryRepo, { newId: () => "01ABCDEFG", runtimeAdapters: {} });
    const res = await noAdapter.createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_runtime_unsupported" });
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("propagates a duplicate-session create failure without killing the pre-existing session", async () => {
    createSession.mockResolvedValue({ ok: false, code: "duplicate_session", message: "dup" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("best-effort kills the generated successor name when create fails after partial tmux side effects", async () => {
    createSession.mockResolvedValue({ ok: false, code: "unknown", message: "hook failed after create" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "unknown" });
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("kills the session and yields resolve_pane when no pane is resolvable", async () => {
    listPanes.mockResolvedValue([]);
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane" });
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("kills the session and yields a STRUCTURED resolve_pane failure when listPanes THROWS (no orphan, no rejection)", async () => {
    // A probe that rethrows (permission/socket) must not escape uncaught and
    // must not leave the just-created successor unmanaged.
    listPanes.mockRejectedValue(new Error("socket permission denied"));

    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });

    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_probe_failed" });
    expect((res as { message: string }).message).toContain("socket permission denied");
    // The just-created successor is killed; no discovery candidate leaked.
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("cleanup kills the session and marks the candidate vanished", async () => {
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    if (!res.ok) throw new Error("expected ok");
    await launcher().cleanup(res.tmuxSession, res.discoveredId);
    expect(killSession).toHaveBeenCalledWith("a@r-h1ABCDEFG");
    expect(discoveryRepo.getDiscoveredSession(res.discoveredId)?.status).toBe("vanished");
  });
});
