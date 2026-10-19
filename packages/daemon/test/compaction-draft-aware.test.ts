// A managed compaction on a seat under draft-aware delivery (#1481) must leave no held /compact row behind,
// whatever the timing. Every delivery there reserves a held outbox row first; a busy seat used to leave one
// per poll, filling the seat's held quota. Real SessionTransport, real draft-aware delivery and outbox on an
// in-memory database; the tmux adapter records commands instead of running them.
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
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

async function fixture(opts: { pane: string | null } = { pane: "%1" }) {
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
  const writes: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { writes.push(`paste:${staged}`); body = staged; }
    if (command.includes("send-keys") && command.includes("Enter")) { writes.push("enter"); body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/compact-input", bufferName: () => "compact-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async () => [{ id: "%1" } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => frame(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => frame(body).screen);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), waitForIdlePollMs: 5 });
  // Readiness is the variable under test: the pane says idle or working.
  let activity = "idle";
  (transport as any).classifySendReadiness = async () => ({ state: activity, reason: "fixture", evidenceSource: "pane_heuristic" });
  (transport as any).claudeDeliveryObservation = async () => ({ state: "unknown", detail: "fixture" });
  await guard.set("a", { mode: "draft-aware" }, "human@test", "draft-aware seat");
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
  return { db, e, transport, writes, compactRows, rows, effects, stageMap, activity: (s: string) => { activity = s; } };
}

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
