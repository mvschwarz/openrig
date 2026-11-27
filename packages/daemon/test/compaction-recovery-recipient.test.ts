// Slice 02 (0.7.25): a compaction-recovery notice reaches an agent able to act, or says plainly that no one could. An
// agent OpenRig holds positive evidence can't act (its own managed compaction is failing) is passed over on the existing
// route; a notice already with it moves on as the same row; the preparation notice carries what a recipient needs.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as humanSelection from "../src/domain/workflow-human-destination.js";
import * as queueOwner from "../src/domain/queue-owner.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { recheckHeldNotices, recordedRecoveryInability, moveNoticesFromUnableRecipient, newestCompleteMap, reportPreparationFailure, reportRestoreDeliveryFailure,
  reportRestoreUptakeUnknown } from "../src/domain/compaction-restore-notice.js";
import { ClaudeCompactionEnforcer, COMPACTION_RECORD_FILE, type PreparationFailure, type RestoreDeliveryFailure } from "../src/domain/claude-compaction-enforcer.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

const PERSON = "alice@external";
const EVIDENCE = "its own managed compaction ended 3 automatic attempts without /compact while its context stayed above the compaction threshold (latest attempt a3)";
const human = { entityId: "alice", class: "human", displayName: "Owner", address: PERSON, connectorBindings: [], prefs: {}, subscriptions: [] } as unknown as HumanFragment;
const dirs: string[] = [];

beforeEach(() => { vi.spyOn(queueOwner, "readReceivingAgentSetting").mockReturnValue({ session: null }); });
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A rig where owner delegates to writer and to reviewer, an optional receiving agent, and a queue over them. */
function world(opts: { person?: boolean; receiver?: boolean } = {}) {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const rigs = new RigRepository(db), sessions = new SessionRegistry(db), rig = rigs.createRig("rr");
  const seat = (name: string) => {
    const node = rigs.addNode(rig.id, name, { runtime: "claude-code" });
    const row = sessions.registerSession(node.id, `${name}@rr`);
    sessions.updateBinding(node.id, { tmuxSession: `${name}@rr` }); sessions.updateStatus(row.id, "running");
    return node;
  };
  const owner = seat("owner"), writer = seat("writer"), reviewer = seat("reviewer");
  rigs.addEdge(rig.id, owner.id, writer.id, "delegates_to"); rigs.addEdge(rig.id, owner.id, reviewer.id, "delegates_to");
  if (opts.receiver) { seat("receiver"); vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: "receiver@rr" }); }
  const loadHumans = () => ({ ok: true as const, entities: opts.person === false ? [] : [human] });
  if (opts.person === false) {
    vi.spyOn(humanSelection, "workflowHumanDestination").mockImplementation(() => humanSelection.resolveWorkflowHumanDestination(() => null, loadHumans));
  } else vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(PERSON);
  // Wakes are staged in the outbox, as the daemon wires it, and not delivered: these tests read who would be woken.
  const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: loadHumans });
  queue.attachOutbox(new OutboxHandler(db));
  return { db, queue };
}

const unableSet = (...seats: string[]) => (session: string) => seats.includes(session) ? EVIDENCE : null;
const prep = (sessionName: string, extra: Partial<PreparationFailure> = {}): PreparationFailure => ({ sessionName, occupantGeneration: "g1",
  attemptId: "a3", endedAttempts: 3, reason: "preparation_incomplete", mapPath: "/maps/a3/RESTORE-MAP.md", statePath: "/maps/a3/COMPACTION-STATE.json", ...extra });
