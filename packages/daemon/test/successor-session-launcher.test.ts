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
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    discoveryRepo = new DiscoveryRepository(db);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%7", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    // KI-14: default = healthy pane; the respawned pane comes up as a blank shell.
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    // Cutover: default = retiree exits gracefully (dead right after SIGTERM), so no forced fallback.
    isPaneDead = vi.fn(async () => true);
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
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    return new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_HOME: "/home", HOME: "/daemon-home", CODEX_HOME: "/daemon-codex" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      sleep: async () => {},
      exitPollMs: 1,
      exitTimeoutMs: 5,
      tmuxOptionDefaults,
    });
  }

  it("MONEY PROOF (0.5.2-07): the successor's launch binding carries the SPEC-pinned model, not the runtime default", async () => {
    // Boot cheap → hand over → the successor LAUNCH must carry the spec's model. The adapter emits
    // -m/--model from binding.model (51-07 A1); this pins that the handover FEEDS it the spec model.
    // Absent = the founder-designed topology silently drifts from its spec at every handover.
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", model: "gpt-5.4-cheap" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const binding = launchHarness.mock.calls[0]![0] as { model?: string };
    expect(binding.model).toBe("gpt-5.4-cheap");
  });

  it("CUTOVER: terminates the retiree then respawns (no -k) into the DEPARTING pane (preserved name, same pane id)", async () => {
    // A SEAT = one durable tmux session; the successor takes over the retiree's EXACT pane so native
    // scrollback survives. The retiree is terminated IN PLACE first (remain-on-exit → graceful SIGTERM),
    // then respawn-pane WITHOUT -k reuses the dead pane (respawn -k would CLEAR scrollback). No fresh
    // new-session, no -h shuffle: the canonical session name is preserved and the pane id is unchanged.
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

    // Retiree terminated IN PLACE before the respawn: remain-on-exit set, then GRACEFUL SIGTERM; the
    // pane went dead on the first probe, so NO forced KILL. respawn happens only after the pane is dead.
    expect(setRemainOnExit).toHaveBeenCalledWith("%42", true);
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "TERM");
    expect(signalPaneProcess).not.toHaveBeenCalledWith("%42", "KILL");
    expect(setRemainOnExit.mock.invocationCallOrder[0]!).toBeLessThan(signalPaneProcess.mock.invocationCallOrder[0]!);
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(signalPaneProcess.mock.invocationCallOrder[0]!);

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
    // Order: resolve departing pane → terminate → respawn in place → launch the harness into it.
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(listPanes.mock.invocationCallOrder[0]!);
    expect(launchHarness.mock.invocationCallOrder[0]!).toBeGreaterThan(respawnPane.mock.invocationCallOrder[0]!);

    // Recorded as an ACTIVE, UNMANAGED discovery candidate on the PRESERVED name (commit rebinds to it);
    // no binding/session rows are created here — the commit is the sole rebind.
    const row = discoveryRepo.getDiscoveredSession(res.discoveredId);
    expect(row).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", status: "active", claimedNodeId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("carries the supplied generation exactly and never lets ambient session env override it", async () => {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead } as unknown as TmuxAdapter;
    const subject = new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_OCCUPANT_GENERATION: "stale-ambient-generation" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      sleep: async () => {},
      exitPollMs: 1,
      exitTimeoutMs: 5,
    });

    const result = await subject.createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
      occupantGeneration: "reserved-generation",
    });

    expect(result.ok).toBe(true);
    expect(respawnPane.mock.calls[0]![2]!.env.OPENRIG_OCCUPANT_GENERATION).toBe("reserved-generation");
  });

  it("CUTOVER forced fallback: retiree survives graceful SIGTERM → bounded SIGKILL, then respawns", async () => {
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    // The pane stays live through the graceful window; only the forced KILL makes it dead.
    let killed = false;
    signalPaneProcess.mockImplementation(async (_p: string, sig: string) => { if (sig === "KILL") killed = true; return { ok: true }; });
    isPaneDead.mockImplementation(async () => killed);

    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "dev-impl@rig" });

    expect(res.ok).toBe(true);
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "TERM");
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "KILL"); // graceful failed → forced fallback
    expect(respawnPane).toHaveBeenCalledTimes(1); // respawn only after the pane died (post-KILL)
    expect(launchHarness).toHaveBeenCalledTimes(1);
  });

  it("retiree NEVER exits (survives TERM and KILL) → structured retiree_not_terminated, NO respawn (never clobber a live retiree)", async () => {
    isPaneDead.mockResolvedValue(false); // never becomes dead
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "retiree_not_terminated" });
    expect(signalPaneProcess).toHaveBeenCalledWith("%7", "TERM");
    expect(signalPaneProcess).toHaveBeenCalledWith("%7", "KILL");
    // The pane never died → we NEVER respawn (respawn over a live retiree would fail/clobber) and never launch.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("preserves structured tmux failures when process/pane truth cannot prove cutover", async () => {
    setRemainOnExit.mockResolvedValue({ ok: false, code: "option_failed", message: "remain rejected" });
    signalPaneProcess.mockImplementation(async (_pane: string, signal: string) => ({
      ok: false,
      code: "signal_failed",
      message: `${signal} rejected`,
    }));
    isPaneDead.mockResolvedValue(false);

    const result = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "a@r",
    });

    expect(result).toMatchObject({ ok: false, code: "retiree_not_terminated", replacementStarted: false });
    expect((result as { message: string }).message).toContain("remain-on-exit: remain rejected");
    expect((result as { message: string }).message).toContain("TERM: TERM rejected");
    expect((result as { message: string }).message).toContain("KILL: KILL rejected");
  });

  it("marks physical replacement before respawn when remain-on-exit fails but TERM removes the pane", async () => {
    const replacementStarted = vi.fn();
    setRemainOnExit.mockResolvedValue({ ok: false, code: "unknown", message: "option rejected" });
    signalPaneProcess.mockResolvedValue({ ok: true });
    isPaneDead.mockResolvedValue(true); // production adapter: a known-missing pane proves the retiree is gone
    respawnPane.mockResolvedValue({ ok: false, code: "session_not_found", message: "can't find pane" });

    const result = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "a@r",
      onReplacementStarted: replacementStarted,
    });

    expect(result).toMatchObject({ ok: false, replacementStarted: true });
    expect(replacementStarted).toHaveBeenCalledTimes(1);
    expect(replacementStarted.mock.invocationCallOrder[0]!).toBeLessThan(respawnPane.mock.invocationCallOrder[0]!);
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
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead } as unknown as TmuxAdapter;
    const noAdapter = new SuccessorSessionLauncher(tmux, discoveryRepo, { newId: () => "01ABCDEFG", runtimeAdapters: {}, exitPollMs: 1, exitTimeoutMs: 5 });
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

  describe("KI-14 (5.3 wave-1): fresh must produce a VERIFIED blank shell, never the pane's baked-in command", () => {
    // The live defect (2026-08-22 reinstall wave, four Codex seats): tmux `respawn-pane` WITHOUT a
    // command re-runs the pane's CREATION (or last-respawn) command — and adopted/hand-recovered
    // panes carry `codex … resume <old-token>` as that command, so a "fresh" respawn boots the OLD
    // context while every downstream label reports fresh. These mocks model the real tmux
    // semantics: respawn with no command → the pane re-runs its baked-in codex resume (foreground
    // "node", the codex wrapper); respawn with an explicit shell → the pane is that shell.
    let paneStartCommandRerun: string;
    beforeEach(() => {
      paneStartCommandRerun = "node"; // the baked-in `codex … resume <old>` wrapper
      getDefaultShell.mockResolvedValue("/bin/zsh");
      getPaneCommand.mockImplementation(async () => {
        const call = respawnPane.mock.calls[respawnPane.mock.calls.length - 1];
        const explicit = call?.[1] as string | undefined;
        if (explicit && explicit.length > 0) return explicit.split("/").pop() ?? explicit;
        return paneStartCommandRerun; // tmux re-ran the pane's original command
      });
    });

    it("respawns with an EXPLICIT default shell — never `undefined`, which re-runs the pane's creation command", async () => {
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      // The whole defect: `undefined` here delegates the successor's identity to pane history.
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/zsh");
      // And the launch only proceeded because the pane was VERIFIED to be a shell.
      expect(getPaneCommand).toHaveBeenCalled();
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("a pane that still boots a NON-shell after respawn → structured successor_pane_not_blank; launchHarness NEVER runs; seat preserved", async () => {
      // Hostile/poisoned pane: whatever we respawn, the foreground comes up as the old codex wrapper
      // (e.g. tmux default-command poisoning, or a respawn the server ignored). The fresh contract is
      // a VERIFIED blank slate or a LOUD refusal — never a launch into a resumed context that then
      // gets stamped complete.
      getPaneCommand.mockResolvedValue("node");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res).toMatchObject({ ok: false, code: "successor_pane_not_blank", step: "create_successor", replacementStarted: true });
      expect((res as { message: string }).message).toContain("node");
      // The old context must never be driven as if it were the fresh successor.
      expect(launchHarness).not.toHaveBeenCalled();
      // Unwind invariant: never kill the preserved seat; no candidate registered.
      expect(killSession).not.toHaveBeenCalled();
      expect(discoveryRepo.listDiscovered()).toHaveLength(0);
    });

    it("getDefaultShell unavailable → falls back to /bin/sh rather than an undefined respawn", async () => {
      getDefaultShell.mockResolvedValue(null);
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/sh");
    });
  });
});
