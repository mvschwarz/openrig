import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// The terminal structure and warning text are retained from Claude 2.1.220 captures.
// Conversation/paths are omitted. The weekly-limit full screen was captured BEFORE
// down, not inside the failed resumed send; that attempt retained only its footer.
const update = "✘ Auto-update failed: no write permission to npm prefix · Run claude doctor";
const focus = "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and re…";
const weekly = "You've used 96% of your weekly limit · resets 12pm (UTC)";
const bar = "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
const border = "────────────────────────────────────────────────────────────────────────────────";
function pane(trailers: string[], composer = "❯\u00a0", before = "● Ready.\n\n✻ Crunched for 2s") {
  return [before, "", border, composer, border, `  ${bar}`, ...trailers.map(line => `  ${line}`), ""].join("\n");
}
const captures = [
  ["upgrade post-refusal focus warning", pane([update, focus])],
  ["fresh pre-down weekly warning", pane([update, weekly])],
  ["fresh post-refusal update warning", pane([update])],
] as const;

// Observed Claude 2.1.282 rows plus the previously supported thinking shape.
// An empty composer remains visible mid-turn.
const workingRows = [
  "✻ Onioning… (2m 38s · ↓ 10.9k tokens · thought for 8s)",
  "· Onioning… (1m 44s · ↓ 6.6k tokens)",
  "✶ Thinking… (6s · ↑ 284 tokens · thinking)",
];
const workingCaptures = workingRows.flatMap((row, i) => [
  [`timed work ${i} / no warning`, pane([], "❯\u00a0", row)],
  [`timed work ${i} / weekly`, pane([weekly], "❯\u00a0", row)],
  [`timed work ${i} / focus`, pane([update, focus], "❯\u00a0", row)],
  [`timed work ${i} / update`, pane([update], "❯\u00a0", row)],
]);
workingCaptures.push(["live status above a task list", pane([update, focus], "❯\u00a0", [
  workingRows[0], ...Array.from({ length: 7 }, (_, i) => `  □ Pending task ${i + 1}`),
].join("\n"))]);

// Constructed footer substitutions/task lists; no native task-count bound is known.
const otherBars = [
  "⏵⏵ bypass permissions on (shift+tab to cycle)",
  "⏸ plan mode on (shift+tab to cycle)",
  "? for shortcuts",
  "custom mode hint",
];
const incompleteBlocks = [[], [update], [update, focus], [update, focus, weekly]].map((suffix) => [
  `${suffix.length} warnings`, pane(suffix, "❯\u00a0", [workingRows[0],
    ...Array.from({ length: 21 }, (_, i) => `  □ Pending task ${i + 1}`)].join("\n")),
]);
for (const hint of otherBars) incompleteBlocks.push([
  `tall block / ${hint}`, incompleteBlocks[0]![1]!.replace(bar, hint),
]);
const alternateWorking = otherBars.map(hint => [hint, pane([], "❯\u00a0", workingRows[0]).replace(bar, hint)]);

// Constructed multiline drafts, not native captures. Indentation distinguishes
// continuation text from the actual input box's border and first prompt column.
const nestedDrafts = [
  ["indented separator and literal prompt", pane([update, focus], `❯ unfinished review draft\n  ${border}\n  ❯\u00a0`)],
  ["short indented separator and literal prompt", pane([update, weekly], "❯ unfinished review draft\n  ───\n  ❯\u00a0")],
];

