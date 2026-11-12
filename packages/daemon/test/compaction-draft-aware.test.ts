// A managed compaction on a seat under draft-aware delivery (#1481) must leave no held /compact row behind,
// whatever the timing. Every delivery there reserves a held outbox row first; a busy seat used to leave one
// per poll, filling the seat's held quota. Real SessionTransport, real draft-aware delivery and outbox on an
// in-memory database; the tmux adapter records commands instead of running them.
import Database from "better-sqlite3";
import { Hono } from "hono";
import { inputReadDiagnostic } from "../src/domain/input-read-diagnostic.js";
import { compactionRoutes } from "../src/routes/compaction.js";
import stringWidth from "string-width";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { ClaudeCompactionEnforcer, COMPACTION_RECORD_FILE } from "../src/domain/claude-compaction-enforcer.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";

const seat = "worker@test", input = { sessionName: seat, runtime: "claude-code", usedPercentage: 90 };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  return { screen: ["Ready", "────────────────────", `❯ ${body}`, "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(body), y: 2, width: 100000, height: 60 }, inMode: false };
}

async function fixture(opts: { pane: string | null; mode?: "off" | "draft-aware"; footer?: boolean; refuseDraft?: boolean; suggestion?: "faint" | "plain" } = { pane: "%1" }) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test',${opts.pane === null ? "NULL" : `'${opts.pane}'`});
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body = "", staged = "";
  let onStage: (() => void) | undefined;
  const snapshot = () => {
    const s = frame(body);
    if (!body && opts.suggestion) s.screen = frame(opts.suggestion === "faint" ? '\x1b[2mTry "fix typecheck errors"\x1b[22m' : 'Try "fix typecheck errors"').screen;
    if (opts.footer) s.screen += "\n✔ Update installed · /restart to apply";
    return s;
  };
  const writes: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { writes.push(`paste:${staged}`); body += staged; }
    if (command.includes("send-keys") && command.includes("Enter")) { writes.push("enter"); body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; onStage?.(); }, unlink: async () => {}, tmpName: () => "/fixture/compact-input", bufferName: () => "compact-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async () => [{ id: "%1" } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => snapshot());
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => snapshot().screen);
  vi.spyOn(tmux, "getPaneCursorPosition").mockImplementation(async () => snapshot().cursor);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    deliverOverDraft: () => !opts.refuseDraft,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), waitForIdlePollMs: 5 });
  // Readiness is the variable under test: the pane says idle or working.
  let activity = "idle";
  (transport as any).classifySendReadiness = async () => ({ state: activity, reason: "fixture", evidenceSource: "pane_heuristic" });
  (transport as any).claudeDeliveryObservation = async () => ({ state: "unknown", detail: "fixture" });
  await guard.set("a", { mode: opts.mode ?? "draft-aware" }, "human@test", "fixture input policy");
  const home = mkdtempSync(join(tmpdir(), "compaction-draft-aware-"));
  let clock = 10_000;
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a restore map.", compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "" };
  const e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport, {
    openrigHome: home, now: () => clock, sleep: async (ms) => { clock += ms; }, compactSendIdleWaitMs: 20,
    resolveOccupantGeneration: () => guard.target(seat).occupant ?? null });
    cleanup.push(async () => { await transport.guardedDelivery?.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });
  const stageMap = () => {
    const a = e.getPreparationState(seat)!; mkdirSync(dirname(a.mapPath), { recursive: true });
    writeFileSync(a.mapPath + ".tmp", `# Restore map\n${a.marker}\n`);
  };
  // Every outbox row, labelled by what it carries: the /compact command or the preparation prompt.
  const rows = () => (db.prepare("SELECT outbox_id AS id, delivery_state AS state, body FROM outbox_entries ORDER BY rowid").all() as Array<{ id: string; state: string; body: string }>)
    .map((r) => ({ kind: r.body.startsWith("/compact") ? "compact" : r.body.includes("compaction preparation") || r.body.includes("manual compaction was requested") ? "prep" : "other", state: r.state }));
  const effects = () => ({ compactPastes: writes.filter((w) => w.startsWith("paste:/compact")).length, prepPastes: writes.filter((w) => w.startsWith("paste:") && !w.startsWith("paste:/compact")).length, enters: writes.filter((w) => w === "enter").length });
  const compactRows = (state?: string) => (db.prepare("SELECT outbox_id AS id, delivery_state AS state FROM outbox_entries WHERE body LIKE '/compact%'").all() as Array<{ id: string; state: string }>)
    .filter((r) => !state || r.state === state);
  return { db, e, transport, tmux, writes, compactRows, rows, effects, stageMap, recover: () => {
    const next = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport,
      { openrigHome: home, now: () => clock, resolveOccupantGeneration: () => "g1" });
    next.recoverSeat(input); return next;
  }, body: () => body,
    onStage: (fn: () => void) => { onStage = fn; }, activity: (s: string) => { activity = s; }, draft: (text: string) => { body = text; } };
}