const restore = (sessionName: string): RestoreDeliveryFailure => ({ sessionName, attemptId: "r1", mapPath: "/maps/r1/RESTORE-MAP.md",
  lastDelivery: { stage: "restore_prompt", at: "2026-11-26T19:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } });
const uptake = (sessionName: string) => ({ sessionName, attemptId: "u1", mapPath: "/maps/u1/RESTORE-MAP.md", doneAt: "2026-11-26T19:00:00Z", waitedMinutes: 30 });
const noticesAbout = (queue: QueueRepository, seat: string) => queue.list({ tag: "compaction", limit: 50 }).filter((row) => row.sourceSession === seat);

describe("who receives a recovery notice", () => {
  const kinds = [
    { kind: "preparation", report: (db: any, q: QueueRepository, s: string, u?: any) => reportPreparationFailure(db, q, prep(s), u) },
    { kind: "restore", report: (db: any, q: QueueRepository, s: string, u?: any) => reportRestoreDeliveryFailure(db, q, restore(s), { unable: u }) },
    { kind: "uptake", report: (db: any, q: QueueRepository, s: string, u?: any) => reportRestoreUptakeUnknown(db, q, uptake(s), u) },
  ];

  it.each(kinds)("$kind: a parent with no evidence against it stays the owner, whatever the evidence says of others", async ({ report }) => {
    const { db, queue } = world();
    try {
      await report(db, queue, "writer@rr", unableSet("reviewer@rr"));
      expect(noticesAbout(queue, "writer@rr")).toEqual([expect.objectContaining({ destinationSession: "owner@rr" })]);
    } finally { db.close(); }
  });

  it.each(kinds)("$kind: a parent whose own compaction is failing is passed over for the person, with the evidence named", async ({ report }) => {
    const { db, queue } = world();
    try {
      await report(db, queue, "writer@rr", unableSet("owner@rr"));
      const [row] = noticesAbout(queue, "writer@rr");
      expect(row).toMatchObject({ destinationSession: PERSON });
      expect(row!.summary).not.toContain("no capable");
      expect(row!.body).toContain(`owner@rr can't act on it now: ${EVIDENCE}`);
      expect(row!.body).toContain("The delegating parent owner@rr can't act now, so this notice goes to the registered person.");
      expect(row!.body).not.toContain("No eligible independent delegating parent");
    } finally { db.close(); }
  });

  it("with no person, the receiving agent takes it from an unable parent", async () => {
    const { db, queue } = world({ person: false, receiver: true });
    try {
      await reportPreparationFailure(db, queue, prep("writer@rr"), unableSet("owner@rr"));
      const [row] = noticesAbout(queue, "writer@rr");
      expect(row).toMatchObject({ destinationSession: "receiver@rr" });
      expect(row!.body).toContain("owner@rr can't act on it now");
      expect(row!.body).toContain("This is a receiver fallback, since the delegating parent owner@rr can't act now and the registered person couldn't be resolved; it isn't the person's selection.");
    } finally { db.close(); }
  });

  it.each([
    { name: "no receiving agent", receiver: false, unable: ["owner@rr"] },
    { name: "an unable receiving agent", receiver: true, unable: ["owner@rr", "receiver@rr"] },
  ])("with no person and $name, the notice says plainly that no capable recipient was established", async ({ receiver, unable }) => {
    const { db, queue } = world({ person: false, receiver });
    try {
      await reportPreparationFailure(db, queue, prep("writer@rr"), unableSet(...unable));
      const [row] = noticesAbout(queue, "writer@rr");
      expect(row).toMatchObject({ destinationSession: "owner@rr", state: "pending" });
      expect(row!.summary).toMatch(/; no capable recovery recipient$/);
      expect(row!.body).toContain("No capable recovery recipient could be established");
      expect(row!.body).toContain("That is not acceptance");
      // A later attempt's update keeps the plain statement on the row's face.
      await reportPreparationFailure(db, queue, prep("writer@rr", { attemptId: "a4", endedAttempts: 4 }), unableSet(...unable));
      expect(queue.getById(row!.qitemId)!.summary).toBe("Managed preparation for writer@rr: 4 ended unsent attempts (preparation_incomplete); no capable recovery recipient");
    } finally { db.close(); }
  });

  it("with no person and no agent at all, none is created or invented: the result says why, and the notices it holds still say so", async () => {
    const { db, queue } = world({ person: false });
    try {
      await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
      const [held] = noticesAbout(queue, "writer@rr");
      // owner, the top of the rig, fails its own preparation: nobody can receive its notice.
      const outcome = await reportPreparationFailure(db, queue, prep("owner@rr"), unableSet("owner@rr")) as { unaddressed: string };
      expect(outcome.unaddressed).toContain("No recovery recipient could be resolved, so no notice was created");
      expect(outcome.unaddressed).toContain("rig gateway participants --json"); // the person resolution's own remedy
      expect(outcome.unaddressed).toContain("rig config set agents.operator_session");
      expect(noticesAbout(queue, "owner@rr")).toEqual([]);
      expect(queue.getById(held!.qitemId)).toMatchObject({ destinationSession: "owner@rr", state: "pending" });
      expect(queue.getById(held!.qitemId)!.summary).toMatch(/; no capable recovery recipient$/);
      // Any other failure surfaces as before.
      vi.spyOn(queueOwner, "defaultResolveOrchestrator").mockImplementation(() => { throw new Error("database closed"); });
      await expect(reportPreparationFailure(db, queue, prep("reviewer@rr"), unableSet())).rejects.toThrow("database closed");
    } finally { db.close(); }
  });
});

describe("a notice already with a recipient that becomes unable", () => {
  it("moves as the same row, with its history, to the next capable recipient: pending with a wake, claimed without", async () => {
    const { db, queue } = world();
    try {
      await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
      await reportRestoreUptakeUnknown(db, queue, uptake("reviewer@rr"));
      const [pending] = noticesAbout(queue, "writer@rr"), [claimed] = noticesAbout(queue, "reviewer@rr");
      expect(pending!.destinationSession).toBe("owner@rr"); expect(claimed!.destinationSession).toBe("owner@rr");
      queue.claim({ qitemId: claimed!.qitemId, destinationSession: "owner@rr" });
      const wakesTo = (qitemId: string) => (db.prepare("SELECT destination_session AS d FROM outbox_entries WHERE audit_pointer = ?").all(qitemId) as { d: string }[]).map((r) => r.d);
      const before = { pending: wakesTo(pending!.qitemId), claimed: wakesTo(claimed!.qitemId) };
      // owner's own preparation now fails: its notice goes elsewhere, and the two it holds move on.
      await reportPreparationFailure(db, queue, prep("owner@rr"), unableSet("owner@rr"));
      expect(noticesAbout(queue, "owner@rr")).toEqual([expect.objectContaining({ destinationSession: PERSON })]);
      const moved = queue.getById(pending!.qitemId)!, movedClaimed = queue.getById(claimed!.qitemId)!;
      expect(moved).toMatchObject({ destinationSession: PERSON, state: "pending" });
      expect(moved.chainOfRecord).toContain("fallback-from:owner@rr");
      expect(movedClaimed).toMatchObject({ destinationSession: PERSON, state: "in-progress" });
      const note = queue.listTransitions(pending!.qitemId).at(-1)!.transitionNote!;
      expect(note).toContain(`owner@rr can't act on it now: ${EVIDENCE}`);
      expect(note.split(EVIDENCE)).toHaveLength(2); // the evidence is named once
      expect(queue.list({ tag: "compaction", limit: 50 })).toHaveLength(3);
      // One new wake, to the person, for the pending row only.
      expect(wakesTo(pending!.qitemId)).toEqual([...before.pending, PERSON]);
      expect(wakesTo(claimed!.qitemId)).toEqual(before.claimed);
    } finally { db.close(); }
  });

  it("a notice addressed elsewhere, or a seat with no evidence against it, moves nothing", async () => {
    const { db, queue } = world();
    try {
      await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
      const [row] = noticesAbout(queue, "writer@rr");
      const history = queue.listTransitions(row!.qitemId).length;
      moveNoticesFromUnableRecipient(db, queue, "owner@rr", unableSet());
      moveNoticesFromUnableRecipient(db, queue, "reviewer@rr", unableSet("reviewer@rr"));
      expect(queue.getById(row!.qitemId)).toMatchObject({ destinationSession: "owner@rr" });
      expect(queue.listTransitions(row!.qitemId)).toHaveLength(history);
    } finally { db.close(); }
  });

  it("with no capable recipient it stays, and says so once", async () => {
    const { db, queue } = world({ person: false });
    try {
      await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
      const [row] = noticesAbout(queue, "writer@rr");
      moveNoticesFromUnableRecipient(db, queue, "owner@rr", unableSet("owner@rr"));
      moveNoticesFromUnableRecipient(db, queue, "owner@rr", unableSet("owner@rr"));
      expect(queue.getById(row!.qitemId)).toMatchObject({ destinationSession: "owner@rr", state: "pending" });
      expect(queue.getById(row!.qitemId)!.summary).toMatch(/^Managed restore for writer@rr: [^;]*; no capable recovery recipient$/);
      const notes = queue.listTransitions(row!.qitemId).map((t) => t.transitionNote).filter((n) => n?.includes("No capable recovery recipient"));
      expect(notes).toHaveLength(1);
    } finally { db.close(); }
  });
});

describe("the poll re-checks the notices an agent holds", () => {
  it("while it can't act, a capable recipient chosen later takes them, unmarked", async () => {
    const { db, queue } = world({ person: false, receiver: true });
    vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: null });
    try {
      await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
      const [row] = noticesAbout(queue, "writer@rr");
      recheckHeldNotices(db, queue, "owner@rr", unableSet("owner@rr"));
      expect(queue.getById(row!.qitemId)!.summary).toMatch(/; no capable recovery recipient$/);
      vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: "receiver@rr" });
      recheckHeldNotices(db, queue, "owner@rr", unableSet("owner@rr"));
      const moved = queue.getById(row!.qitemId)!;
      expect(moved).toMatchObject({ destinationSession: "receiver@rr", state: "pending" });
      expect(moved.summary).not.toContain("no capable");
    } finally { db.close(); }
  });

  it("once it can act again, the ones it kept lose the mark, once", async () => {
    const { db, queue } = world({ person: false });
    try {
      await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
      const [row] = noticesAbout(queue, "writer@rr");
      recheckHeldNotices(db, queue, "owner@rr", unableSet("owner@rr"));
      expect(queue.getById(row!.qitemId)!.summary).toMatch(/; no capable recovery recipient$/);
      recheckHeldNotices(db, queue, "owner@rr", unableSet());
      const kept = queue.getById(row!.qitemId)!;
      expect(kept).toMatchObject({ destinationSession: "owner@rr", state: "pending" });
      expect(kept.summary).toMatch(/^Managed restore for writer@rr: [^;]*$/);
      expect(queue.listTransitions(row!.qitemId).at(-1)!.transitionNote)
        .toContain("Managed restore for writer@rr: owner@rr can act on it again: OpenRig no longer records its own managed compaction as failing.");
      const history = queue.listTransitions(row!.qitemId).length;
      recheckHeldNotices(db, queue, "owner@rr", unableSet());
      expect(queue.listTransitions(row!.qitemId)).toHaveLength(history);
    } finally { db.close(); }
  });
});

