import { describe, it, expect, vi } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService, DEFAULT_STRUCTURAL_STALE_MS } from "../src/domain/seat-structural-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { codexPromptNeedsInput, readCodexPromptBinding, type CodexPromptBinding } from "../src/domain/codex-prompt-observation.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter, PaneCapture } from "../src/adapters/tmux.js";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";

// Known complete native layout, not a footer/idle label and not a live seat capture.
const idle = ["  >_ OpenAI Codex (v0.160.0)", "     /tmp/fixture", "  permissions: bypass", "", "  Ready to work", "",
  "› Ask Codex to do anything", "", "  gpt-test · /tmp/fixture", "  ? for shortcuts"].join("\n");
const name = "builder@fixture";
function fixture() {
  let clock = Date.parse("2026-10-30T10:00:10.500Z");
  let binding: CodexPromptBinding | null = { nodeId: "node-a", sessionName: name, sessionId: "session-a", generation: "generation-a",
    nativeSessionId: "native-a", pane: "%42", bindingId: "binding-a", bindingUpdatedAt: "initial", processId: 10, paneProcessId: 5, captureRevision: "0" };
  let frame: string | null = idle;
  let motion: number | null = null;
  const legacy = vi.fn(async () => false);
  const capture = vi.fn(async () => frame);
  const tmux = { capturePaneContent: capture, readPaneLastActivity: vi.fn(async () => motion) } as unknown as TmuxAdapter;
  const service = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(clock),
    permissionPromptReader: legacy, codexPromptBindingReader: () => binding });
  service.declareRungInventory({ seatNodeId: "node-a", sessionName: name }, CODEX_ACTIVITY_RUNG_INVENTORY);
  const structural = new SeatStructuralActivityService(tmux, () => new Date(clock));
  structural.attachPromptObserver((session, runtime) => service.beginCodexPromptCapture(session, runtime));
  const observe = () => structural.pollSeat(name, undefined, "codex");
  const state = () => service.getSeatState("node-a")!;
  return { service, structural, tmux, capture, legacy, observe, state,
    now: () => clock, advance: (ms: number) => { clock += ms; }, setFrame: (s: string | null) => { frame = s; },
    setMotion: (epoch: number | null) => { motion = epoch; }, getBinding: () => binding,
    patchBinding: (patch: Partial<CodexPromptBinding>) => { binding = { ...binding!, ...patch }; },
    clearBinding: () => { binding = null; } };
}
function expectUnknown(f: ReturnType<typeof fixture>) {
  expect(f.state().needsInputEvidence).toBeNull();
  expect(f.state().needsInput.count).toBe(0);
}