describe("Claude composer below noninteractive status warnings", () => {
  it.each(captures)("recognizes the empty composer: %s", (_name, content) => {
    expect(classifyPaneActivity(content)).toMatchObject({ state: "agent_idle", reason: "idle_prompt", evidence: "❯" });
  });

  it.each(nestedDrafts)("does not read draft continuations as a new empty input: %s", async (_name, content) => {
    expect(classifyPaneActivity(content).state).not.toBe("agent_idle");
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect((await service.pollSeat("seat@rig"))?.state).not.toBe("agent_idle");
  });

  it("does not confuse completed prompt history with a current draft", () => {
    expect(classifyPaneActivity(pane([update, focus], "❯\u00a0", "❯ previous user request\n● Completed response.")))
      .toMatchObject({ state: "agent_idle", reason: "idle_prompt" });
  });

  it.each(workingCaptures)("keeps current work ahead of the empty composer: %s", async (_name, content) => {
    expect(classifyPaneActivity(content)).toMatchObject({ state: "agent_active", reason: "mid_work_pattern" });
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect(await service.pollSeat("seat@rig")).toMatchObject({ state: "agent_active", reason: "mid_work_pattern" });
  });

  it.each([[], [update], [update, focus], [update, weekly]])("keeps completed work idle with suffix %j", (...trailers) => {
    const suffix = trailers as string[];
    for (const before of ["● Ready.", "✻ Crunched for 2s", `${workingRows[0]}\n● Completed response.\n✻ Crunched for 2s`, `${workingRows[2]}\n● Ready.`]) {
      expect(classifyPaneActivity(pane(suffix, "❯\u00a0", before)).state).toBe("agent_idle");
    }
  });

  it("does not infer completion when the status head is outside the scan", () => {
    const content = pane([update], "❯\u00a0", [workingRows[0], ...Array.from({ length: 21 }, () => "  prior output")].join("\n"));
    expect(classifyPaneActivity(content).state).toBe("unknown");
  });

  it.each([[update], [focus], [weekly], [update, focus], [update, focus, weekly]])("requires a complete input frame for warning-suffixed idle: %j", (...trailers) => {
    for (const before of ["● Ready.", "✻ Crunched for 2s", `${workingRows[0]}\n● Completed response.`]) {
      const framed = pane(trailers as string[], "❯\u00a0", before);
      expect(classifyPaneActivity(framed).state).toBe("agent_idle");
      expect(classifyPaneActivity(framed.replaceAll(border, "")).state).toBe("unknown");
    }
  });

  it("preserves a uniformly indented input block without mistaking its columns", () => {
    const indent = (content: string) => content.split("\n").map(line => `  ${line}`).join("\n");
    expect(classifyPaneActivity(indent(pane([update]))).state).toBe("agent_idle");
    expect(classifyPaneActivity(indent(pane([], "❯\u00a0", workingRows[0]))).state).toBe("agent_active");
  });

  it.each(incompleteBlocks)("keeps an incomplete status block unknown: %s", async (_name, content) => {
    expect(classifyPaneActivity(content)).toMatchObject({ state: "unknown", reason: "no_activity_signal" });
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect((await service.pollSeat("seat@rig"))?.state).toBe("unknown");
  });

  it.each(alternateWorking)("recognizes work independently of the mode hint: %s", async (_name, content) => {
    expect(classifyPaneActivity(content).state).toBe("agent_active");
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect((await service.pollSeat("seat@rig"))?.state).toBe("agent_active");
  });

  it.each(otherBars)("keeps completed work idle under mode hint %s", (hint) => {
    for (const before of ["● Ready.", "✻ Crunched for 2s", `${workingRows[0]}\n● Ready.`]) {
      expect(classifyPaneActivity(pane([], "❯\u00a0", before).replace(bar, hint)).state).toBe("agent_idle");
    }
  });

  it.each([...otherBars, bar])("recognizes a live timer on the unframed prompt path: %s", (hint) => {
    expect(classifyPaneActivity(`${workingRows[0]}\n❯ \n${hint}`).state).toBe("agent_active");
  });

  it.each([otherBars[0]!, otherBars[1]!, otherBars[2]!, bar])("keeps the unframed current block ahead of %s", (hint) => {
    for (const tasks of [0, 7, 13, 17, 18, 21]) {
      const content = [workingRows[0], ...Array.from({ length: tasks }, (_, i) => `  □ Pending task ${i}`), "❯ ", hint].join("\n");
      expect(classifyPaneActivity(content).state).toBe(tasks <= 17 ? "agent_active" : "unknown");
    }
    // A completed/newer output ends the block; a bare prompt has no task block.
    for (const before of ["", "● Ready.\n", "✻ Crunched for 2s\n", `${workingRows[0]}\n● Completed response.\n`]) {
      expect(classifyPaneActivity(`${before}❯ \n${hint}`).state).toBe("agent_idle");
    }
  });

  it.each([
    ["draft", pane([update, focus], "❯ unfinished message")],
    ["permission", pane([update, focus], "❯\u00a0", "Do you want to proceed?\n❯ 1. Yes\n  2. No")],
    ["working", pane([update, focus], "❯\u00a0", "✶ Thinking… (6s · ↑ 284 tokens · thinking)")],
    ["spinner", pane([update, focus], "❯\u00a0", "⠋ Processing")],
    ["interrupt", pane([update, weekly], "❯\u00a0", "esc to interrupt")],
    ["multiline draft", pane([update, focus], "❯\u00a0\n  unfinished second line")],
    ["no input border", pane([update, focus]).replaceAll(border, "")],
    ["mode and warning only", `${bar}\n${update}`],
    ["history followed by another screen", `${pane([update, focus])}\nShell output\n$`],
    ["warning only", `${update}\n${focus}`],
    ["no mode bar", pane([update, focus]).replace(bar, "custom status")],
    ["no composer", pane([update, focus]).replace("❯\u00a0", "")],
    ["later output", `${pane([update, focus])}\nLater output with no current composer`],
    ["blocking limit", pane([update, "You've hit your limit · /upgrade"])],
    ["exhausted weekly limit", pane([update, weekly.replace("96%", "100%")])],
    ["unrelated suffix", pane([update, "Proceed with the operation?"])],
    ["login", pane([update, "Not logged in · Run /login"])],
  ])("does not invent idle from %s", (_name, content) => {
    expect(classifyPaneActivity(content).state).not.toBe("agent_idle");
  });

  it("reports a draft as attention rather than using its mode bar", () => {
    expect(classifyPaneActivity(pane([update, focus], "❯ unfinished message")))
      .toMatchObject({ state: "attention", reason: "prompt_draft" });
  });

  it.each(captures)("shares recognition with the structural-activity consumer: %s", async (_name, content) => {
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect(await service.pollSeat("seat@rig")).toMatchObject({ state: "agent_idle", reason: "idle_prompt" });
  });

  it("keeps structural draft and warning-only observations unsendable", async () => {
    for (const content of [pane([update, focus], "❯ unfinished message"), focus]) {
      const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
      expect((await service.pollSeat("seat@rig"))?.state).not.toBe("agent_idle");
    }
  });
});

