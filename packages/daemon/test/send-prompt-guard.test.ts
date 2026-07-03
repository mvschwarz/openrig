// OPR.0.4.1.10 — rig send interactive-prompt / permission-block guard: KEYSTONE regression.
// Reproduces the 2026-06-20 footgun (a peer rig-send submitted an open AskUserQuestion default and
// shipped a release) and proves it is impossible by default. K-1..K-6 from the impl-prd plus the
// guard-required amendment tests (audit all-or-nothing, danger+wait rejection, send-readiness
// freshness fallback). Detector covered on BOTH the fresh-runtime-hook path and the capture-pane
// fallback (Codex's sole prompt guard — exact render from qa-codex-approval-render-research-20260627).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

// The open ship-authorizing AskUserQuestion from the 2026-06-20 incident (highlighted default first).
const SHIP_PROMPT = [
  "Authorize the 0.4.0 release?",
  "",
  "❯ 1. Authorize publish → @latest (Recommended)",
  "  2. Roll back",
  "  3. Hold",
].join("\n");

// Exact Codex v0.139.0 command-approval render (qa research). Codex does NOT emit a needs_input hook,
// so the capture-pane fallback is its only guard.
const CODEX_APPROVAL = [
  "  Would you like to run the following command?",
  "",
  "  Reason: Do you want to allow running exactly `touch /tmp/x`?",
  "",
  "  $ touch /tmp/x",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
  } as unknown as TmuxAdapter;
}