it.each([
  { footer: false, skipMap: false }, { footer: false, skipMap: true },
  { footer: true, skipMap: false }, { footer: true, skipMap: true },
])("default managed preparation joins a draft with typing guard off (footer=$footer, skipMap=$skipMap)", async ({ footer, skipMap }) => {
  const f = await fixture({ pane: "%1", mode: "off", footer });
  f.draft("an unsent message");
  const outcome = await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap });
  f.e.cancelPreparation(seat);
  expect(outcome).toMatchObject(skipMap ? { triggered: true } : { preparation: { delivery: "delivered", compact: "not_sent" } });
  expect(f.body()).toBe("");
  expect(f.effects()).toEqual({ compactPastes: skipMap ? 1 : 0, prepPastes: 1, enters: skipMap ? 2 : 1 });
});

it("checks the composer after buffer setup, immediately before the preparation paste", async () => {
  const f = await fixture({ pane: "%1", mode: "draft-aware", footer: true });
  f.onStage(() => f.draft("typed while the buffer was prepared"));
  const outcome = await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  expect(outcome).toMatchObject({ reason: "draft_input_busy", preparation: { delivery: "not_sent" } });
  expect(f.body()).toBe("typed while the buffer was prepared");
  expect(f.writes).toEqual([]);
});

it("an explicit draft refusal records its existing reading without draft text", async () => {
  const f = await fixture({ pane: "%1", mode: "off", refuseDraft: true });
  f.draft("an unsent message");
  await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  const state = f.e.getPreparationState(seat)!;
  expect(state).toMatchObject({ delivery: "not_sent", inputBox: { status: "typed", confidence: "medium",
    cursor: { x: 19, y: 2, width: 100000, height: 60 } } });
  expect(Object.keys(state.inputBox!).sort()).toEqual(["confidence", "cursor", "evidence", "status"]);
  expect(JSON.parse(readFileSync(join(dirname(state.mapPath), COMPACTION_RECORD_FILE), "utf8"))).toMatchObject({ delivery: "not_sent", inputBox: state.inputBox });
  expect(f.writes).toEqual([]);
});

it.each([null, { x: 0, y: 0, width: 100000, height: 60 }])("an unreadable cursor does not impose a default preparation hold (cursor=%j)", async cursor => {
  const f = await fixture({ pane: "%1", mode: "off" });
  vi.spyOn(f.tmux, "getPaneCursorPosition").mockResolvedValue(cursor);
  vi.spyOn(f.tmux, "captureComposerSnapshot").mockResolvedValue({ ...frame(""), cursor });
  const outcome = await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  expect(outcome).toMatchObject({ triggered: true });
  // This is not a held send: do not invent a refusal reading in the preparation record.
  expect(f.e.getPreparationState(seat)?.inputBox).toBeUndefined();
  expect(f.effects()).toEqual({ compactPastes: 1, prepPastes: 1, enters: 2 });
});