describe("what the preparation notice carries", () => {
  /** A seat's preparation folder: an older complete attempt, a newer complete one for another seat, and the current
   *  attempt whose map never completed. */
  function folder() {
    const root = mkdtempSync(join(tmpdir(), "s02-maps-")); dirs.push(root);
    const attempt = (id: string, session: string, complete: boolean, mtime: number) => {
      const dir = join(root, "writer", id); mkdirSync(dir, { recursive: true });
      const marker = `<!-- openrig-compaction-complete {"attemptId":"${id}"} -->`;
      writeFileSync(join(dir, COMPACTION_RECORD_FILE), JSON.stringify({ attemptId: id, session, marker }));
      writeFileSync(join(dir, "RESTORE-MAP.md"), `# map\n${complete ? marker : "(unfinished)"}\n`);
      utimesSync(join(dir, "RESTORE-MAP.md"), mtime, mtime);
      return join(dir, "RESTORE-MAP.md");
    };
    const older = attempt("a1", "writer@rr", true, 1_000);
    attempt("other", "someone-else@rr", true, 3_000);
    const current = attempt("a3", "writer@rr", false, 4_000);
    return { older, current };
  }

  it("names the newest complete map, never the unfinished one or another seat's", () => {
    const { older, current } = folder();
    expect(newestCompleteMap(current, "writer@rr")).toEqual({ mapPath: older, attemptId: "a1", writtenAt: new Date(1_000_000).toISOString() });
    expect(newestCompleteMap("/nowhere/a3/RESTORE-MAP.md", "writer@rr")).toBeNull();
  });

  it("an agent gets the context sample, the newest complete map and the existing choices, and no input is authorized", async () => {
    const { db, queue } = world();
    const { older, current } = folder();
    try {
      await reportPreparationFailure(db, queue, prep("writer@rr", { mapPath: current, context: { usedPercentage: 97, sampledAt: "2026-11-25T21:00:00Z" } }));
      const body = noticesAbout(queue, "writer@rr")[0]!.body;
      expect(body).toContain("Latest context sample: 97% used of the context window Claude Code reports, sampled 2026-11-25T21:00:00Z.");
      expect(body).toContain("wait for the next automatic attempt, though waiting has already failed 3 times");
      expect(body).toContain(`Newest complete restore map: ${older} (attempt a1, written ${new Date(1_000_000).toISOString()}).`);
      expect(body).toContain("rig compact 'writer@rr' --skip-map once");
      expect(body).toContain("an automatic attempt always needs a complete map");
      expect(body).toContain("No input is authorized by this notice.");
    } finally { db.close(); }
  });

  it("a delivered request whose map never completed is named as such", async () => {
    const { db, queue } = world();
    try {
      await reportPreparationFailure(db, queue, prep("writer@rr", { delivered: true }));
      const row = noticesAbout(queue, "writer@rr")[0]!;
      expect(row.summary).toBe("Managed preparation for writer@rr: 3 ended attempts without /compact (the latest delivered, preparation_incomplete)");
      expect(row.body).toContain("The latest attempt's preparation request was delivered, and no complete restore map followed within its window.");
    } finally { db.close(); }
  });

  it("a person gets the same choices with no local path", async () => {
    const { db, queue } = world();
    const { current } = folder();
    try {
      await reportPreparationFailure(db, queue, prep("writer@rr", { mapPath: current }), unableSet("owner@rr"));
      const row = noticesAbout(queue, "writer@rr")[0]!;
      expect(row.destinationSession).toBe(PERSON);
      expect(row.body).toContain("newest complete restore map, from attempt a1");
      expect(row.body).toContain("Latest context sample: unknown.");
      expect(row.body).toContain("--skip-map once");
      expect(row.body).not.toContain(dirs[0]!);
    } finally { db.close(); }
  });
});


