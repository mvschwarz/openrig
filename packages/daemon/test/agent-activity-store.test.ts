import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore, hookEventState, hookMeansNeedsInput, latestHookMovedOn, latestHookPermissionPending, latestHookWaitsOnPerson } from "../src/domain/agent-activity-store.js";

const NOW = new Date("2026-04-24T12:00:00.000Z");

describe("AgentActivityStore", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(runtime: "claude-code" | "codex" = "claude-code") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, runtime === "codex" ? "dev.qa" : "dev.impl", { runtime });
    const sessionName = runtime === "codex" ? "dev-qa@test-rig" : "dev-impl@test-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, attachmentType: "tmux" });
    return { rig, node, session, sessionName };
  }

  it.each([
    ["codex", "PermissionRequest", null, "unknown"],
    ["claude-code", "PermissionRequest", null, "needs_input"],
    ["codex", "PermissionPromptConfirmed", null, "needs_input"],
    ["codex", "PermissionPromptCleared", null, "unknown"],
    ["codex", "Notification", "permission_prompt", "needs_input"],
    ["codex", "at_limit", null, "unknown"],
  ] as const)("shared hook mapping retains %s/%s with fresh and clock-stale evidence", (runtime, hookEvent, subtype, state) => {
    const { node, sessionName } = seedSession(runtime);
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    store.recordHookEvent({ runtime, sessionName, hookEvent, subtype });
    expect(hookEventState(hookEvent, subtype, runtime)).toBe(state);
    expect(hookMeansNeedsInput(hookEvent, subtype, runtime)).toBe(state === "needs_input");
    for (const referenceTime of [NOW, new Date(NOW.getTime() + 600_000)]) {
      const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: referenceTime });
      expect(latestHookWaitsOnPerson(latest, runtime)).toBe(state === "needs_input");
      expect(latestHookPermissionPending(latest, runtime)).toBe(runtime === "codex" && hookEvent === "PermissionRequest");
      expect(latestHookMovedOn(latest, "2026-04-24T11:59:00.000Z", runtime)).toBe(false);
    }
  });

  it.each(["generation_mismatch", "generation_unresolvable", "generation_unverifiable", "generation_resolver_error"])("a pending permission with %s does not hold the current occupant", reason => {
    const { sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    store.recordHookEvent({ runtime: "codex", sessionName, hookEvent: "PermissionRequest" });
    const latest = store.getLatestForNode({ sessionName, now: NOW })!;
    expect(latestHookPermissionPending({ ...latest, state: "unknown", reason, stale: true }, "codex")).toBe(false);
  });

  it("normalizes Claude prompt/tool hooks to running", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    const result = store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    expect(result.ok).toBe(true);
    const latest = store.getLatestForNode({
      nodeId: node.id,
      sessionName,
      now: NOW,
    });
    expect(latest).toMatchObject({
      state: "running",
      reason: "user_prompt_submit",
      evidenceSource: "runtime_hook",
      eventAt: "2026-04-24T11:59:00.000Z",
      rawEvent: "UserPromptSubmit",
      stale: false,
    });
  });

  it("orders by the emitter's sequence among the newest records only, so a long heartbeat history stays cheap to read", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    const post = (hookEvent: string, sequence: number, occurredAt: string) =>
      store.recordHookEvent({ runtime: "codex", sessionName, hookEvent, sourceSequence: sequence, occurredAt });
    const latest = () => store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW, order: "source" });
    // A newer boundary that lands first, then an older one that arrives late: the newer still wins.
    post("Stop", 2, "2026-04-24T11:59:30.000Z");
    post("UserPromptSubmit", 1, "2026-04-24T11:59:00.000Z");
    expect(latest()).toMatchObject({ rawEvent: "Stop" });
    // Once 200 later records have arrived, that boundary is out of the window and no longer consulted.
    for (let i = 0; i < 200; i++) post("UserPromptSubmit", 3 + i, "2026-04-24T11:58:00.000Z");
    expect(latest()).toMatchObject({ rawEvent: "UserPromptSubmit" });
  });

  it("windows the node's newest records before choosing the session, so a new session never walks the older history", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    store.recordHookEvent({ runtime: "codex", sessionName, hookEvent: "Stop", sourceSequence: 1, occurredAt: "2026-04-24T11:59:00.000Z" });
    const firstSeq = (db.prepare("SELECT MAX(seq) AS s FROM events WHERE node_id = ?").get(node.id) as { s: number }).s;
    for (let i = 0; i < 200; i++) store.recordHookEvent({ runtime: "codex", sessionName, hookEvent: "UserPromptSubmit", sourceSequence: 2 + i, occurredAt: "2026-04-24T11:59:30.000Z" });
    db.prepare("UPDATE events SET payload = json_set(payload, '$.sessionName', 'earlier-session') WHERE node_id = ? AND seq > ?").run(node.id, firstSeq);
    // The session's own record is older than the node's newest 200, which all belong to another session.
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW, order: "source" })).toBeNull();
  });

  it("does not let a hook claiming OMP escalate runtime_error on another runtime's seat", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    const result = store.recordHookEvent({ runtime: "omp", sessionName, hookEvent: "Notification", subtype: "runtime_error" });
    expect(result.ok).toBe(true);
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({ state: "unknown", runtime: "omp" });
  });

  it("projects an OMP model/auth error as needs_input until a later turn succeeds", () => {
    const rig = rigRepo.createRig("omp-rig");
    const node = rigRepo.addNode(rig.id, "qa.worker", { runtime: "omp" });
    const sessionName = "qa-worker@omp-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    store.recordHookEvent({ sessionName, runtime: "omp", hookEvent: "Notification", subtype: "runtime_error" });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({ state: "needs_input", reason: "runtime_error" });
    store.recordHookEvent({ sessionName, runtime: "omp", hookEvent: "Stop" });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({ state: "idle" });
  });

  it("normalizes Claude permission notifications to needs_input and idle_prompt to idle", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "permission_prompt",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "idle_prompt",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "idle",
      reason: "idle_prompt",
      rawEvent: "Notification",
      rawSubtype: "idle_prompt",
    });
  });

  it("normalizes Claude PreToolUse and elicitation_dialog hooks", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "PreToolUse",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "running",
      reason: "pre_tool_use",
      rawEvent: "PreToolUse",
    });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "elicitation_dialog",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "needs_input",
      reason: "elicitation_dialog",
      rawEvent: "Notification",
      rawSubtype: "elicitation_dialog",
    });
  });

  it("normalizes Codex prompt-submit to running and Stop to idle", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "idle",
      reason: "stop",
      evidenceSource: "runtime_hook",
      rawEvent: "Stop",
    });
  });

  it("records a Codex PermissionRequest as pending", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    // Official Codex approval hook (openai/codex PR #17563): hook_event_name=PermissionRequest, the
    // relay forwards tool_name (e.g. "Bash") as the subtype.
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "PermissionRequest",
      subtype: "Bash",
      occurredAt: "2026-04-24T11:59:30.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "permission_request_pending",
      evidenceSource: "runtime_hook",
      rawEvent: "PermissionRequest",
      evidence: "Bash", // names the tool being approved
    });
  });

  it("records Codex SessionStart as observed but not active", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "SessionStart",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "session_start_observed",
      evidenceSource: "runtime_hook",
      rawEvent: "SessionStart",
    });
  });

  it("returns unknown stale instead of green state for old hook evidence", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW, freshnessMs: 60_000 });
    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:50:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });

    expect(latest).toMatchObject({
      state: "unknown",
      reason: "stale_runtime_hook",
      evidenceSource: "runtime_hook",
      stale: true,
    });
  });

  it("rejects hook events without managed session identity", () => {
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    const result = store.recordHookEvent({
      runtime: "claude-code",
      hookEvent: "UserPromptSubmit",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "missing_session_identity",
    });
  });
});