it("an opted-in draft refusal also protects the managed command", async () => {
  const f = await fixture({ pane: "%1", mode: "off", refuseDraft: true });
  const send = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport, "send").mockImplementation(async (s, text, opts) => {
    if (text.startsWith("/compact")) f.draft("draft before command");
    return send(s, text, opts);
  });
  const outcome = await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  expect(outcome).toMatchObject({ preparation: { compact: "not_sent" } });
  expect(f.body()).toBe("draft before command");
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: 1, enters: 1 });
});

it("an opted-in draft refusal protects owed restore input", async () => {
  const f = await fixture({ pane: "%1", mode: "off", refuseDraft: true });
  expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
  f.draft("draft before restore");
  const before = f.writes.length;
  await f.e.maybeAutoCompact(input);
  expect(f.body()).toBe("draft before restore");
  expect(f.writes.length).toBe(before);
  expect(f.e.getOwedRestore(seat)?.stage).toBe("turn_boundary");
});

// #2845: a person's restore notice leaves the map path out and points to rig compact <seat> --state, so the owed restore
// names the map the restore request uses; under --skip-map, only a map the seat completed anyway.
it.each([{ skipMap: false, written: true }, { skipMap: true, written: false }, { skipMap: true, written: true }])(
  "the owed restore names the map the restore request uses (skipMap=$skipMap, map written=$written)", async ({ skipMap, written }) => {
    const f = await fixture({ pane: "%1", mode: "off" });
    let mapPath: string | null = null;
    const real = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementation(async (s: string, t: string, o?: any) => {
      const r = await real(s, t, o);
      if (mapPath === null) { mapPath = f.e.getPreparationState(seat)!.mapPath; if (written) f.stageMap(); }
      return r;
    });
    expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap })).toMatchObject({ triggered: true });
    // The same answer while the restore request and then the audit are owed: the request landing ends the in-memory carry.
    for (const stage of ["restore_prompt", "compliance_prompt"]) {
      expect(await f.e.maybeAutoCompact(input)).toEqual({ triggered: true });
      const owed = f.e.getOwedRestore(seat)!;
      expect(owed.stage).toBe(stage);
      if (written) expect(owed.mapPath).toBe(skipMap ? `${mapPath}.tmp` : mapPath);
      else expect(owed).not.toHaveProperty("mapPath");
    }
  });

it.each([false, true])("empty composer still permits managed preparation and command (footer=%s)", async footer => {
  const f = await fixture({ pane: "%1", mode: "off", footer });
  expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
  expect(f.effects()).toEqual({ compactPastes: 1, prepPastes: 1, enters: 2 });
});

it("a high-confidence faint suggestion still permits managed input", async () => {
  const f = await fixture({ pane: "%1", mode: "off", suggestion: "faint" });
  expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
  expect(f.effects()).toEqual({ compactPastes: 1, prepPastes: 1, enters: 2 });
});

it("default delivery does not hold possible suggestion words without faint styling", async () => {
  const f = await fixture({ pane: "%1", mode: "off", suggestion: "plain" });
  expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
  expect(f.effects()).toEqual({ compactPastes: 1, prepPastes: 1, enters: 2 });
});