describe("qualified current native Codex prompt observer", () => {
  it("default zero remains unknown; one genuine qualified capture supplies observed zero through the existing oracle", async () => {
    const f = fixture(); expectUnknown(f);
    expect(codexPromptNeedsInput(idle, name)).toEqual({ count: 0, reason: null });
    await f.observe();
    expect(f.state().needsInput).toEqual({ count: 0, reason: null });
    expect(f.state().needsInputEvidence?.rung).toBe("needs-input-chrome");
    expect(f.state().seq).toBeGreaterThan(0);
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.capture).toHaveBeenCalledExactlyOnceWith("%42", 20);
    expect(f.state().rungs.find(r => r.rung === "lifecycle-hooks")?.trust).toBe("trial");
  });
  it.each(["product-path-idle.J.txt", "idle.txt", "after-enter-15s.J.txt"])("qualifies retained complete native fixture %s, not a new live/native run", async file => {
    const f = fixture();
    f.setFrame(readFileSync(new URL(`./fixtures/input-box/codex-0.160.0/${file}`, import.meta.url), "utf8"));
    await f.observe(); expect(f.state().needsInputEvidence?.rung).toBe("needs-input-chrome");
    expect(f.state().needsInput.count).toBe(0);
  });
  it.each([null, "", "›\n  ? for shortcuts", "›\n\n  gpt-test · /tmp/fixture\n  ? for shortcuts",
    idle.replace("Ask Codex to do anything", "my unsent draft"), idle.replace("v0.160.0", "v0.161.0"),
    idle.replace("  Ready to work", "• Working (1s • esc to interrupt)")])("unqualified, incomplete, draft, busy or unsupported bytes cannot supply clear (%s)", async text => {
    const f = fixture(); f.setFrame(text); await f.observe();
    expect(f.state().needsInputEvidence === null || f.state().needsInput.count > 0).toBe(true);
  });
  it("capture outage invalidates an earlier clear even when the activity class was unchanged", async () => {
    const f = fixture(); await f.observe(); expect(f.state().needsInputEvidence).not.toBeNull();
    f.capture.mockRejectedValueOnce(new Error("fixture unavailable")); await f.observe(); expectUnknown(f);
  });
  it("stalled sweep expires at oracle READ; checkedAt or completion time cannot restamp old bytes", async () => {
    const f = fixture(); await f.observe(); const cached = f.structural.getStructuralActivity(name)!;
    f.advance(DEFAULT_STRUCTURAL_STALE_MS); cached.checkedAt = new Date(f.now()).toISOString();
    expectUnknown(f);
  });
  it("slow capture whose completion is fresh is still too old from its start", async () => {
    const f = fixture(); f.capture.mockImplementationOnce(async () => { f.advance(DEFAULT_STRUCTURAL_STALE_MS); return idle; });
    await f.observe(); expectUnknown(f);
  });
  it.each(["generation", "nativeSessionId", "pane", "sessionId", "bindingUpdatedAt", "processId"] as const)("rebind/current %s change invalidates a clear at read without another capture", async key => {
    const f = fixture(); await f.observe(); f.patchBinding({ [key]: key === "processId" ? 11 : "changed" }); expectUnknown(f);
  });
  it("missing/unresolved identity invalidates prior clear", async () => { const f = fixture(); await f.observe(); f.clearBinding(); expectUnknown(f); });
  it("an observed identity outage stays invalid after identity recovery until another qualifying capture", async () => {
    const f = fixture(); await f.observe(); const original = f.getBinding()!;
    f.clearBinding(); expectUnknown(f); f.patchBinding(original); expectUnknown(f);
    await f.observe(); expect(f.state().needsInputEvidence?.rung).toBe("needs-input-chrome");
  });
  it("new unknown capture during a temporarily unresolved binding cannot revive older clear after recovery", async () => {
    const f = fixture(); await f.observe(); const original = f.getBinding()!;
    f.clearBinding(); f.setFrame("unknown newer fixture"); await f.observe();
    f.patchBinding(original); expectUnknown(f);
  });
  it("new request then genuine resolution while capture waits does not revive its earlier clear ticket", async () => {
    const f = fixture(); f.capture.mockImplementationOnce(async () => {
      f.service.reportEvidence({ seatNodeId: "node-a", sessionName: name, rung: "lifecycle-hooks", sourceId: "fixture:hook", seq: 1,
        observedAt: new Date(f.now()).toISOString(), permissionRequest: { id: "fixture-request" } });
      f.service.settlePermissionPrompt(name); return idle;
    }); await f.observe(); expectUnknown(f);
  });
  it("binding ABA during capture is caught by its begin/finish revision even if final identity fields match", async () => {
    const f = fixture(); f.capture.mockImplementationOnce(async () => { f.patchBinding({ captureRevision: "2" }); return idle; });
    await f.observe(); expectUnknown(f);
  });
  it("swap/retirement during await cannot publish predecessor bytes", async () => {
    const f = fixture(); f.capture.mockImplementationOnce(async () => { f.service.declareOccupantSwap("node-a", "successor"); return idle; });
    await f.observe(); expectUnknown(f);
  });
  it("real positive from another producer is never hidden by generic clear", async () => {
    const f = fixture(); f.service.reportEvidence({ seatNodeId: "node-a", sessionName: name, rung: "needs-input-chrome", sourceId: "fixture:positive", seq: 100,
      observedAt: new Date(f.now()).toISOString(), needsInput: { count: 1, reason: "permission_prompt" } });
    await f.observe(); expect(f.state().needsInput.count).toBe(1);
  });
  it("current permission/selection is positive, and subsequent unrecognized bytes are unknown", async () => {
    const f = fixture(); f.setFrame("Would you like to run the following command?\n› 1. Yes\n  2. No"); await f.observe();
    expect(f.state().needsInput.count).toBe(1);
    f.setFrame("unsupported fixture"); await f.observe(); expectUnknown(f);
  });
  it("same-second live motion is held, later-second complete clear qualifies, resumed writes invalidate it", async () => {
    const f = fixture(); f.setMotion(Math.floor(f.now() / 1000)); await f.service.pollSeat(name); await f.observe(); expectUnknown(f);
    f.advance(600); await f.observe(); expect(f.state().needsInputEvidence?.rung).toBe("needs-input-chrome");
    f.setMotion(Math.floor(f.now() / 1000)); await f.service.pollSeat(name); expectUnknown(f);
  });
  it("out-of-order overlapping direct captures cannot revive an older clear", async () => {
    const f = fixture(); let release!: (s: string) => void;
    f.capture.mockImplementationOnce(() => new Promise<string>(r => { release = r; }));
    const old = f.observe(); f.setFrame("unknown newer fixture"); await f.observe(); release(idle); await old; expectUnknown(f);
  });
  it("batch ticket predates actual batch await and uses the frozen pane without adding captures", async () => {
    const f = fixture();
    const batch = vi.fn(async (_names: string[], _lines: number, _now: () => Date, panes?: ReadonlyMap<string, string>) => {
      expect(panes?.get(name)).toBe("%42");
      f.service.reportEvidence({ seatNodeId: "node-a", sessionName: name, rung: "lifecycle-hooks", sourceId: "fixture:batch-hook", seq: 1,
        observedAt: new Date(f.now()).toISOString(), permissionRequest: { id: "fixture-batch-request" } });
      f.service.settlePermissionPrompt(name);
      return new Map<string, PaneCapture>([[name, { text: idle, capturedAt: new Date(f.now()) }]]);
    });
    f.tmux.capturePanesContent = batch;
    const db = { prepare: () => ({ all: () => [{ session_name: name, runtime: "codex", community_harness: null }] }), pragma: () => [] } as unknown as Database.Database;
    await f.structural.pollAllRunningTmuxSeats(db);
    expect(batch).toHaveBeenCalledTimes(1); expect(f.capture).not.toHaveBeenCalled(); expectUnknown(f);
  });
  it.each([false, true])("failed batch fallback retains its ORIGINAL ticket (request ABA: %s)", async aba => {
    const f = fixture();
    f.tmux.capturePanesContent = vi.fn(async () => {
      if (aba) {
        f.service.reportEvidence({ seatNodeId: "node-a", sessionName: name, rung: "lifecycle-hooks", sourceId: "fixture:batch-hook", seq: 1,
          observedAt: new Date(f.now()).toISOString(), permissionRequest: { id: "fallback-request" } });
        f.service.settlePermissionPrompt(name);
      }
      throw new Error("fixture batch unavailable");
    });
    const db = { prepare: () => ({ all: () => [{ session_name: name, runtime: "codex", community_harness: null }] }), pragma: () => [] } as unknown as Database.Database;
    await f.structural.pollAllRunningTmuxSeats(db);
    expect(f.capture).toHaveBeenCalledExactlyOnceWith("%42", 20);
    if (aba) expectUnknown(f);
    else expect(f.state().needsInputEvidence?.rung).toBe("needs-input-chrome");
  });
});

