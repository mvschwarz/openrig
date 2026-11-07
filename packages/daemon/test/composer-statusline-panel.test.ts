import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, classifyPaneActivity, inspectComposerInput } from "../src/domain/session-transport.js";

// #2700: Claude draws two things outside its input box that the draft-aware guard did not recognize, so every idle read
// was unknown and each wake was held as draft_input_unknown:
//   F1, a user statusLine between the box's closing rule and the "⏵⏵" mode footer;
//   F2, the background task panel ("  ◯ name …") below the mode footer.
// Both screens are real captures (capture-pane -e -p), cropped as their provenance says; F2's cursor was captured with
// it, F1's is placed on its prompt row. Variations
// are edited here from the fixture's own screen, each with a comment; the fixture files stay as captured.
const load = (name: string): ComposerSnapshot & { provenance: string } =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const F1 = load("claude-statusline-composer.json");
const F2 = load("claude-task-panel-composer.json");

// Row indexes in both cropped screens: 2 top rule, 3 "❯", 4 closing rule; F1: 5 statusLine, 6 mode footer;
// F2: 5 mode footer, 6 blank, 7 and 8 the two "◯" task rows.
const PROMPT_ROW = 3;
const PROMPT = "\x1b[39m❯\xa0";

/** A copy of a fixture whose screen rows are edited by `change`; the cursor fields given replace the captured ones. */
function edit(base: ComposerSnapshot, change: (rows: string[]) => void = () => {}, cursor: Partial<ComposerSnapshot["cursor"]> = {}): ComposerSnapshot {
  const rows = base.screen.split("\n");
  change(rows);
  return { screen: rows.join("\n"), cursor: { ...base.cursor, ...cursor }, inMode: base.inMode };
}
/** The fixture with `text` typed on its prompt row and the cursor after it. */
const typed = (base: ComposerSnapshot, text: string) =>
  edit(base, rows => { rows[PROMPT_ROW] = `${PROMPT}${text}`; }, { x: 2 + [...text].length });