// W2a-1 — GENERATION IDENTITY (SOURCE-BOUND). A claim from a PRIOR occupant generation must not be
// honored as the live seat. The emitting occupant's generation is CARRIED source-bound on the hook (the
// producer/relay supplies it at fire time; the route ingests it) — NEVER inferred from record-time state
// (that inference mis-attributes a DELAYED prior-occupant hook, and timing/boot_at is unsound at 1s
// precision + clock skew). The READ resolves the LIVE generation (session-registry currentOccupantTenure)
// and compares. Cases: (1) carried != live ⇒ MISMATCH — unknown/generation_mismatch/stale, provenance
// RESOLVED, REFUSED (positive dead-tenure evidence; immune to timing — same-second is still a mismatch);
// (2) carried == live (incl. a same-native relaunch continuation) ⇒ fresh, provenance resolved; (3) null
// on EITHER side ⇒ UNRESOLVABLE (absence of evidence): unknown + a DISTINCT reason (unresolvable = live
// null / unverifiable = carried none) + stale — NEVER fresh — with generationProvenance='unresolved'
// riding alongside so the row is DELIVERED (tap verify-demotion is a follow-on). The carried-none case
// is explicit per-path absence: sound and never false-fresh even though managed launch/fresh-handover
// producers now carry the generation; (4) no resolver ⇒ legacy, no label; (5) resolver EXCEPTION ⇒ degrade
// (generation_resolver_error). Ignorance and evidence get different verdicts and must not collapse.
describe("AgentActivityStore — generation identity (W2a-1)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedGenSession() {
    const rig = rigRepo.createRig("gen-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    const sessionName = "dev-qa@gen-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, attachmentType: "tmux" });
    return { node, sessionName };
  }

  // (1) DELAYED PRIOR-OCCUPANT / SAME-SECOND — the atom's whole case, closed by SOURCE-BINDING, not
  // timing. A hook CARRYING a prior generation (gen-A), read while the live occupant is gen-B, is a
  // MISMATCH — even in the same wall-clock second (nothing is timed; boot_at 1s precision + clock skew
  // are irrelevant because the generation is carried, not inferred). Never rendered fresh for the live
  // occupant. This is the delayed prior-occupant hook that the record-time-inference version mis-credited.
  it("carried prior generation vs live (same-second) ⇒ unknown/generation_mismatch, never fresh", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-B", // the LIVE occupant at read time
    });

    // The hook CARRIES gen-A (its emitting occupant), recorded while gen-B is already live.
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
      generation: "gen-A",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "generation_mismatch",
      evidenceSource: "runtime_hook",
      stale: true,
      generationProvenance: "resolved", // both generations WERE resolved; they simply differ
    });
  });

  // (2) CARRIED == LIVE (incl. relaunch-continuation) ⇒ fresh. The hook carries the same generation the
  // ledger now reports live (a same-native relaunch is a continuation, no new generation).
  it("carried generation equals live (incl. relaunch-continuation) ⇒ fresh, provenance resolved", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-A",
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:30.000Z",
      generation: "gen-A",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "running",
      reason: "user_prompt_submit",
      stale: false,
      generationProvenance: "resolved",
    });
  });

  // (3a) UNRESOLVABLE — live side. The live generation is UNKNOWN (resolver ⇒ null) even though the hook
  // carried gen-A. ABSENCE of evidence, not a dead-tenure finding: state UNKNOWN + distinct reason +
  // stale:true — NEVER fresh — with generationProvenance='unresolved' riding alongside so the row is
  // DELIVERED (tap verify-demotion, follow-on). Distinct reason from (3b) and from mismatch.
  it("unresolvable live generation (resolver ⇒ null) ⇒ unknown/generation_unresolvable + unresolved, stale", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => null, // the ledger cannot resolve the LIVE occupant generation
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
      generation: "gen-A", // carried, but the live side is unknown ⇒ cannot verify
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown", // NOT fresh — no false liveness claim
      reason: "generation_unresolvable",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  // (3b) UNVERIFIABLE — carried side. This hook carried NO generation (legacy/excluded or no-tenure
  // emitting path ⇒ absent ⇒ null), so it cannot be verified against the live generation. Same family
  // as (3a) — unknown + label, never fresh — but a DISTINCT reason (keep them separate; ignorance has
  // more than one shape and collapsing them loses forensics). Managed launch/fresh-handover producers
  // carry the generation; explicit absence remains sound and never false-fresh.
  it("unverifiable carried generation (hook carried none) ⇒ unknown/generation_unverifiable + unresolved, stale", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-B",
    });

    // This emitting path did NOT carry a generation ⇒ recorded null (sound per-path absence).
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "generation_unverifiable",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  // (4) ZERO-RIPPLE — with NO resolver injected, reads are unchanged and carry NO provenance label
  // (the legacy clock-only path). This is the prod-unreachable branch (production always injects the
  // resolver — see the single-construction-site guard), kept green so the injection stays opt-in-safe.
  it("no generation resolver ⇒ legacy behavior, no label", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:30.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({ state: "running", reason: "user_prompt_submit", stale: false });
    expect(latest?.generationProvenance).toBeUndefined();
  });

  // (2b) PURE-FRESHNESS pin — GREEN AT BASE by design (documented so it never reads as a dud). Asserts
  // ONLY the same-generation-stays-fresh BEHAVIOUR (which exists at base) and deliberately NOT the new
  // provenance label. A red here means freshness regressed, unambiguously — never "the label went
  // missing" (test (2) above guards the label). One pin per claim: a pin that can fail for two reasons
  // names neither (P32 — assert the discriminating field).
  it("same generation ⇒ stays fresh — PURE freshness, no label assertion (green at base + after)", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-A",
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:30.000Z",
      generation: "gen-A",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest?.state).toBe("running");
    expect(latest?.stale).toBe(false);
    // deliberately NO generationProvenance assertion here — freshness-only discriminator.
  });

  // (5) MECHANISM proof against the SHIPPED occupant-tenure ledger — NOT a constant fake. The READ-side
  // resolver is the real currentOccupantTenure(nodeId).generationUuid; the hook CARRIES the emitting
  // generation minted through the real mintOccupantTenure. The effect (does the store honor the real
  // ledger), not the indicator. Both boundary directions at once: a same-native relaunch is a
  // continuation (the live generation stays == the carried one ⇒ fresh); a different-native occupant
  // mints a NEW live generation (⇒ the carried prior generation is a dead tenure ⇒ mismatch/refused).
  it("REAL ledger: a hook carrying gen-A stays fresh across a relaunch (same native), mismatches a new occupant (different native)", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    });

    // The emitting occupant's generation, minted through the real ledger, is CARRIED on the hook.
    const genA = sessionRegistry.mintOccupantTenure(node.id, "initial", "boot-A").generationUuid;
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
      generation: genA,
    });

    // RELAUNCH — same native id ⇒ mintOccupantTenure returns the EXISTING tenure (no new generation),
    // so the LIVE generation stays gen-A ⇒ carried == live ⇒ fresh.
    const genRelaunch = sessionRegistry.mintOccupantTenure(node.id, "initial", "boot-A").generationUuid;
    expect(genRelaunch).toBe(genA); // continuation, proven at the ledger (not stipulated by a fake)
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "idle",
      reason: "stop",
      stale: false,
      generationProvenance: "resolved",
    });

    // NEW OCCUPANT — a different native id mints a NEW live generation ⇒ the carried gen-A is a dead tenure.
    const genB = sessionRegistry.mintOccupantTenure(node.id, "initial", "boot-B").generationUuid;
    expect(genB).not.toBe(genA);
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "unknown",
      reason: "generation_mismatch",
      stale: true,
      generationProvenance: "resolved",
    });
  });

  // (6) RESOLVER EXCEPTION ⇒ DEGRADE. The live-generation resolver throws (a transient ledger/db
  // fault). The read must NOT crash and must NOT render fresh: a distinct unknown/generation_resolver_
  // error verdict, stale, provenance unresolved. Record does not resolve the generation (source-bound),
  // so recording never throws either.
  it("resolver exception at read ⇒ unknown/generation_resolver_error (degrade), never crashes", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => {
        throw new Error("occupant-tenure ledger unavailable");
      },
    });

    expect(() =>
      store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "Stop",
        occurredAt: "2026-04-24T11:59:00.000Z",
        generation: "gen-A",
      }),
    ).not.toThrow();

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "generation_resolver_error",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  it("a carried generation absent from this node's ledger is unresolvable, never mismatch", () => {
    const { node, sessionName } = seedGenSession();
    const unregistered = sessionRegistry.reserveOccupantGeneration();
    expect(unregistered).not.toBeNull();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (nodeId, generation) =>
        sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      generation: unregistered,
    });

    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "unknown",
      reason: "generation_unresolvable",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  it("registered-generation membership resolver faults stay generation_resolver_error", () => {
    const { node, sessionName } = seedGenSession();
    const liveGeneration = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => liveGeneration,
      isRegisteredOccupantGeneration: () => {
        throw new Error("membership lookup failed");
      },
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      generation: liveGeneration,
    });

    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "unknown",
      reason: "generation_resolver_error",
      stale: true,
      generationProvenance: "unresolved",
    });
  });
});