it("automatic, recorded pane (existing-behaviour control, green before this PR's fixes): busy then idle, the lifecycle lease refuses before any send, so no /compact and no held row", async () => {
  const f = await fixture();
  expect(f.transport.guardedDelivery).toBeDefined();
  f.activity("running");
  const outcomes = [];
  for (let i = 0; i < 4; i++) outcomes.push(await f.e.maybeAutoCompact(input));
  f.activity("idle");
  for (let i = 0; i < 2; i++) outcomes.push(await f.e.maybeAutoCompact(input));
  // SeatDeliveryGuard.lifecycle refuses a writing lifecycle operation on an active draft-aware seat
  // (draft_aware_lifecycle); the enforcer reports that refusal as guard_target_unknown.
  expect(new Set(outcomes.map((o) => JSON.stringify(o)))).toEqual(new Set([JSON.stringify({ triggered: false, reason: "guard_target_unknown" })]));
  expect(f.e.getPreparationState(seat)).toBeNull();
  expect(f.writes).toEqual([]);
  // The actual held rows, counted: none for /compact, none at all.
  expect(f.compactRows()).toEqual([]);
  expect((f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n).toBe(0);
});

it("manual, recorded pane (existing-behaviour control): the preparation prompt is delivered, then the /compact lease refuses; no /compact effect or row", async () => {
  const f = await fixture();
  let staged = false;
  const real = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport, "send").mockImplementation(async (s: string, t: string, o?: any) => { const r = await real(s, t, o); if (!staged) { staged = true; f.stageMap(); } return r; });
  const outcome = await f.e.triggerManualCompact({ ...input, usedPercentage: 40 }, { operatorInitiated: true });
  // The manual path sends the preparation prompt outside the lease, so it is delivered...
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: 1, enters: 1 });
  expect(f.rows()).toEqual([{ kind: "prep", state: "delivered" }]);
  // ...and the /compact send then meets the draft-aware lifecycle refusal before any input.
  expect(outcome).toMatchObject({ triggered: false, reason: "draft_aware_lifecycle", preparation: { delivery: "delivered", compact: "not_sent" } });
});

it("manual, someone is drafting in the input box (existing-behaviour control, green before N1): draft-aware delivery holds the preparation prompt as retained, so the request ends at once as not sent", async () => {
  const f = await fixture();
  f.draft("half a sentence");
  const outcome = await f.e.triggerManualCompact({ ...input, usedPercentage: 40 }, { operatorInitiated: true });
  expect(outcome).toMatchObject({ triggered: false, reason: "draft_input_busy", preparation: { delivery: "not_sent", compact: "not_sent" } });
  expect(f.rows()).toEqual([{ kind: "prep", state: "retained" }]);
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: 0, enters: 0 });
});

// ---------------------------------------------------------------------------------------------------------
// A running draft-aware seat whose binding records a session but no pane (tmux_pane NULL). The input layer
// already refuses every write to such a seat (TmuxAdapter guarded input: "Managed pane identity unavailable or
// changed; no input written"). Managed compaction now refuses it up front, before any preparation prompt or
// /compact copy, as pane_unknown_protected. (Until round 5 these two tests pinned the old behaviour: an
// indeterminate prep row, one retained /compact row per busy poll, and an indeterminate /compact row.)
// ---------------------------------------------------------------------------------------------------------

it("pane-less draft-aware seat, automatic, busy x4 then idle: refused before any preparation or /compact, no outbox row at all", async () => {
  const f = await fixture({ pane: null });
  const outcomes = [await f.e.maybeAutoCompact(input)];
  f.activity("running");
  for (let i = 0; i < 4; i++) outcomes.push(await f.e.maybeAutoCompact(input));
  f.activity("idle");
  outcomes.push(await f.e.maybeAutoCompact(input));
  expect(outcomes.every((o) => o.triggered === false && o.reason === "pane_unknown_protected")).toBe(true);
  expect(f.rows()).toEqual([]); // every outbox row, counted: none
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: 0, enters: 0 });
  expect(f.e.getPreparationState(seat)).toBeNull(); // no attempt was begun: nothing was sent
});

it("pane-less draft-aware seat, manual: refused up front as not sent, with no preparation prompt and no /compact", async () => {
  const f = await fixture({ pane: null });
  const outcome = await f.e.triggerManualCompact({ ...input, usedPercentage: 40 }, { operatorInitiated: true });
  expect(outcome).toMatchObject({ triggered: false, reason: "pane_unknown_protected" });
  expect(f.rows()).toEqual([]);
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: 0, enters: 0 });
  expect(f.e.getPreparationState(seat)).toBeNull();
});