it.each([
  { root: "home", replaced: false }, { root: "workspace", replaced: false }, { root: "policy", replaced: false },
  { root: "home", replaced: true }, { root: "workspace", replaced: true }, { root: "policy", replaced: true },
])("reads the recipient's $root failure record before its first restart poll, replaced=$replaced", async ({ root, replaced }) => {
  const { db, queue } = world();
  const home = mkdtempSync(join(tmpdir(), "recipient-restart-")); dirs.push(home);
  let clock = 10000, generation = "g1";
  const cwd = root === "workspace" ? join(home, "workspace") : null;
  if (cwd) { mkdirSync(cwd); db.prepare("UPDATE nodes SET cwd = ? WHERE logical_id = 'owner'").run(cwd); }
  const input = { sessionName: "owner@rr", runtime: "claude-code", usedPercentage: 90, cwd };
  const transport = { send: vi.fn(async () => { clock++; return { ok: false, sent: false, inputPhase: "not_reached", reason: "draft_input_busy" }; }),
    waitUntilIdle: vi.fn(async () => ({ ok: true })) };
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a map.", compactInstruction: "",
    ...(root === "policy" ? { preparationRoot: join(home, "configured") } : {}) };
  const make = (daemonInstance: string): ClaudeCompactionEnforcer => new ClaudeCompactionEnforcer(
    { resolveClaudeCompactionPolicy: () => policy } as any, transport as any,
    { openrigHome: home, now: () => clock, daemonInstance, resolveOccupantGeneration: () => generation, autoRetryAfterStopMs: 1,
      onPreparationFailure: (failure) => reportPreparationFailure(db, queue, failure, s => recordedRecoveryInability(db, enforcer, s)) });
  let enforcer = make("before");
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let ended = false;
      for (let poll = 0; poll < 4; poll++) {
        await enforcer.maybeAutoCompact(input);
        if (enforcer.getPreparationState(input.sessionName)?.status === "stopped") { ended = true; clock += 2; break; }
      }
      expect(ended).toBe(true);
    }
    await enforcer.maybeAutoCompact(input);
    expect(enforcer.recoveryInability(input.sessionName)).not.toBeNull();
    expect(noticesAbout(queue, input.sessionName)).toHaveLength(1);
    enforcer = make("after");
    if (replaced) generation = "g2";
    const sends = transport.send.mock.calls.length;
    await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"), { unable: s => recordedRecoveryInability(db, enforcer, s) });
    const [row] = noticesAbout(queue, "writer@rr");
    expect(row!.destinationSession).toBe(replaced ? "owner@rr" : PERSON);
    expect(transport.send).toHaveBeenCalledTimes(sends);
  } finally { db.close(); }
});

