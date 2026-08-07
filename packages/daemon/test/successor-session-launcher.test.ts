import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";

describe("SuccessorSessionLauncher", () => {
  let db: Database.Database;
  let discoveryRepo: DiscoveryRepository;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    discoveryRepo = new DiscoveryRepository(db);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%7", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    // A live successor is launched via the runtime adapter (launchHarness + readiness), not left as a
    // bare shell. Default mock: launches ready with a scraped resume token.
    launchHarness = vi.fn(async () => ({ ok: true, resumeToken: "codex-thread-xyz", resumeType: "codex_id" }));
    checkReady = vi.fn(async () => ({ ready: true }));
  });

  afterEach(() => db.close());

  function fakeAdapter(runtime: string): RuntimeAdapter {
    return { runtime, launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function launcher(tmuxOptionDefaults?: TmuxOptionDefaultsApplier): SuccessorSessionLauncher {
    const tmux = { createSession, listPanes, killSession, respawnPane } as unknown as TmuxAdapter;
    return new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_HOME: "/home", HOME: "/daemon-home", CODEX_HOME: "/daemon-codex" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      sleep: async () => {},
      tmuxOptionDefaults,
    });
  }

  it("CUTOVER: respawns the successor into the DEPARTING pane (preserved name, same pane id) — no fresh session", async () => {
    // A SEAT = one durable tmux session; the successor takes over the retiree's EXACT pane via
    // respawn-pane so native scrollback survives (predecessor history stays above the successor boot).
    // No fresh new-session, no -h shuffle: the canonical session name is preserved and the pane id is
    // unchanged. respawn-pane with no command re-runs the pane's default login shell for launchHarness.
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);

    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // No fresh session — the retiree's pane is reused in place.
    expect(createSession).not.toHaveBeenCalled();
    // The DEPARTING session's pane is resolved (to take it over), then respawned in place.
    expect(listPanes).toHaveBeenCalledWith("dev-impl@rig");
    expect(respawnPane).toHaveBeenCalledTimes(1);
    const [paneTarget, command, opts] = respawnPane.mock.calls[0]!;
    expect(paneTarget).toBe("%42");
    expect(command).toBeUndefined(); // no command → default login shell in the reused pane
    expect(opts).toMatchObject({ cwd: "/w" });
    // Identity env carries the PRESERVED canonical session name (never a -h successor name) + the
    // daemon session env (self-identify + activity report like a launched seat).
    expect(opts.env).toMatchObject({
      OPENRIG_NODE_ID: "node-1",
      OPENRIG_SESSION_NAME: "dev-impl@rig",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_HOME: "/home",
      HOME: "/daemon-home",
      CODEX_HOME: "/daemon-codex",
    });

    // launchHarness drives the harness into the SAME preserved session/pane; readiness ran; the
    // launch resume token is captured + returned (persisted at commit by the composer, never here).
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const [binding, launchOpts] = launchHarness.mock.calls[0]!;
    expect(binding).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", cwd: "/w" });
    expect(launchOpts).toMatchObject({ name: "dev-impl@rig" });
    expect(checkReady).toHaveBeenCalled();
    expect(res.resumeToken).toBe("codex-thread-xyz");
    expect(res.resumeType).toBe("codex_id");
    expect(res.tmuxSession).toBe("dev-impl@rig");
    expect(res.tmuxPane).toBe("%42");
    // Order: resolve departing pane → respawn in place → launch the harness into it.
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(listPanes.mock.invocationCallOrder[0]!);
    expect(launchHarness.mock.invocationCallOrder[0]!).toBeGreaterThan(respawnPane.mock.invocationCallOrder[0]!);

    // Recorded as an ACTIVE, UNMANAGED discovery candidate on the PRESERVED name (commit rebinds to it);
    // no binding/session rows are created here — the commit is the sole rebind.
    const row = discoveryRepo.getDiscoveredSession(res.discoveredId);
    expect(row).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", status: "active", claimedNodeId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("UNWIND INVARIANT: a failed successor launch NEVER kills the retiree's preserved session — it stays re-wakeable from its session file", async () => {
    // The new safety invariant (cutover): the retiree exits in place; its provider session file is the
    // durable wake target. So when the successor's launch/readiness FAILS after the respawn, unwind must
    // NOT killSession the preserved seat (that would destroy the recoverable state) — it returns a
    // structured start_agent failure and leaves the re-wakeable shell in the pane.
    launchHarness.mockResolvedValue({ ok: false, error: "codex binary not found" });

    const res = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_launch_failed" });
    expect((res as { message: string }).message).toContain("codex binary not found");
    // The preserved seat's session is NEVER killed on unwind (retiree state stays recoverable).
    expect(killSession).not.toHaveBeenCalled();
    // No discovery candidate was committed for a failed successor.
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("readiness timeout → structured start_agent failure, preserved seat NOT killed, no candidate", async () => {
    checkReady.mockResolvedValue({ ready: false, reason: "harness not interactive" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_not_ready" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("checkReady THROWS (adapter/socket error) → structured start_agent failure, preserved seat NOT killed, no candidate", async () => {
    // A THROWN readiness probe must not reject createSuccessor with an unstructured error, and — under
    // the cutover invariant — must not kill the preserved seat either.
    checkReady.mockRejectedValue(new Error("tmux socket closed"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_readiness_failed" });
    expect((res as { message: string }).message).toContain("tmux socket closed");
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("readiness reports attention_required (auth/trust gate) → structured failure, preserved seat NOT killed", async () => {
    checkReady.mockResolvedValue({ ready: false, code: "trust_gate", reason: "trust prompt" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_attention_required" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("no runtime adapter for the seat's runtime → structured failure, preserved seat NOT killed", async () => {
    const tmux = { createSession, listPanes, killSession, respawnPane } as unknown as TmuxAdapter;
    const noAdapter = new SuccessorSessionLauncher(tmux, discoveryRepo, { newId: () => "01ABCDEFG", runtimeAdapters: {} });
    const res = await noAdapter.createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_runtime_unsupported" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("respawn-pane failure → structured create_successor failure (no kill, no candidate)", async () => {
    // If the in-place respawn itself fails, there is no successor; return a structured create_successor
    // error and do NOT kill the pane — the seat stays re-wakeable from its session file.
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "no_server" });
    expect((res as { message: string }).message).toContain("no server running");
    expect(launchHarness).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("no resolvable departing pane → structured resolve_pane failure BEFORE any respawn (seat untouched)", async () => {
    listPanes.mockResolvedValue([]);
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_unresolved" });
    // Nothing was respawned/killed — the live retiree is wholly untouched.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("listPanes THROWS → STRUCTURED resolve_pane failure (no rejection), no respawn, seat untouched", async () => {
    listPanes.mockRejectedValue(new Error("socket permission denied"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_probe_failed" });
    expect((res as { message: string }).message).toContain("socket permission denied");
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("cleanup marks the candidate vanished WITHOUT killing the preserved session", async () => {
    // Cutover cleanup unwinds a downstream failure (delivery/verify) — but the successor occupies the
    // retiree's preserved pane, so cleanup must NEVER killSession (that destroys the recoverable seat).
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    if (!res.ok) throw new Error("expected ok");
    await launcher().cleanup(res.tmuxSession, res.discoveredId);
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.getDiscoveredSession(res.discoveredId)?.status).toBe("vanished");
  });
});