// #808: Claude's other permission-mode footers above the same warning rows. The bypass and
// background-shell rows are native captures from Claude seats on 2026-10-05; the auto rows are
// quoted from the #808 report (Claude 2.1.289, the second with vim's insert prefix).
const modeBars = [
  ["bypass, background shell (native)", "⏵⏵ bypass permissions on · 1 shell · ← for agents"],
  ["bypass (native)", "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"],
  ["accept edits, background shell (native)", "⏵⏵ accept edits on · 1 shell · ← for agents"],
  ["auto", "⏵⏵ auto mode on (shift+tab to cycle)"],
  ["auto, vim insert prefix", "-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)"],
  ["plan", "⏸ plan mode on (shift+tab to cycle)"],
  ["default", "? for shortcuts"],
] as const;
const warningSets = [[update], [focus], [weekly], [update, focus]];
function modePane(hint: string, trailers: string[], composer = "❯ ", before = "● Ready.\n\n✻ Crunched for 2s") {
  return pane(trailers, composer, before).replace(bar, hint);
}

describe("#808: Claude permission-mode footers below status warnings", () => {
  it.each(modeBars)("reads an empty framed composer as idle: %s", async (_name, hint) => {
    for (const trailers of warningSets) {
      const content = modePane(hint, trailers);
      expect(classifyPaneActivity(content)).toMatchObject({ state: "agent_idle", reason: "idle_prompt", evidence: "❯" });
      const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
      expect(await service.pollSeat("seat@rig")).toMatchObject({ state: "agent_idle", reason: "idle_prompt" });
    }
  });

  it.each(modeBars)("keeps current work active: %s", (_name, hint) => {
    for (const trailers of [[], ...warningSets]) for (const row of workingRows) {
      expect(classifyPaneActivity(modePane(hint, trailers, "❯ ", row)))
        .toMatchObject({ state: "agent_active", reason: "mid_work_pattern" });
    }
  });

  it.each(modeBars)("keeps a question as attention: %s", (_name, hint) => {
    for (const trailers of [[], ...warningSets]) {
      expect(classifyPaneActivity(modePane(hint, trailers, "❯ ", "Do you want to proceed?\n❯ 1. Yes\n  2. No")).state)
        .toBe("attention");
    }
  });

  // A warning-suffixed draft stays unknown: reporting it as attention (needs_input) would be a new
  // send refusal for these modes. Only the exact accept-edits footer keeps its existing attention.
  it.each(modeBars)("never reads a warning-suffixed draft as idle and adds no refusal: %s", (_name, hint) => {
    for (const trailers of warningSets) {
      expect(classifyPaneActivity(modePane(hint, trailers, "❯ unfinished message")).state).toBe("unknown");
      expect(classifyPaneActivity(modePane(hint, trailers, "❯ \n  unfinished second line")).state).toBe("unknown");
    }
  });

  it.each(modeBars)("still requires the complete input frame: %s", (_name, hint) => {
    expect(classifyPaneActivity(modePane(hint, [update, focus]).replaceAll(border, "")).state).toBe("unknown");
  });
});