it("a draft-aware seat with a recorded pane is not affected by the pane check", async () => {
  const auto = await fixture();
  expect(await auto.e.maybeAutoCompact(input)).toEqual({ triggered: false, reason: "guard_target_unknown" }); // the lease refusal, as before
  const manual = await fixture();
  let staged = false;
  const real = manual.transport.send.bind(manual.transport);
  vi.spyOn(manual.transport, "send").mockImplementation(async (s: string, t: string, o?: any) => { const r = await real(s, t, o); if (!staged) { staged = true; manual.stageMap(); } return r; });
  const outcome = await manual.e.triggerManualCompact({ ...input, usedPercentage: 40 }, { operatorInitiated: true });
  expect(outcome).toMatchObject({ reason: "draft_aware_lifecycle" });
  expect(manual.rows()).toEqual([{ kind: "prep", state: "delivered" }]);
});

// #2575: a seat whose empty input box OpenRig can't read used to sit unrestored, retried on every poll. After two idle
describe("managed restore uses ordinary draft defaults", () => {
  async function owedRestore(f: Awaited<ReturnType<typeof fixture>>) {
    expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
    expect(await f.e.maybeAutoCompact(input)).toEqual({ triggered: true });
    expect(f.e.getOwedRestore(seat)?.stage).toBe("restore_prompt");
  }
  it.each(["typed", "unreadable"] as const)("delivers the owed restore and audit over %s input without idle-poll counting", async kind => {
    const f = await fixture({ pane: "%1", mode: "off" }); await owedRestore(f);
    if (kind === "typed") f.draft("an unsent message");
    else vi.spyOn(f.tmux, "getPaneCursorPosition").mockResolvedValue(null);
    expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: true });
    expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: true });
    expect(f.e.getOwedRestore(seat)).toBeNull();
  });
  it("a step held as retained reads as still owed, never as gone in", async () => {
    const f = await fixture({ pane: "%1", mode: "off" });
    await owedRestore(f);
    const real = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementation(async (s: string, text: string, opts?: any) => text.includes("Please respond to this normal user message now")
      ? { ok: true, sessionName: s, sent: false, outcome: "retained", reason: "draft_input_unknown", heldInputBox: "unknown" } as any : real(s, text, opts));
    expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false });
    const owed = f.e.getOwedRestore(seat)!;
    expect(owed).toMatchObject({ stage: "restore_prompt", held: true, lastDelivery: { ok: true, outcome: "retained" } });
    expect(owed.detail).toContain("OpenRig will retry on its existing polls.");
    expect(owed.detail).not.toContain("went in");
    expect(owed.detail).not.toContain("goes in anyway");
  });

  it("reconciles its own written compact before restoring, then resumes ordinary delivery", async () => {
    const f = await fixture({ pane: "%1", mode: "off" }); const real = f.transport.send.bind(f.transport);
    let commands = 0;
    vi.spyOn(f.transport, "send").mockImplementation(async (s: string, text: string, opts?: any) => {
      if (text.startsWith("/compact")) { commands++; f.draft(text); return { ok: false, sessionName: s, sent: true, inputPhase: "written", reason: "submit_failed" } as any; }
      return real(s, text, opts);
    });
    await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
    expect(f.e.getPreparationState(seat)).toMatchObject({ compact: "uncertain" });
    const written = f.body(); expect(written).toMatch(/^\/compact /);
    const before = f.writes.length;
    for (let i = 0; i < 3; i++) expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false });
    expect(f.body()).toBe(written); expect(f.writes.length).toBe(before);
    expect(f.e.getOwedRestore(seat)).toMatchObject({ stage: "turn_boundary", held: true });
    // Even after a clear read, the final input check protects a write that appears before the paste.
    f.draft(""); f.onStage(() => f.draft(written));
    expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false });
    expect(f.body()).toBe(written); expect(f.writes.length).toBe(before);
    expect(f.e.getOwedRestore(seat)).toMatchObject({ stage: "turn_boundary", held: true });
    // External resolution of the original write, not a speculative Enter from the enforcer.
    f.onStage(() => {}); f.draft("");
    expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: true });
    f.draft("unrelated ordinary draft");
    for (let i = 0; i < 2; i++) expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: true });
    expect(commands).toBe(1); expect(f.e.getOwedRestore(seat)).toBeNull();
  });
});