it("end to end: an unable top agent nobody can receive from says why in its state, and its held notice moves once a receiver is chosen", async () => {
  const { db, queue } = world({ person: false, receiver: true });
  vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: null });
  const home = mkdtempSync(join(tmpdir(), "recipient-none-")); dirs.push(home);
  let clock = 10000;
  const input = { sessionName: "owner@rr", runtime: "claude-code", usedPercentage: 90, cwd: null };
  const transport = { send: vi.fn(async () => { clock++; return { ok: false, sent: false, inputPhase: "not_reached", reason: "draft_input_busy" }; }),
    waitUntilIdle: vi.fn(async () => ({ ok: true })) };
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a map.", compactInstruction: "" };
  const unable = (s: string) => recordedRecoveryInability(db, enforcer, s);
  const enforcer: ClaudeCompactionEnforcer = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport as any,
    { openrigHome: home, now: () => clock, resolveOccupantGeneration: () => "g1", autoRetryAfterStopMs: 1,
      onPreparationFailure: (failure) => reportPreparationFailure(db, queue, failure, unable),
      onHeldNoticesRecheck: (s) => recheckHeldNotices(db, queue, s, unable) });
  try {
    await reportRestoreDeliveryFailure(db, queue, restore("writer@rr"));
    const [held] = noticesAbout(queue, "writer@rr");
    expect(held!.destinationSession).toBe("owner@rr");
    for (let attempt = 0; attempt < 3; attempt++) {
      let ended = false;
      for (let poll = 0; poll < 4; poll++) {
        await enforcer.maybeAutoCompact(input);
        if (enforcer.getPreparationState(input.sessionName)?.status === "stopped") { ended = true; clock += 2; break; }
      }
      expect(ended).toBe(true);
    }
    await enforcer.maybeAutoCompact(input);
    expect(noticesAbout(queue, "owner@rr")).toEqual([]);
    expect(enforcer.getPreparationNotice("owner@rr")).toEqual({ status: "not_addressed",
      failure: expect.stringContaining("ended 3 automatic attempts without /compact"),
      detail: expect.stringContaining("No recovery recipient could be resolved, so no notice was created") });
    expect(queue.getById(held!.qitemId)).toMatchObject({ destinationSession: "owner@rr", state: "pending" });
    expect(queue.getById(held!.qitemId)!.summary).toMatch(/; no capable recovery recipient$/);
    // A receiving agent is chosen afterwards: the next poll moves the held notice to it, unmarked, with no new attempt counted.
    vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: "receiver@rr" });
    await enforcer.maybeAutoCompact(input);
    expect(queue.getById(held!.qitemId)).toMatchObject({ destinationSession: "receiver@rr", state: "pending" });
    expect(queue.getById(held!.qitemId)!.summary).not.toContain("no capable");
  } finally { db.close(); }
});