describe("first guarded Claude send with retained warning-shaped composer", () => {
  let db: Database.Database | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  function setup(content: string, event = "SessionStart", ageMs = 16_000, priorGeneration = false) {
    db = createFullTestDb();
    const repo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = repo.createRig("footer-test");
    const node = repo.addNode(rig.id, "worker.a", { runtime: "claude-code", role: "worker" });
    const name = "worker-a@footer-test";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const prior = registry.currentOccupantTenure(node.id)!.generationUuid;
    const generation = priorGeneration
      ? registry.mintOccupantTenure(node.id, "handover").generationUuid
      : prior;
    const now = new Date("2026-10-04T19:20:00Z");
    const store = new AgentActivityStore({
      db, eventBus: new EventBus(db), now: () => now,
      resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, value) => Boolean(db!.prepare(
        "SELECT 1 FROM occupant_tenures WHERE node_id = ? AND generation_uuid = ?"
      ).get(id, value)),
    });
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: name,
      hookEvent: event, subtype: event === "SessionStart" ? "resume" : undefined,
      occurredAt: new Date(now.getTime() - ageMs).toISOString(),
      generation: priorGeneration ? prior : generation,
    }).ok).toBe(true);
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      capturePaneContent: async () => content,
      getPaneCommand: async () => "claude",
      listPanes: async () => [], getPanePid: async () => null,
      sendText, sendKeys,
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry,
      tmuxAdapter: tmux, agentActivityStore: store, now: () => now, sleep: async () => undefined, waitForIdlePollMs: 1 });
    return { transport, store, name, sendText, sendKeys };
  }

  it.each(captures)("sends once from current pane after SessionStart freshness: %s", async (_name, content) => {
    const f = setup(content);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 200 });
    expect(result).toMatchObject({ ok: true, sent: true, activity: { state: "idle", evidenceSource: "pane_heuristic" } });
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledWith(f.name, ["Enter"]);
    // No synthetic Stop or state rewrite is needed to admit the current pane.
    expect(f.store.getLatestForNode({ sessionName: f.name })).toMatchObject({ state: "unknown", rawEvent: "SessionStart", stale: false });
  });

  it.each(nestedDrafts)("leaves multiline draft untouched: %s", async (_name, content) => {
    const f = setup(content);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.sendKeys).not.toHaveBeenCalled();
  });

  it.each(workingCaptures)("explicit wait does not send into current work: %s", async (_name, content) => {
    const f = setup(content);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
    expect(result).toMatchObject({ ok: false, sent: false, activity: { state: "running", reason: "mid_work_pattern" } });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.sendKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["working without warnings", pane([], "❯\u00a0", workingRows[0]), "mid-task"],
    ["working with warnings", pane([update, focus], "❯\u00a0", workingRows[1]), "mid-task"],
    ["unknown activity", "unrecognized output", "activity could not be determined"],
  ])("ordinary send still proceeds with an advisory: %s", async (_name, content, advisory) => {
    const f = setup(content);
    const result = await f.transport.send(f.name, "ordinary marker");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain(advisory);
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret the existing display-fresh idle hook branch", async () => {
    const f = setup(pane([], "❯\u00a0", workingRows[0]), "Stop", 16_000);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
    expect(result).toMatchObject({ ok: true, sent: true, activity: { state: "idle", evidenceSource: "runtime_hook" } });
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });

  it.each([...incompleteBlocks, ...alternateWorking])("explicit wait preserves input for %s", async (_name, content) => {
    const f = setup(content);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.sendKeys).not.toHaveBeenCalled();
  });

  it.each(modeBars)("#808: explicit wait sends once into an idle composer: %s", async (_name, hint) => {
    const f = setup(modePane(hint, [update, focus]));
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 200 });
    expect(result).toMatchObject({ ok: true, sent: true, activity: { state: "idle", evidenceSource: "pane_heuristic" } });
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it.each(modeBars)("#808: explicit wait leaves a draft and current work untouched: %s", async (_name, hint) => {
    for (const content of [modePane(hint, [update, focus], "❯ unfinished message"), modePane(hint, [update, focus], "❯ ", workingRows[0])]) {
      const f = setup(content);
      const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
      expect(result).toMatchObject({ ok: false, sent: false });
      expect(f.sendText).not.toHaveBeenCalled();
      expect(f.sendKeys).not.toHaveBeenCalled();
      db?.close(); db = undefined;
    }
  });

  it("ordinary send still advises and proceeds on an incomplete status block", async () => {
    const f = setup(incompleteBlocks[0]![1]!);
    const result = await f.transport.send(f.name, "ordinary marker");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("activity could not be determined");
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["fresh SessionStart", "SessionStart", 1000, captures[0][1], false],
    ["fresh permission hook", "PermissionRequest", 1000, captures[0][1], false],
    ["fresh working hook", "UserPromptSubmit", 1000, captures[0][1], false],
    ["prior-generation Stop without current pane evidence", "Stop", 1000, focus, true],
  ] as const)("keeps %s from authorizing input", async (_name, event, age, content, prior) => {
    const f = setup(content, event, age, prior);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.sendKeys).not.toHaveBeenCalled();
    if (prior) expect(f.store.getLatestForNode({ sessionName: f.name })).toMatchObject({ state: "unknown", reason: "generation_mismatch", stale: true });
  });
});