// Managed input follows the ordinary product default, not an internal composer policy.
it.each(["typed", "unreadable"] as const)("default managed preparation delivers over %s input", async kind => {
  const f = await fixture({ pane: "%1", mode: "off" });
  if (kind === "typed") f.draft("an unsent message");
  else vi.spyOn(f.tmux, "getPaneCursorPosition").mockResolvedValue(null);
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({ delivery: "delivered" });
  expect(f.effects()).toMatchObject({ prepPastes: 1, compactPastes: 0, enters: 1 });
});

it("explicit transport draft refusal still protects managed preparation", async () => {
  const f = await fixture({ pane: "%1", mode: "off", refuseDraft: true });
  f.draft("an unsent message");
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({ delivery: "not_sent" });
  expect(f.writes).toEqual([]);
  expect(f.body()).toBe("an unsent message");
});

it("the managed idle wait treats only a recognized draft according to the ordinary default", async () => {
  const f = await fixture({ pane: "%1", mode: "off" }); f.draft("an unsent message");
  (f.transport as any).classifySendReadiness = async () => ({ state: "needs_input", reason: "prompt_draft", evidenceSource: "pane_heuristic" });
  expect(await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
  expect(f.effects()).toMatchObject({ prepPastes: 1, compactPastes: 1, enters: 2 });
});


it.each(["preparation", "compact"] as const)("records the %s refusal through the existing transport without content or input", async stage => {
  const f = await fixture({ pane: "%1", mode: stage === "preparation" ? "draft-aware" : "off" });
  const send = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport, "send").mockImplementation(async (s, text, opts) => {
    if (stage === "preparation") {
      vi.mocked(f.tmux.captureComposerSnapshot).mockResolvedValue({ ...frame("PRIVATE_INPUT https://private.invalid/gateway"), inMode: true });
    } else if (text.startsWith("/compact")) {
      vi.spyOn(f.transport as any, "captureInputBox").mockResolvedValue({ status: "unknown", confidence: "unknown", cursor: null,
        evidence: ["input box reads timed out"], input: { text: "PRIVATE_INPUT" }, hint: "https://private.invalid/gateway" });
      return send(s, text, { ...opts, preserveInput: true });
    }
    return send(s, text, opts);
  });
  await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  const state = f.e.getPreparationState(seat)!;
  const expected = stage === "preparation"
    ? { stage, check: "draft-aware", status: "unknown", confidence: null, reason: "pane_in_mode", timedOut: null,
      cursor: { present: true, valid: true, atEnd: false } }
    : { stage, check: "composer", status: "unknown", confidence: "unknown", reason: "read_timeout", timedOut: true,
      cursor: { present: false, valid: null, atEnd: null } };
  expect(state).toMatchObject({ inputReadFailure: expected, compact: "not_sent" });
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: stage === "preparation" ? 0 : 1, enters: stage === "preparation" ? 0 : 1 });
  const record = readFileSync(join(dirname(state.mapPath), COMPACTION_RECORD_FILE), "utf8");
  expect(JSON.parse(record)).toMatchObject({ inputReadFailure: expected });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("compactionEnforcer" as never, f.e as never); c.set("db" as never, f.db as never); await next(); });
  app.route("/api/compaction", compactionRoutes());
  const response = await app.request(`/api/compaction/state?session=${seat}`);
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(JSON.parse(body)).toMatchObject({ preparation: { inputReadFailure: expected } });
  expect(record + body).not.toMatch(/PRIVATE_INPUT|private\.invalid/);
});