const plain = (screen: string) => screen.replace(/\x1b\[[0-9;:]*m/g, "");
const unrecognized = { state: "unknown", unknownReason: "unrecognized_composer" };
const RUNTIMES = [null, "claude-code"] as const;

describe("Claude composer with a statusLine outside the box (#2700, F1)", () => {
  it("case 0: keeps the captured fixtures as described", () => {
    expect(F1.cursor).toEqual({ x: 2, y: PROMPT_ROW, width: 105, height: 80 });
    expect(F2.cursor).toEqual({ x: 2, y: PROMPT_ROW, width: 80, height: 24 });
    expect(plain(F1.screen).split("\n")[5]).toMatch(/^ {2}Opus /);
    expect(plain(F1.screen).split("\n")[6]).toMatch(/^ {2}⏵⏵ bypass permissions on/);
    expect(plain(F2.screen).split("\n").slice(7, 9).every(row => /^ {2}◯ \S/.test(row))).toBe(true);
  });

  it.each(RUNTIMES)("case 1: reads the captured idle composer as empty (runtime %s)", runtime => {
    expect(inspectComposerInput(F1, runtime)).toMatchObject({ state: "empty", rows: [""] });
  });

  it.each(RUNTIMES)("case 2: reads a draft on the prompt row as text (runtime %s)", runtime => {
    // Edited: "abc" typed on the captured prompt row.
    expect(inspectComposerInput(typed(F1, "abc"), runtime)).toMatchObject({ state: "text", rows: ["abc"], cursorAtEnd: true });
  });

  it.each(RUNTIMES)("case 3: reads a collapsed paste as text with its label (runtime %s)", runtime => {
    // Edited: Claude's collapsed paste label on the captured prompt row.
    expect(inspectComposerInput(typed(F1, "[Pasted text #1 +12 lines]"), runtime))
      .toMatchObject({ state: "text", collapsedPaste: "[Pasted text #1 +12 lines]" });
  });

  it.each(RUNTIMES)("case 4: reads a multiline draft with two indented continuation rows (runtime %s)", runtime => {
    // Edited: a three-row draft, its two continuation rows indented to the prompt text, cursor at its end.
    const draft = edit(F1, rows => { rows.splice(PROMPT_ROW, 1, `${PROMPT}first row`, "  second row", "  third row"); }, { x: 2 + "third row".length, y: PROMPT_ROW + 2 });
    expect(inspectComposerInput(draft, runtime)).toMatchObject({ state: "text", rows: ["first row", "second row", "third row"], cursorAtEnd: true });
  });

  it.each(RUNTIMES)("case 4: keeps a continuation row at column 0 unrecognized (runtime %s)", runtime => {
    // Edited: the same draft with its second row unindented, which Claude never draws inside its box.
    const draft = edit(F1, rows => { rows.splice(PROMPT_ROW, 1, `${PROMPT}first row`, "second row", "  third row"); }, { x: 2 + "third row".length, y: PROMPT_ROW + 2 });
    expect(inspectComposerInput(draft, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 5: reads the empty composer under two statusLine rows and a blank row (runtime %s)", runtime => {
    // Edited: a blank row and a second statusLine row between the captured statusLine and the mode footer.
    const tall = edit(F1, rows => { rows.splice(6, 0, "", "  \x1b[36msecond status row\x1b[39m · 42 items"); });
    expect(inspectComposerInput(tall, runtime)).toMatchObject({ state: "empty", rows: [""] });
  });

  it.each(RUNTIMES)("case 6: keeps a statusLine that is itself a rule unrecognized (runtime %s)", runtime => {
    // Edited: the statusLine row replaced by a full-width rule.
    const ruled = edit(F1, rows => { rows[5] = "─".repeat(105); });
    expect(inspectComposerInput(ruled, runtime)).toMatchObject(unrecognized);
  });
});

describe("Claude composer with the background task panel below its footer (#2700, F2)", () => {
  it.each(RUNTIMES)("case 7: reads the captured idle composer as empty (runtime %s)", runtime => {
    expect(inspectComposerInput(F2, runtime)).toMatchObject({ state: "empty", rows: [""] });
  });

  it.each(RUNTIMES)("case 7: reads a draft above the task panel as text (runtime %s)", runtime => {
    // Edited: "abc" typed on the captured prompt row.
    expect(inspectComposerInput(typed(F2, "abc"), runtime)).toMatchObject({ state: "text", rows: ["abc"], cursorAtEnd: true });
  });

  it.each(RUNTIMES)("case 7: reads the empty composer when the panel opens with a \"●\" row above its \"◯\" rows (runtime %s)", runtime => {
    // Edited: the panel's optional "●" title row, as another seat drew it, above the captured "◯" rows.
    const titled = edit(F2, rows => { rows.splice(7, 0, "  ● main task title"); });
    expect(inspectComposerInput(titled, runtime)).toMatchObject({ state: "empty" });
  });

  it.each(RUNTIMES)("case 8: keeps a panel row with an unknown glyph unrecognized (runtime %s)", runtime => {
    // Edited: the second task row replaced by an unknown glyph.
    const odd = edit(F2, rows => { rows[8] = "  ◆ x"; });
    expect(inspectComposerInput(odd, runtime)).toMatchObject(unrecognized);
  });

  it.each([
    ["at column 0", "◯ draft-task-name-number"],
    ["indented four columns", "    ◯ draft-task-name-number"],
  ])("case 8: keeps a task row %s unrecognized", (_label, row) => {
    for (const runtime of RUNTIMES) {
      // Edited: the first task row redrawn off the panel's two-column indent, which Claude does not draw.
      const shifted = edit(F2, rows => { rows[7] = row; });
      expect(inspectComposerInput(shifted, runtime)).toMatchObject(unrecognized);
    }
  });

  it.each(RUNTIMES)("case 8: keeps a \"●\" row that is not right above a \"◯\" row unrecognized (runtime %s)", runtime => {
    // Edited: a "●" title row with a blank row between it and the captured "◯" rows.
    const apart = edit(F2, rows => { rows.splice(7, 0, "  ● main task title", ""); });
    expect(inspectComposerInput(apart, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 9: does not skip panel-shaped rows without a mode footer above them (runtime %s)", runtime => {
    // Edited: the mode footer replaced by a row that is not one.
    const footless = edit(F2, rows => { rows[5] = "  some other row"; });
    expect(inspectComposerInput(footless, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 9: does not skip panel-shaped rows below an unrecognized row under the footer (runtime %s)", runtime => {
    // Edited: an unrecognized row between the mode footer and the panel, so the panel has no footer right above it.
    const between = edit(F2, rows => { rows.splice(6, 0, "  some other row"); });
    expect(inspectComposerInput(between, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 9b: reads the empty composer with the update banner between the footer and the panel (runtime %s)", runtime => {
    // Edited: Claude's own-row update banner (#2605) right under the mode footer, above the blank row and the panel.
    const banner = edit(F2, rows => { rows.splice(6, 0, "✔ Update installed · Restart to update"); });
    expect(inspectComposerInput(banner, runtime)).toMatchObject({ state: "empty" });
  });

  it.each(RUNTIMES)("case 9c: leaves Claude's effort row under the footer as it was, without a \"◯\" row (runtime %s)", runtime => {
    // Edited: the panel replaced by Claude 2.1.220's effort row right under the mode footer. It is not a task panel,
    // so it is not skipped and the read stays what it was before the panel was recognized.
    const effort = edit(F2, rows => { rows.splice(6, 3, "  ● high · /effort", ""); });
    expect(inspectComposerInput(effort, runtime)).toMatchObject(unrecognized);
  });
});

// Case 10, the #2605 banner and its near misses, the nested prompt and the warning-footer matrix, stays covered by
// composer-input.test.ts and claude-warning-footer-readiness.test.ts; case 13, readSeatBeforePaste staying unknown with a
// statusLine, by input-box-reading.test.ts. They run in the same focused command and are not repeated here.

describe("Claude composer edges next to the box (#2700)", () => {
  it.each(RUNTIMES)("case 14: keeps a \"❯ item\" row drawn right under the closing rule unrecognized (runtime %s)", runtime => {
    // Edited: a "❯ item" row and a rule under the captured box, as a panel opening under it would draw them, with the
    // cursor on that row. Its top rule is the box's closing rule, so it is not a composer of its own.
    const below = edit(F1, rows => { rows.splice(5, 0, `${PROMPT}item`, "─".repeat(105)); }, { x: 2 + "item".length, y: 5 });
    expect(inspectComposerInput(below, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 14: keeps the same \"❯ item\" row unrecognized when nothing sits above the footer (runtime %s)", runtime => {
    // Edited: as above, with the statusLine row removed, so the lower rule sits right above the mode footer.
    const below = edit(F1, rows => { rows.splice(5, 1, `${PROMPT}item`, "─".repeat(105)); }, { x: 2 + "item".length, y: 5 });
    expect(inspectComposerInput(below, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 14: keeps a \"❯ item\" row unrecognized under a box holding a two-row draft (runtime %s)", runtime => {
    // Edited: the captured box holds a two-row draft, and a "❯ item" row and a rule open right under its closing rule,
    // with the cursor on that row. The upper prompt is two rows above the closing rule, not one.
    const below = edit(F1, rows => {
      rows.splice(PROMPT_ROW, 1, `${PROMPT}first`, "  second");
      rows.splice(6, 0, `${PROMPT}item`, "─".repeat(105));
    }, { x: 2 + "item".length, y: 6 });
    expect(inspectComposerInput(below, runtime)).toMatchObject(unrecognized);
  });

  it.each(RUNTIMES)("case 1b: keeps the composer unrecognized with the cursor on the statusLine row (runtime %s)", runtime => {
    // Edited: only the cursor, moved off the prompt row onto the statusLine row below the box.
    expect(inspectComposerInput(edit(F1, () => {}, { y: 5 }), runtime)).toMatchObject(unrecognized);
  });

  it.each([
    ["a numbered choice", "  » 1. Later"],
    ["a row starting with ❯", "❯ resume the last session"],
    ["an indented row starting with ›", "  › next step"],
  ])("case 15: keeps %s between the closing rule and the footer unrecognized", (_label, row) => {
    for (const runtime of RUNTIMES) {
      // Edited: the statusLine row replaced by a prompt-shaped row. The gap rows are read after their leading spaces
    // (the captured statusLine is indented two columns, and Claude draws its menus indented).
      const shaped = edit(F1, rows => { rows[5] = row; });
      expect(inspectComposerInput(shaped, runtime)).toMatchObject(unrecognized);
    }
  });
});

describe("pane activity with the composer snapshot (#2700)", () => {
  it("case 11a: reads the F1 seat as idle despite finished work and a quoted question above its box", () => {
    // Edited: two finished rows above the captured box: a quoted permission question with no choices after it, and a
    // completed "Working …" line within the last eight rows. Only the complete framed empty box makes them history.
    const snapshot = edit(F1, rows => {
      rows.splice(0, 0, "● The hook asked: Do you want to proceed?", "● Working … done; the branch is clean.");
    }, { y: PROMPT_ROW + 2 });
    expect(classifyPaneActivity(plain(snapshot.screen), { composerSnapshot: snapshot, runtime: "claude-code" }))
      .toMatchObject({ state: "agent_idle" });
    // The reason follows the last row: F1 ends on a "⏵⏵ … on" mode footer, an idle status bar, so either idle reason is
    // right. What only a framed read gives here is the idle state itself; without it the quoted question wins.
    expect(["idle_status_bar", "idle_prompt"]).toContain(classifyPaneActivity(plain(snapshot.screen), { composerSnapshot: snapshot, runtime: "claude-code" }).reason);
  });

  it("case 11b: reads the F2 seat as idle with the task panel open", () => {
    expect(classifyPaneActivity(plain(F2.screen), { composerSnapshot: F2, runtime: "claude-code" }))
      .toMatchObject({ state: "agent_idle", reason: "idle_prompt" });
  });
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The draft-aware delivery path for one Claude seat whose composer reads come from `snapshot(body)`. */
function delivery(snapshot: (body: string) => ComposerSnapshot) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body = "", staged = "";
  const writes: string[] = [], submissions: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { writes.push(`paste:${staged}`); body = staged; }
    if (command.includes("send-keys")) {
      writes.push(`keys:${command}`);
      if (command.includes("Enter")) { submissions.push(body); body = ""; }
    }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => snapshot(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => plain(snapshot(body).screen));
  let at = Date.now();
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    now: () => new Date(at), sleep: async () => {}, eventBus: new EventBus(db), captureObserver: { record: () => {} },
    agentActivityStore: { resolveSession: () => ({ rigId: "rig", nodeId: "a", sessionName: "worker@test" }),
      getLatestForNode: () => ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  cleanup.push(async () => { await transport.guardedDelivery!.stop(); db.close(); });
  return {
    writes, submissions,
    enable: () => guard.set("a", { mode: "draft-aware" }, "human@test", "keep draft"),
    send: (id: string, text: string) => transport.send("worker@test", text, { deliveryId: id, actorSession: "human@test", verify: false }),
  };
}

const LABEL = "[Pasted text #1 +70 lines]";
const PASTE_HINT = "  \x1b[38;5;246mpaste again to expand\x1b[39m";

describe.each([
  ["F1", F1, 6],
  ["F2", F2, 5],
] as const)("draft-aware delivery to a real %s composer (#2700)", (name, base, footerRow) => {
  // What the seat shows for the delivery's own body: a short message on the prompt row, or, for a long one, Claude's
  // collapsed label with its mode footer replaced by the paste hint (as claude-paste-footer.json records it).
  const shown = (body: string) => {
    if (!body) return edit(base);
    if (!body.includes("\n")) return typed(base, body);
    return edit(typed(base, LABEL), rows => { rows[footerRow] = PASTE_HINT; });
  };

  it(`case 12: delivers a short message into the empty ${name} composer`, async () => {
    const f = delivery(shown); await f.enable();
    const result = await f.send(`${name}-short`, "incoming message");
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.reason).not.toBe("draft_input_unknown");
    expect(f.submissions).toEqual(["incoming message"]);
  });

  it(`case 12: delivers a collapsed paste into the empty ${name} composer across the paste hint`, async () => {
    const f = delivery(shown); await f.enable();
    const text = Array.from({ length: 71 }, (_, i) => `delivery line ${i}`).join("\n");
    const result = await f.send(`${name}-paste`, text);
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.reason).not.toBe("draft_input_unknown");
    expect(f.submissions).toEqual([text]);
  });

  it(`case 12: holds a delivery behind a person's draft in the ${name} composer as busy`, async () => {
    // Edited: the person's unfinished note on the prompt row, unchanged for every read.
    const f = delivery(() => typed(base, "unfinished note")); await f.enable();
    expect(await f.send(`${name}-draft`, "incoming message")).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(f.writes).toEqual([]);
    expect(f.submissions).toEqual([]);
  });
});