describe("OPR.0.4.1.10 rig send prompt/permission guard (keystone)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;
  let rigId: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    const rig = rigRepo.createRig("my-rig");
    rigId = rig.id;
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
  });

  // Seed a Codex seat (Codex emits no needs_input Notification — its guard is the PermissionRequest
  // hook (hook-primary) + the capture-pane fallback).
  function seedCodexSeat(name = "dev-qa@my-rig") {
    const node = rigRepo.addNode(rigId, "dev.qa", { role: "worker", runtime: "codex" });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    return name;
  }
  afterEach(() => db.close());

  function makeTransport(tmux: TmuxAdapter, opts?: { withBus?: boolean; now?: () => Date }) {
    return new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore,
      ...(opts?.withBus === false ? {} : { eventBus }),
      ...(opts?.now ? { now: opts.now } : {}),
    });
  }

  function spies() {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    return { sendText, sendKeys };
  }

  function overrideEvents(): Array<Record<string, unknown>> {
    const rows = db.prepare("SELECT payload FROM events WHERE type = 'transport.prompt_override' ORDER BY seq").all() as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  }

  // K-1: default send to a pane at an interactive prompt → refused, nothing typed/submitted.
  it("K-1: default send to an AskUserQuestion refuses (target_needs_input) and never types or submits", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "STAND DOWN, do not ship");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(r.activity?.state).toBe("needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // K-1 via fresh runtime hook (Claude permission_prompt) — primary detector path.
  it("K-1(hook): default send refuses on a fresh permission_prompt hook, no type/submit", async () => {
    agentActivityStore.recordHookEvent({ runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "Notification", subtype: "permission_prompt" });
    const { sendText, sendKeys } = spies();
    // Pane looks idle, but the fresh hook is authoritative → still refuses.
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on", sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(r.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendText).not.toHaveBeenCalled();
  });

  // K-3 (footgun separation): --force does NOT bypass the prompt guard.
  it("K-3: --force to an interactive prompt is STILL refused (force does not bypass the prompt guard)", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "STAND DOWN", { force: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // K-4: only --dangerously-interact --reason drives the prompt, and it writes the audit record.
  it("K-4: --dangerously-interact --reason drives the prompt AND writes a transport.prompt_override audit", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "1", {
      dangerouslyInteract: true, reason: "unblock stuck release prompt", actorSession: "orch-lead@my-rig",
    });
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith("dev-impl@my-rig", "1");
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@my-rig", ["C-m"]);
    const events = overrideEvents();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "transport.prompt_override",
      sessionName: "dev-impl@my-rig",
      actorSession: "orch-lead@my-rig",
      detectedState: "needs_input",
      overrideReason: "unblock stuck release prompt",
    });
    // overrideReason (caller) is distinct from detectedReason (classifier) — not overloaded.
    expect(typeof events[0]!.detectedReason).toBe("string");
    expect(events[0]!.detectedReason).not.toBe(events[0]!.overrideReason);
  });

  // K-5: Codex approval prompt via the capture-pane fallback (Codex has no needs_input hook).
  it("K-5: a Codex command-approval render is detected via the capture-pane fallback and blocks default/force", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => CODEX_APPROVAL, sendText }));
    const def = await t.send("dev-impl@my-rig", "hi");
    expect(def.ok).toBe(false);
    expect(def.reason).toBe("target_needs_input");
    expect(def.activity?.evidenceSource).toBe("pane_heuristic");
    const forced = await t.send("dev-impl@my-rig", "hi", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  // K-5 HOOK-PRIMARY (founder expansion): a fresh Codex PermissionRequest hook is the PRIMARY signal —
  // it blocks default/raw/force even when the pane looks idle (a high-stakes guard must not depend on
  // screen-scraping). Only --dangerously-interact --reason drives it (+ audit).
  it("K-5(hook): a Codex PermissionRequest hook is HOOK-PRIMARY — default/raw/force refused, only --dangerously-interact drives + audits", async () => {
    const seat = seedCodexSeat();
    agentActivityStore.recordHookEvent({ runtime: "codex", sessionName: seat, hookEvent: "PermissionRequest", subtype: "Bash" });
    const { sendText, sendKeys } = spies();
    // Pane looks idle, but the fresh hook is authoritative.
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "› ready\n\n  gpt-5.5 xhigh fast · Context [████ ] · ~/code", sendText, sendKeys }));

    const def = await t.send(seat, "hi");
    expect(def.ok).toBe(false);
    expect(def.reason).toBe("target_needs_input");
    expect(def.activity?.evidenceSource).toBe("runtime_hook"); // HOOK-PRIMARY, not screen-scrape
    expect(def.activity?.reason).toBe("permission_request");

    const raw = await t.send(seat, "/compact", {});
    expect(raw.ok).toBe(false);
    expect(raw.reason).toBe("target_needs_input");

    const forced = await t.send(seat, "hi", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();

    const drive = await t.send(seat, "1", { dangerouslyInteract: true, reason: "approve the blocked command", actorSession: "orch-lead@my-rig" });
    expect(drive.ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(seat, "1");
    const ev = overrideEvents();
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ detectedState: "needs_input", detectedReason: "permission_request", overrideReason: "approve the blocked command" });
  });

  // BOTH PATHS: when the hook is ABSENT (or stale), the capture-pane fallback still catches a Codex
  // approval render — so the guard holds via EITHER path.
  it("K-5(both-paths): with NO hook, a Codex approval render is still caught by the capture-pane fallback", async () => {
    const seat = seedCodexSeat("dev-qa2@my-rig");
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => CODEX_APPROVAL, sendText }));
    const def = await t.send(seat, "hi");
    expect(def.ok).toBe(false);
    expect(def.reason).toBe("target_needs_input");
    expect(def.activity?.evidenceSource).toBe("pane_heuristic"); // fell back to the scan
    expect(sendText).not.toHaveBeenCalled();
  });

  // K-6 (the headline): a stand-down peer message to a ship-authorizing prompt cannot ship the release.
  it("K-6: a stand-down message to a ship-authorizing AskUserQuestion does NOT submit it", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("advisor@my-rig".replace("advisor@my-rig", "dev-impl@my-rig"), "STAND DOWN, brief-gated, do not ship");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    // The release-authorizing default was NEVER selected/submitted.
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // Amendment 1: audit all-or-nothing — no eventBus → dangerous override refuses without sending.
  it("AMEND: --dangerously-interact with no audit sink refuses (prompt_override_audit_unavailable), no send", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }), { withBus: false });
    const r = await t.send("dev-impl@my-rig", "1", { dangerouslyInteract: true, reason: "x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("prompt_override_audit_unavailable");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // Amendment: --dangerously-interact without a reason refuses (domain belt; route/CLI also reject).
  it("AMEND: --dangerously-interact without --reason refuses, no send", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText }));
    const r = await t.send("dev-impl@my-rig", "1", { dangerouslyInteract: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("dangerously_interact_requires_reason");
    expect(sendText).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.28 Part A — REVERSES the pre-slice-28 behavior: a stale-but-latest
  // `idle` hook (display-fresh <5min, but >15s send window) is now SENDABLE. The
  // latest-by-seq idle proves no newer activity exists (had the seat started
  // work, the newest hook would be UserPromptSubmit/PermissionRequest, not idle),
  // so the send trusts the hook ordering over the flaky real-time pane that Codex
  // cannot reliably parse (the original no_activity_signal regression). Ratified:
  // IMPL-SPEC §2.1 + orch-advisor checkpoint 4 (residual hook-didn't-fire risk is
  // bounded/recoverable — a text paste to a working seat, not prompt-driving —
  // and Part B makes the hook reliable). Fresh non-idle hooks + fresh
  // PermissionRequest still block (K-5 tests :178-237, unchanged).
  function seedStaleIdleHook(fixedNow: Date) {
    // Hook says idle, recorded 90s ago: display-fresh (<5min) but send-stale (>15s).
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "Stop",
      occurredAt: new Date(fixedNow.getTime() - 90_000).toISOString(),
    });
  }

  it("Part A: a send-stale IDLE hook + a CLEAN pane sends (the unblock)", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "idle\n❯ ", sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalled();
  });

  it("Part A: a send-stale IDLE hook + an UNPARSEABLE pane still sends (flaky-Codex case)", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true); // unknown pane does NOT veto → trust the stale-idle hook
    expect(sendText).toHaveBeenCalled();
  });

  // Guard code-review Blocker 1: the narrow picker/permission veto — a stale-idle
  // hook must NOT paste+Enter onto an actually-visible picker/permission prompt.
  it("Part A: a send-stale IDLE hook is VETOED by a visible AskUserQuestion picker (refused, nothing typed)", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("Part A: a send-stale IDLE hook is VETOED by a visible Codex approval prompt (refused)", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => CODEX_APPROVAL, sendText, sendKeys }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.28 Part A — a stale NON-idle (running) hook is NOT trusted; it
  // falls through to the real-time pane probe (unchanged; only stale-idle is new).
  it("Part A: a stale NON-idle (running) hook falls through to the pane probe", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "UserPromptSubmit",
      occurredAt: new Date(fixedNow.getTime() - 90_000).toISOString(), // stale + running
    });
    const { sendText } = spies();
    // Pane is idle: the stale running hook did NOT block; the send proceeds via the pane.
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "idle\n❯ ", sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    // Had the stale running hook been trusted, the send would refuse (mid_work).
    // It proceeded → the stale non-idle hook fell through to the pane (not trusted).
    expect(r.ok).toBe(true);
    expect(r.activity?.evidenceSource).not.toBe("runtime_hook");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 correction — INVERT fail-closed-on-unknown. `unknown` telemetry
  // (absent/failed, NOT positive picker evidence) now PROCEEDS with a non-blocking
  // advisory that still NAMES the failed producer link. Was: refused
  // target_activity_unknown. Hooks are advisory telemetry, not send authority.
  it("Part C (inverted): unknown PROCEEDS with an advisory naming the daemon-ingest producer link (no token leak)", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }));
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("producer-link:");
    expect(r.warning).toContain("daemon-ingest link DOWN");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 correction — when the seat env lacks the activity vars, the
  // advisory names the SEAT-ENV link (presence-only, never the token value), and
  // the send still PROCEEDS (was: refused).
  it("Part C (inverted): unknown PROCEEDS with an advisory naming the seat-env link when url/token are missing", async () => {
    const { sendText } = spies();
    const base = mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText });
    const tmux = Object.assign({}, base, { hasSessionEnv: async () => false }) as unknown as TmuxAdapter;
    const t = makeTransport(tmux);
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("seat-env link DOWN");
    expect(r.warning).toContain("MISSING"); // names the missing var, not its value
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 correction — --dangerously-interact no longer REQUIRES --reason for
  // `unknown` telemetry (it proceeds normally now); the reason gate scopes to the
  // positive-picker needs_input case only.
  it("correction: --dangerously-interact WITHOUT --reason PROCEEDS on unknown telemetry (no picker) AND still carries the advisory", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }));
    const r = await t.send("dev-impl@my-rig", "hi", { dangerouslyInteract: true });
    expect(r.ok).toBe(true);
    // B1 code-review fix: the advisory attaches on unknown telemetry REGARDLESS of
    // --dangerously-interact — the override branch no longer bypasses unknown handling.
    expect(r.warning).toContain("producer-link:");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 B1 code-review regression — the exact bypass the reviewer caught:
  // --dangerously-interact WITH --reason on an actually-unknown pane must STILL return
  // ok:true WITH the advisory warning (previously the dangerouslyInteract branch skipped
  // the unknown handling and returned no warning).
  it("B1: --dangerously-interact + --reason on unknown telemetry returns ok:true WITH the advisory", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }));
    const r = await t.send("dev-impl@my-rig", "hi", { dangerouslyInteract: true, reason: "driving anyway", actorSession: "orch-lead@my-rig" });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("producer-link:");
    expect(sendText).toHaveBeenCalled();
  });

  it("AMEND: a hook fresh within the send window (idle) is authoritative and the send proceeds", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "Stop",
      occurredAt: new Date(fixedNow.getTime() - 10_000).toISOString(),
    });
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.activity === undefined || r.activity?.evidenceSource === "runtime_hook").toBe(true);
    expect(sendText).toHaveBeenCalled();
  });

  // FR-1c: a permission question with no visible selector is still detected (Codex/Claude robustness).
  it("FR-1c: a permission question line with no selector in view is classified needs_input", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({
      capturePaneContent: async () => ["Do you want to proceed with this deploy?", "", "  gpt-5.5 · Context [████ ] · ~/code"].join("\n"),
      sendText,
    }));
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  // FORWARD-FIX 1 (research: ntm e28763e / AgentDeck) — a real prompt whose selector is pushed past
  // the bottom 8 lines by Claude Code's tall footer (status bar + permission hint + separators + input
  // box) must still be detected. With the old 8-line scan the selector here (9th non-blank from the
  // bottom) is missed and the ⏵⏵ idle bar on the last line FALSE-IDLES it → a send lands on the prompt.
  // The widened 12-line prompt scan catches it.
  const FOOTER_PUSHED_PROMPT = [
    "Allow this edit to session-transport.ts?",
    "",
    "❯ 1. Yes",
    "  2. Yes, allow all edits in domain/ this session",
    "  3. No, and tell Claude what to do differently",
    "  4. No, and keep this file read-only",
    "",
    "  Use ↑↓ to choose, enter to confirm",
    "",
    "──────────────── dev-impl@my-rig ────────────────",
    "❯ ",
    "──────────────────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ].join("\n");

  it("FORWARD-FIX 1: a prompt pushed past the bottom 8 lines by a tall footer is still needs_input (not false-idle)", () => {
    const c = classifyPaneActivity(FOOTER_PUSHED_PROMPT);
    expect(c.state).toBe("attention");
    expect(c.reason).toBe("selection_prompt");
  });

  it("FORWARD-FIX 1: a default send to a footer-pushed prompt is refused (no false-idle send)", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => FOOTER_PUSHED_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "looks good");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // No-regression: idle default still delivers; running + force still delivers.
  it("idle target sends by default; running target now DELIVERS WITH ADVISORY (OPR.0.4.3.28 fast-follow — mid_work downgraded, busy is not a block)", async () => {
    const idleSpy = vi.fn(async () => ({ ok: true as const }));
    const idle = makeTransport(mockTmux({ capturePaneContent: async () => "Done.\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)", sendText: idleSpy }));
    const idleRes = await idle.send("dev-impl@my-rig", "hi");
    expect(idleRes.ok).toBe(true);
    expect(idleRes.warning).toBeUndefined(); // idle → clean send, no advisory
    expect(idleSpy).toHaveBeenCalled();

    const runSpy = vi.fn(async () => ({ ok: true as const }));
    const running = makeTransport(mockTmux({ capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt", sendText: runSpy }));
    // Default (non-force) send on a running/busy pane now PROCEEDS with a non-blocking advisory
    // (was: ok:false mid_work). needs_input remains the ONLY hard refuse.
    const def = await running.send("dev-impl@my-rig", "hi");
    expect(def.ok).toBe(true);
    expect(def.warning).toContain("mid-task");
    expect(def.warning).toContain("busy is advisory");
    // --force is now a no-op on this path (kept for back-compat) — still delivers.
    const forced = await running.send("dev-impl@my-rig", "hi", { force: true });
    expect(forced.ok).toBe(true);
    expect(runSpy).toHaveBeenCalled();
  });
});