it("distinguishes an opted-in composer timeout from the separate draft-aware check", async () => {
  const f = await fixture({ pane: "%1", mode: "off" });
  const send = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport as any, "captureInputBox").mockResolvedValue({ status: "unknown", confidence: "unknown", cursor: null,
    evidence: ["input box reads timed out"], input: { text: "PRIVATE_INPUT" }, suggestion: { text: "PRIVATE_SUGGESTION" }, hint: "https://private.invalid/gateway" });
  vi.spyOn(f.transport, "send").mockImplementation((s, text, opts) => send(s, text, { ...opts, preserveInput: true }));
  await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  const state = f.e.getPreparationState(seat)!;
  expect(state).toMatchObject({ delivery: "not_sent", inputReadFailure: { stage: "preparation", check: "composer", reason: "read_timeout", timedOut: true,
    status: "unknown", confidence: "unknown", cursor: { present: false, valid: null, atEnd: null } } });
  const record = readFileSync(join(dirname(state.mapPath), COMPACTION_RECORD_FILE), "utf8");
  expect(record).not.toMatch(/PRIVATE_INPUT|PRIVATE_SUGGESTION|private\.invalid/);
  expect(f.writes).toEqual([]);
});


it("retains a held completed map's compact diagnostic across record recovery", async () => {
  const f = await fixture({ pane: "%1", mode: "off" });
  await f.e.maybeAutoCompact(input); f.stageMap();
  const send = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport as any, "captureInputBox").mockResolvedValue({ status: "unknown", confidence: "unknown", cursor: null, evidence: ["cursor unavailable"] });
  vi.spyOn(f.transport, "send").mockImplementation((s, text, opts) => send(s, text, { ...opts, preserveInput: true }));
  expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false, reason: "prepared_awaiting_window" });
  const state = f.e.getPreparationState(seat)!;
  expect(state).toMatchObject({ prepared: true, compact: "not_sent", inputReadFailure: { stage: "compact", check: "composer", reason: "cursor_unavailable", timedOut: null } });
  const recordPath = join(dirname(state.mapPath), COMPACTION_RECORD_FILE);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  // A new enforcer in this process deliberately ignores this process's live record; model a predecessor daemon.
  writeFileSync(recordPath, JSON.stringify({ ...record, daemon: "previous-daemon" }));
  expect(f.recover().getPreparationState(seat)?.inputReadFailure).toEqual(state.inputReadFailure);
  expect(f.effects()).toEqual({ compactPastes: 0, prepPastes: 1, enters: 1 });
});

it("records the same diagnostic on an owed restore step without advancing it", async () => {
  const f = await fixture({ pane: "%1", mode: "off" });
  await f.e.triggerManualCompact(input, { operatorInitiated: true, skipMap: true });
  await f.e.maybeAutoCompact(input);
  expect(f.e.getOwedRestore(seat)?.stage).toBe("restore_prompt");
  const before = f.effects(), send = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport as any, "captureInputBox").mockResolvedValue({ status: "unknown", confidence: "unknown", cursor: null, evidence: ["cursor unavailable"] });
  vi.spyOn(f.transport, "send").mockImplementation((s, text, opts) => send(s, text, { ...opts, preserveInput: true }));
  await f.e.maybeAutoCompact(input);
  expect(f.e.getOwedRestore(seat)).toMatchObject({ stage: "restore_prompt", lastDelivery: { stage: "restore_prompt", reason: "draft_input_unknown",
    inputReadFailure: { check: "composer", reason: "cursor_unavailable", timedOut: null } } });
  expect(f.effects()).toEqual(before);
});

it.each([
  { state: "unknown", unknownReason: "invalid_cursor", cursor: { x: -1, y: 0, width: 80, height: 24 }, reason: "invalid_cursor", valid: false },
  { state: "unknown", unknownReason: "ambiguous_composer", reason: "ambiguous_composer", valid: null },
  { state: "unknown", unknownReason: "PRIVATE_INPUT https://private.invalid/gateway", reason: "capture_unavailable", valid: null },
])("diagnostic vocabulary excludes content and reports existing cursor validity ($reason)", ({ reason, valid, ...reading }) => {
  const safe = inputReadDiagnostic("draft-aware", { ...reading, rows: ["PRIVATE_INPUT"], suggestionRows: ["PRIVATE_SUGGESTION"], frame: "https://private.invalid/gateway" } as any);
  expect(safe).toMatchObject({ reason, cursor: { valid } });
  expect(JSON.stringify(safe)).not.toMatch(/PRIVATE_INPUT|PRIVATE_SUGGESTION|private\.invalid|rows|frame/);
});