describe("committed Codex binding read (isolated SQLite, no process probes)", () => {
  function committed() {
    const db = createFullTestDb();
    const rigs = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigs.createRig("fixture");
    const node = rigs.addNode(rig.id, "dev.builder", { runtime: "codex" });
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, "ready");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%42", attachmentType: "tmux" });
    registry.updateResumeToken(session.id, "codex", "native-a", "hook");
    const identities = new SeatIdentityStore(db);
    const bootAt = registry.currentOccupantTenure(node.id)!.bootAt;
    const bootMs = Date.parse(bootAt.replace(" ", "T") + "Z");
    const now = new Date(bootMs + 2500);
    identities.upsert({ nodeId: node.id, sessionName: name, verdict: "verified", evidenceSource: null,
      reason: null, observedAt: now.toISOString(), evidence: { registeredPane: "%42", observedPid: 10,
        observedPanePid: 5, observedCommand: "codex", matchedLayer: 1 } });
    return { db, registry, identities, now, bootMs, node, session, read: () => readCodexPromptBinding(db, registry, identities, name, now) };
  }
  it("normal null-boot tenure uses native-origin current token and current verified binding", () => {
    const f = committed();
    try {
      expect(f.registry.currentOccupantTenure(f.node.id)?.nativeSessionIdAtBoot).toBeNull();
      expect(f.read()).toMatchObject({ nativeSessionId: "native-a", pane: "%42", processId: 10, paneProcessId: 5 });
      const first = f.read()!;
      f.registry.updateBinding(f.node.id, { tmuxPane: "%43" });
      f.registry.updateBinding(f.node.id, { tmuxPane: "%42" });
      expect(f.read()!.captureRevision).not.toBe(first.captureRevision);
    } finally { f.db.close(); }
  });
  it.each([
    "UPDATE sessions SET startup_status='pending'", "UPDATE sessions SET status='detached'",
    "UPDATE sessions SET resume_token=NULL", "UPDATE sessions SET resume_provenance='operator'",
    "UPDATE sessions SET resume_provenance=NULL", "UPDATE nodes SET runtime='claude-code'",
    "UPDATE bindings SET attachment_type='external'", "UPDATE bindings SET tmux_pane=NULL",
    "UPDATE seat_identity_verdicts SET verdict='tmux_unavailable'",
    "UPDATE seat_identity_verdicts SET session_name='other@fixture'",
    "UPDATE seat_identity_verdicts SET registered_pane='%43'",
    "UPDATE seat_identity_verdicts SET observed_pid=NULL",
    "UPDATE seat_identity_verdicts SET observed_pane_pid=NULL",
    "UPDATE occupant_tenures SET native_session_id_at_boot='other-native'",
  ])("unresolved current binding stays unknown: %s", sql => {
    const f = committed(); try { f.db.exec(sql); expect(f.read()).toBeNull(); } finally { f.db.close(); }
  });
  it.each([
    { offset: -1, accepts: false }, { offset: 0, accepts: false }, { offset: 500, accepts: false },
    { offset: 999, accepts: false }, { offset: 1000, accepts: true }, { offset: 1500, accepts: true },
  ])("current tenure rejects the whole ambiguous UTC boot second ($offset ms; accepts $accepts)", ({ offset, accepts }) => {
    const f = committed();
    try {
      f.identities.upsert({ ...f.identities.getForNode(f.node.id)!, observedAt: new Date(f.bootMs + offset).toISOString() });
      expect(f.read() !== null).toBe(accepts);
    } finally { f.db.close(); }
  });
  it.each([{ age: 4999, accepts: true }, { age: 5000, accepts: false }, { age: -1, accepts: false }])(
    "freshness still decides AFTER current-tenure provenance ($age ms; accepts $accepts)", ({ age, accepts }) => {
      const f = committed();
      try {
        f.now.setTime(f.bootMs + 8000);
        f.identities.upsert({ ...f.identities.getForNode(f.node.id)!, observedAt: new Date(f.now.getTime() - age).toISOString() });
        expect(f.read() !== null).toBe(accepts);
      } finally { f.db.close(); }
    });
  it.each(["", "unknown", "2026-02-30 12:00:00", "2026-10-30 25:00:00", "2026-10-30T10:00:00.000Z"])(
    "unsupported or invalid tenure timestamp is unknown (%s)", boot => {
      const f = committed();
      try { f.db.prepare("UPDATE occupant_tenures SET boot_at = ?").run(boot); expect(f.read()).toBeNull(); }
      finally { f.db.close(); }
    });
  it.each(["America/Los_Angeles", "Asia/Tokyo"])("decodes native SQLite boot time as UTC under process TZ=%s", zone => {
    const f = committed(); const prior = process.env.TZ;
    try { process.env.TZ = zone; expect(f.read()).not.toBeNull(); }
    finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; f.db.close(); }
  });
});
