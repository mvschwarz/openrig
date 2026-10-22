import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendOpts, type SendResult } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createDaemon } from "../src/startup.js";
import { createFullTestDb } from "./helpers/test-app.js";

// transport.verify_input_box: a verified Claude Code or Codex send reports on input-box evidence. The mock
// tmux serves real frames (fixtures/input-box) by phase: before the paste, between paste and Enter, and after
// Enter. Frames that were never captured are one-line edits of a real frame, named where they are made.
const read = (path: string) => readFileSync(new URL(`./fixtures/input-box/${path}`, import.meta.url), "utf8");
const claude = (name: string) => read(`claude-code-2.1.296/${name}.txt`);
const codex = (name: string) => read(`codex-0.160.0/${name}.txt`);
const texts = {
  short: read("texts/short.txt"),
  envelope: read("texts/envelope.txt"),
  wrapped: read("texts/wrapped.txt"),
  large: read("texts/large.txt"),
  submit: read("texts/submit.txt"),
};
const picker = JSON.parse(readFileSync(new URL("./fixtures/claude-question-picker-2.1.289.json", import.meta.url), "utf8")) as Record<string, string>;
const codexUpdate = readFileSync(new URL("./fixtures/codex-update-0.160.0.txt", import.meta.url), "utf8");

function editLine(frame: string, match: (line: string) => boolean, replacement: string | string[]): string {
  const lines = frame.split("\n");
  const hits = lines.flatMap((line, index) => (match(line) ? [index] : []));
  expect(hits, "the edit must hit exactly one line").toHaveLength(1);
  lines.splice(hits[0]!, 1, ...(Array.isArray(replacement) ? replacement : [replacement]));
  return lines.join("\n");
}
// The live box row draws a no-break space after the marker; transcript rows draw a plain space.
const claudeBoxRow = (line: string) => line.startsWith("❯\u00a0");
const claudeQueued = (frame: string) => editLine(frame, claudeBoxRow, "❯ Press up to edit queued messages");
// Claude: the real frame 0.4 s after a submit shows a running turn (a live status row, `esc to interrupt` in the footer).
const claudeRunning = claude("after-enter-0.4s.J");
// Edit: our text staged in the box of that real frame, so a turn is running when Enter is pressed.
const claudeStagedWhileRunning = (text: string) => editLine(claudeRunning, claudeBoxRow, `❯\u00a0${text}`);
// Codex: the real frame 0.4 s after a submit shows the running-turn status row above an empty box.
const codexRunning = codex("after-enter-0.4s.J");
const codexStatusRow = (line: string) => line.startsWith("• Working");
// Edit: our text staged in the box of that real frame, so a turn is running when Enter is pressed.
const codexStagedWhileRunning = (text: string) => editLine(codexRunning, (line) => line.startsWith("› Ask Codex"), `› ${text}`);
// Edit: one row under the status row of that real frame, where Codex lists messages waiting behind a turn. No real
// frame of a queued Codex message was captured, so the row's shape is illustrative; any row there counts.
const codexRowBehindTurn = editLine(codexRunning, codexStatusRow, ["• Working (0s • esc to interrupt)", "  ↳ a message waiting behind the turn"]);

// Busy seats whose running signal is hidden or partial (the adversarial rounds' shapes). Each is an edit of a real
// frame, named here.
const claudeFooterRow = (line: string) => line.startsWith("  ⏵⏵ bypass permissions on");
const claudeStatusRow = (line: string) => line.startsWith("✶");
// The real post-paste footer of staged-wrapped.raw: Claude 2.1.296 draws only `paste again to expand` for 8 s after a
// paste, whatever isLoading is, so `esc to interrupt` is not drawn then (ADV3-2).
const wrappedRaw = claude("staged-wrapped.raw");
const pasteHintRow = wrappedRaw.split("\n").find((line) => line.trim() === "paste again to expand")!;
const wrappedBoxRows = (() => {
  const lines = wrappedRaw.split("\n");
  const at = lines.findIndex(claudeBoxRow);
  return lines.slice(at, at + 3);
})();
// Edit: the running frame with the paste-hint footer (an earlier paste in the last 8 s).
const claudeRunningPasteHint = editLine(claudeRunning, claudeFooterRow, pasteHintRow);
// Edit: as above, and the live status row blanked: only the paste hint is left of the running turn.
const claudeRunningOnlyPasteHint = editLine(claudeRunningPasteHint, claudeStatusRow, "");
// Edit (ADV3-2 probe Q1): the 3 real wrapped box rows staged in the running frame, under the paste-hint footer.
const claudeWrappedStagedWhileRunningPasteHint = editLine(editLine(claudeRunning, claudeBoxRow, wrappedBoxRows), claudeFooterRow, pasteHintRow);
// Edit (ADV3-2 probe Q1c): one-row text staged in the running frame, under the paste-hint footer.
const claudeShortStagedWhileRunningPasteHint = editLine(claudeStagedWhileRunning(texts.short), claudeFooterRow, pasteHintRow);
// Codex 0.160 hides the `• Working` row while assistant output streams (tui/src/chatwidget/streaming.rs,
// hide_status_indicator) and draws an Enter during the turn as a pending steer above the box
// (tui/src/bottom_pane/pending_input_preview.rs). Edit (ADV3-1): the status row replaced by a streamed text row.
const codexStreaming = editLine(codexRunning, codexStatusRow, "• I am checking the repository layout before editing the files.");
const codexStagedWhileStreaming = (text: string) => editLine(codexStreaming, (line) => line.startsWith("› Ask Codex"), `› ${text}`);
const steerHeader = "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
// Edit (ADV3-1 probe Q2): status hidden, the pending steer with our text above the empty box.
const codexSteerNoStatus = (text: string) => editLine(codexRunning, codexStatusRow, [steerHeader, `  ↳ ${text}`]);
// Edit (ADV3-1 probe Q2b): the same with the status row drawn.
const codexSteerWithStatus = (text: string) => editLine(codexRunning, codexStatusRow, ["• Working (3s • esc to interrupt)", steerHeader, `  ↳ ${text}`]);
// The real footer Claude 2.1.296 draws while the box holds text (staged-short.raw): the mode row alone, no
// `esc to interrupt` and no `← for agents`, whether or not a turn runs.
const claudeTextFooter = claude("staged-short.raw").split("\n").find(claudeFooterRow)!;
// Edit (ADV4-2, review 4 R4b): one-row text staged in the running frame under that footer, so only the status row
// shows the turn.
const claudeShortStagedWhileRunningTextFooter = editLine(claudeStagedWhileRunning(texts.short), claudeFooterRow, claudeTextFooter);
// Edit (ADV4-4, review 4 R4): the 3 real wrapped box rows staged in the running frame under that footer.
const claudeWrappedStagedWhileRunningTextFooter = editLine(editLine(claudeRunning, claudeBoxRow, wrappedBoxRows), claudeFooterRow, claudeTextFooter);

// OpenRig's own Claude launch (ADV4-1). Every Claude seat is launched with `--name <session>`, a permission posture
// (claudePostureFlag: acceptEdits by default) and OpenRig's statusLine collector. Edits of real frames:
/** The box's opening rule (the rule above the last `❯` row) drawn with this seat's session name, as Claude Code draws
 *  `--name`: the rule, the name padded by one space each side, then `trailing` rule cells (one in the 2.1.296
 *  bundle, two in real frames of OpenRig seats from earlier versions), as wide as the plain rule it replaces. */
function nameBox(frame: string, name = "dev-impl@my-rig", trailing = 1): string {
  const lines = frame.split("\n");
  let box = lines.length - 1;
  while (box >= 0 && !lines[box]!.startsWith("❯")) box--;
  const rule = lines[box - 1]!.trimEnd();
  expect(rule).toMatch(/^─{10,}$/);
  lines[box - 1] = `${"─".repeat([...rule].length - name.length - 2 - trailing)} ${name} ${"─".repeat(trailing)}`;
  return lines.join("\n");
}
/** The footer row replaced by a posture's row (from the Claude Code 2.1.296 bundle, see SEAT_IDLE_SHAPES). */
const posture = (frame: string, footer: string) => editLine(frame, claudeFooterRow, `  ${footer}`);
const ACCEPT_EDITS_IDLE = "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
const ACCEPT_EDITS_TEXT = "⏵⏵ accept edits on (shift+tab to cycle)";
// With OpenRig's statusLine the footer drops `esc to interrupt`, so a running turn draws the idle footer row.
const openRig = {
  idle: posture(nameBox(claude("after-enter-15s.J")), ACCEPT_EDITS_IDLE),
  staged: (text: string) => posture(nameBox(editLine(claude("staged-short.raw"), claudeBoxRow, `❯\u00a0${text}`)), ACCEPT_EDITS_TEXT),
  running: posture(nameBox(claudeRunning), ACCEPT_EDITS_IDLE),
  stagedWhileRunning: (text: string) => posture(nameBox(claudeStagedWhileRunning(text)), ACCEPT_EDITS_TEXT),
};

// Review round 1 (the maintainer's four changes). Every frame below is an edit of a real frame, named here.
// Change 1, word boundaries: the box row of a real staged frame replaced by `boxText`.
const claudeStagedAs = (boxText: string) => editLine(claude("staged-short.raw"), claudeBoxRow, `❯\u00a0${boxText}`);
const codexStagedAs = (boxText: string) => editLine(codex("staged-short.J"), (line) => line.startsWith("› Queue handoff"), `› ${boxText}`);
// Repair round 1 (review-safety-1): staged boxes drawn over several rows (continuation rows two cells in). Claude:
// staged-wrapped.raw's three box rows replaced; Codex: staged-short.J's box row replaced.
const claudeStagedRows = (rows: string[]) => {
  const lines = wrappedRaw.split("\n");
  const at = lines.findIndex(claudeBoxRow);
  lines.splice(at, 3, `❯\u00a0${rows[0]}`, ...rows.slice(1).map((row) => `  ${row}`));
  return lines.join("\n");
};
const codexStagedRows = (rows: string[]) => editLine(codex("staged-short.J"), (line) => line.startsWith("› Queue handoff"),
  [`› ${rows[0]}`, ...rows.slice(1).map((row) => `  ${row}`)]);
// A 24-cell box whose first row is NFD text (44 code points), then one 28-letter word split at 24 cells.
const nfdRows = [`${"e\u0301".repeat(10)} ${"e\u0301".repeat(10)} ok`, "abcdefghijklmnopqrstuvwx", "yz12"];
const nfdSentWithSpace = `${nfdRows[0]} abcdefghijklmnopqrstuvwx yz12`;
// Repair round 2 (review-safety-2): Codex 0.160.0's re-pass lets a row holding only indentation absorb the next word
// and split it where the row fills, though the word fits in a row. Edit of the real wrapped Codex frame (its box is
// 112 to 117 cells): `› ` + 8 spaces + a 110-letter token's first 108 letters, its last 2, then the frame's first
// real row as a continuation row. The sent text has a space at the split.
const TOKEN = "Zm9vYmFyYmF6cXV4".repeat(7).slice(0, 110);
const codexWrappedFirstRow = codex("staged-wrapped.raw").split("\n").find((line) => line.startsWith("› Background"))!;
const codexIndentedToken = editLine(codex("staged-wrapped.raw"), (line) => line === codexWrappedFirstRow,
  [`› ${" ".repeat(8)}${TOKEN.slice(0, 108)}`, `  ${TOKEN.slice(108)}`, `  ${codexWrappedFirstRow.slice(2)}`]);
const indentedTokenSentWithSpace = `${" ".repeat(8)}${TOKEN.slice(0, 108)} ${TOKEN.slice(108)}\n${texts.wrapped.trim()}`;
// Change 1: the wrapped text with the space at its first row break taken out, so the break falls inside a word.
const wrappedJoinedAtBreak = texts.wrapped.replace("next scheduled", "nextscheduled");
// Change 2, versions: the version a client prints in its banner, header or update notice, edited.
const claudeVersion = (frame: string, version: string) => editLine(frame, (line) => line.includes("Claude Code v2.1.296"),
  ` ▐▛███▛█   Claude Code v${version}`);
const codexHeaderVersion = (frame: string, version: string) => editLine(frame, (line) => line.includes(">_ OpenAI Codex"),
  `  >_ OpenAI Codex (v${version})`);
const codexUpdateFrom = (frame: string, version: string) => editLine(frame, (line) => line.includes("Update available!"),
  `│ ✨ Update available! ${version} -> 0.162.1         │`);
// Change 3, Claude's blank status row: OpenRig's idle frame with its completion row replaced by a streamed message
// whose last row is blank, the shape the 2.1.296 bundle does not rule out while it hides its spinner for streamed text.
const openRigStreamingBlankTail = editLine(openRig.idle, (line) => line.startsWith("✻ Cooked"),
  ["● I am checking the queue now; the first item is a review request.", ""]);

type Phase = "prePaste" | "afterPaste" | "afterEnter";
type Read<T> = T | Error | "never";
interface Script {
  frames: Record<Phase, Read<string | null>>;
  pids?: Partial<Record<Phase, Read<number | null>>>;
  onPaste?: () => void;
  onEnter?: () => void;
  onAfterPasteCapture?: () => void;
}

/** A mock tmux that serves one frame per phase and logs every adapter call with its phase. */
function phasedTmux(script: Script) {
  let phase: Phase = "prePaste";
  const log: string[] = [];
  const serve = <T>(value: Read<T>): Promise<T> => value === "never" ? new Promise<T>(() => {})
    : value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  const tmux = {
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText: async (): Promise<TmuxResult> => { log.push("sendText"); phase = "afterPaste"; script.onPaste?.(); return { ok: true }; },
    sendKeys: async (_target: string, keys: string[]): Promise<TmuxResult> => {
      log.push(`sendKeys:${keys.join(",")}`);
      phase = "afterEnter";
      script.onEnter?.();
      return { ok: true };
    },
    capturePaneContent: async (_target: string, lines?: number, opts?: { joinWrappedLines?: boolean }) => {
      log.push(`capture:${phase}:${lines}${opts?.joinWrappedLines ? ":J" : ""}`);
      if (phase === "afterPaste") script.onAfterPasteCapture?.();
      return serve(script.frames[phase]);
    },
    getPanePid: async () => { log.push(`pid:${phase}`); return serve(script.pids && phase in script.pids ? script.pids[phase]! : 4242); },
    getPaneCommand: async () => null,
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
  return { tmux, log };
}

describe("SessionTransport with transport.verify_input_box", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  const SESSION = "dev-impl@my-rig";

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function seedCanonicalRig(runtime: string | null = "claude-code") {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", ...(runtime ? { runtime } : {}) });
    const session = sessionRegistry.registerSession(node.id, SESSION);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SESSION });
    return { rig, node, session };
  }

  /** `setting` undefined builds the transport without the dep, as every other construction does. */
  function transport(tmux: TmuxAdapter, setting?: boolean | (() => boolean)) {
    return new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, sleep: async () => {},
      ...(setting === undefined ? {} : { verifyInputBox: typeof setting === "function" ? setting : () => setting }),
    });
  }

  async function run(script: Script, text: string, setting?: boolean, opts: SendOpts = { verify: true }) {
    const { tmux, log } = phasedTmux(script);
    const result = await transport(tmux, setting).send(SESSION, text, opts);
    return { result, log };
  }

  /** Every ordinary send: one paste and one Enter, nothing re-sent, retried or expanded; unconfirmed is ok. */
  function expectOnePasteOneEnter(result: SendResult, log: string[]) {
    expect(log.filter((call) => call === "sendText")).toHaveLength(1);
    expect(log.filter((call) => call.startsWith("sendKeys"))).toEqual(["sendKeys:Enter"]);
    expect(result.ok).toBe(true);
    expect(["delivered", "rendered-unconfirmed"]).toContain(result.outcome);
    if (result.verified === false) expect(result.outcome).toBe("rendered-unconfirmed");
  }

  // Off is today's main with the same mock and frames; null means the after-Enter frame stands in for a box
  // state, so today's transcript verdict on it proves nothing and is not asserted.
  type Row = [id: string, runtime: "claude-code" | "codex", text: string, frames: Record<Phase, string>,
    off: boolean | null, box: { seat: string; before: string; after: string; sameProcess: boolean }, on: boolean];
  const idle = claude("idle-fresh-suggestion");
  const rows: Row[] = [
    // Submitted
    ["T1 Claude submitted", "claude-code", texts.submit,
      { prePaste: idle, afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
      true, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["T2 Codex submitted", "codex", texts.submit,
      { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
      true, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    // No product-path after-Enter frame was captured; its idle frame stands in for an empty box.
    ["T3 Codex product path", "codex", texts.short,
      { prePaste: codex("product-path-idle.J"), afterPaste: codex("product-path-staged-short.J"), afterEnter: codex("product-path-idle.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["T4 Codex envelope inline", "codex", texts.envelope,
      { prePaste: codex("idle"), afterPaste: codex("staged-envelope.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["T5 Claude wrapped, fully visible", "claude-code", texts.wrapped,
      { prePaste: idle, afterPaste: claude("staged-wrapped.raw"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["T6 Codex wrapped", "codex", texts.wrapped,
      { prePaste: codex("idle"), afterPaste: codex("staged-wrapped.raw"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    // Still in the input box (Enter swallowed, for example by copy mode)
    ["T7 Claude still in the box", "claude-code", texts.submit,
      { prePaste: idle, afterPaste: claude("submit-staged.J"), afterEnter: claude("submit-staged.J") },
      false, { seat: "idle", before: "exact", after: "exact", sameProcess: true }, false],
    ["T8 Codex still in the box", "codex", texts.submit,
      { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codex("submit-staged.J") },
      false, { seat: "idle", before: "exact", after: "exact", sameProcess: true }, false],
    // Queued: a generic label is never verified, even after an exact before
    ["T9 Claude queued after our exact text", "claude-code", texts.submit,
      { prePaste: idle, afterPaste: claude("submit-staged.J"), afterEnter: claudeQueued(claude("submit-staged.J")) },
      false, { seat: "idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["T10 Claude queued label with no text of ours before", "claude-code", texts.submit,
      { prePaste: idle, afterPaste: claude("after-enter-0.4s.J"), afterEnter: claudeQueued(claude("submit-staged.J")) },
      null, { seat: "idle", before: "empty", after: "queued", sameProcess: true }, false],
    ["T48 Claude queued label after our text staged while a turn runs", "claude-code", texts.short,
      { prePaste: claudeRunning, afterPaste: claudeStagedWhileRunning(texts.short), afterEnter: claudeQueued(claudeRunning) },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    // Claude queued without its label: Claude Code draws "Press up to edit queued messages" only while a per-user
    // hint counter is low, so a queued message can leave the same empty box as a submit. The seat was not idle
    // before the paste, so the send is unconfirmed; the empty box reads queued to say why
    ["T46 Claude: our text staged while a turn runs, then an empty box", "claude-code", texts.short,
      { prePaste: claudeRunning, afterPaste: claudeStagedWhileRunning(texts.short), afterEnter: claudeRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["T47 Claude: idle before Enter, then the same empty box with a turn running: verified", "claude-code", texts.short,
      { prePaste: idle, afterPaste: claude("staged-short.raw"), afterEnter: claudeRunning },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    // Codex queued: Codex 0.160 draws the same empty box after a submit and after a message queued behind a
    // running turn. A seat that was not idle before the paste is unconfirmed; the box reads queued to say why
    ["T43 Codex: our text staged while a turn runs, then an empty box", "codex", texts.short,
      { prePaste: codexRunning, afterPaste: codexStagedWhileRunning(texts.short), afterEnter: codexRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["T44 Codex: a row waits behind the running turn above the empty box", "codex", texts.submit,
      { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codexRowBehindTurn },
      true, { seat: "idle", before: "exact", after: "queued", sameProcess: true }, false],
    // Unrelated older output: our text only in the transcript above an empty box
    ["T11 Claude text only in older output", "claude-code", texts.submit,
      { prePaste: claude("after-enter-15s.J"), afterPaste: claude("after-enter-15s.J"), afterEnter: claude("after-enter-15s.J") },
      false, { seat: "idle", before: "empty", after: "empty", sameProcess: true }, false],
    ["T12 Codex text only in older output", "codex", texts.submit,
      { prePaste: codex("after-enter-15s.J"), afterPaste: codex("after-enter-15s.J"), afterEnter: codex("after-enter-15s.J") },
      false, { seat: "idle", before: "empty", after: "empty", sameProcess: true }, false],
    ["T13 Claude: a person's draft in the box is what Enter submits", "claude-code", texts.submit,
      { prePaste: editLine(claude("after-enter-0.4s.J"), claudeBoxRow, "❯ a draft someone was typing"),
        afterPaste: editLine(claude("after-enter-0.4s.J"), claudeBoxRow, "❯ a draft someone was typing"),
        afterEnter: claude("after-enter-15s.J") },
      // The draft sits in a running seat's box, so Enter may queue it: the empty box after reads queued.
      null, { seat: "not-idle", before: "other", after: "queued", sameProcess: true }, false],
    // A cleared box that never held our text
    ["T16 the paste never showed", "claude-code", texts.short,
      { prePaste: idle, afterPaste: idle, afterEnter: claude("after-enter-0.4s.J") },
      false, { seat: "idle", before: "other", after: "empty", sameProcess: true }, false],
    ["T18 Claude cleared with C-c: the suggestion returns", "claude-code", texts.short,
      { prePaste: idle, afterPaste: claude("staged-short.raw"), afterEnter: claude("cleared-without-enter.J") },
      false, { seat: "idle", before: "exact", after: "other", sameProcess: true }, false],
    // A documented limit: a box cleared by something else (C-c) between the read and Enter looks submitted.
    // Codex draws the same empty box after a C-c as after a submit, so this verifies.
    ["T18b Codex cleared with C-c: indistinguishable from a submit (documented limit)", "codex", texts.short,
      { prePaste: codex("idle"), afterPaste: codex("staged-short.J"), afterEnter: codex("cleared-without-enter.J") },
      false, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["T45 Claude: a text equal to the Try suggestion never reads exact", "claude-code", 'Try "fix typecheck errors"',
      { prePaste: idle, afterPaste: idle, afterEnter: claude("after-enter-0.4s.J") },
      false, { seat: "idle", before: "other", after: "empty", sameProcess: true }, false],
    // Collapsed paste placeholders: the label is never identity, even of the right size
    ["T20 Claude large paste collapsed", "claude-code", texts.large,
      { prePaste: idle, afterPaste: claude("staged-large-collapsed.J"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "hidden", after: "empty", sameProcess: true }, false],
    ["T21 Codex large paste collapsed", "codex", texts.large,
      { prePaste: codex("idle"), afterPaste: codex("staged-large-collapsed.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "hidden", after: "empty", sameProcess: true }, false],
    // Uncertainty from the layout: an uncertain layout adds no refusal; Enter is still sent once
    ["T29 malformed capture: cut mid-box", "claude-code", texts.short,
      { prePaste: idle, afterPaste: claude("staged-short.raw").split("\n").slice(0, -3).join("\n"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "unrecognized", after: "empty", sameProcess: true }, false],
    ["T29 malformed capture: garbage text", "codex", texts.short,
      { prePaste: codex("idle"), afterPaste: "\u0000\u0007 garbled \u001b[2J", afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "unrecognized", after: "empty", sameProcess: true }, false],
    ["T30 Claude box with an unknown footer", "claude-code", texts.short,
      { prePaste: idle, afterPaste: editLine(claude("staged-short.raw"), (line) => line.includes("bypass permissions on"), "  some new footer"),
        afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "unrecognized", after: "empty", sameProcess: true }, false],
    ["T31 Claude picker appears after the paste", "claude-code", texts.short,
      { prePaste: idle, afterPaste: picker.picker160!, afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "unrecognized", after: "empty", sameProcess: true }, false],
    ["T32 Codex footer that is not a status line", "codex", texts.short,
      { prePaste: codex("idle"), afterPaste: codexUpdate, afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "unrecognized", after: "empty", sameProcess: true }, false],
    // A busy or unknown seat always reads unconfirmed: verified needs the seat proven idle before the paste. Every
    // adversarial shape of the three review rounds, with the input box readings each one gives.
    ["A1 (ADV-1) Codex busy: Enter queues behind the turn, a row waits under the status row", "codex", texts.short,
      { prePaste: codexRunning, afterPaste: codexStagedWhileRunning(texts.short), afterEnter: codexRowBehindTurn },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A2 (ADV2-1) Claude busy, no queued label: exact, then the plain empty box", "claude-code", texts.short,
      { prePaste: claudeRunning, afterPaste: claudeStagedWhileRunning(texts.short), afterEnter: claudeRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A3 (ADV3-1 Q2) Codex streaming: the status row is hidden, Enter becomes a pending steer", "codex", texts.short,
      { prePaste: codexStreaming, afterPaste: codexStagedWhileStreaming(texts.short), afterEnter: codexSteerNoStatus(texts.short) },
      null, { seat: "unknown", before: "exact", after: "queued", sameProcess: true }, false],
    ["A4 (ADV3-1) Codex streaming, no trace of the message after Enter: exact, then empty", "codex", texts.short,
      { prePaste: codexStreaming, afterPaste: codexStagedWhileStreaming(texts.short), afterEnter: codexStreaming },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["A5 (ADV3-1 Q2b) Codex: the pending steer under a visible status row", "codex", texts.short,
      { prePaste: codexRunning, afterPaste: codexStagedWhileStreaming(texts.short), afterEnter: codexSteerWithStatus(texts.short) },
      null, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A6 (ADV3-2 Q1) Claude busy, wrapped text, paste-hint footer: exact, then empty (queued: the status row above the wrapped box)", "claude-code", texts.wrapped,
      { prePaste: claudeRunning, afterPaste: claudeWrappedStagedWhileRunningPasteHint, afterEnter: claudeRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A7 (ADV3-2 Q1c) Claude busy, one-row text, paste-hint footer", "claude-code", texts.short,
      { prePaste: claudeRunning, afterPaste: claudeShortStagedWhileRunningPasteHint, afterEnter: claudeRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A8 (ADV3-2) Claude busy with the paste-hint footer already showing before the paste", "claude-code", texts.wrapped,
      { prePaste: claudeRunningPasteHint, afterPaste: claudeWrappedStagedWhileRunningPasteHint, afterEnter: claudeRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A9 (ADV3-2) Claude busy, only the paste hint left of the running turn before the paste", "claude-code", texts.wrapped,
      { prePaste: claudeRunningOnlyPasteHint, afterPaste: claudeWrappedStagedWhileRunningPasteHint, afterEnter: claudeRunning },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A10 (ADV3 Q3) Claude: a turn that finishes between the reads", "claude-code", texts.short,
      { prePaste: claudeRunning, afterPaste: claudeStagedWhileRunning(texts.short), afterEnter: claude("after-enter-15s.J") },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A11 (ADV3 Q3) Codex: a turn that finishes between the reads", "codex", texts.short,
      { prePaste: codexRunning, afterPaste: codexStagedWhileRunning(texts.short), afterEnter: codex("after-enter-15s.J") },
      false, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["A12 Codex: the status line spinner before the paste", "codex", texts.submit,
      { prePaste: codex("after-enter-1s.J"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-15s.J") },
      null, { seat: "not-idle", before: "exact", after: "empty", sameProcess: true }, false],
    // An idle-shaped bottom does not prove idle when a running row is anywhere else on the screen (edits)
    ["A13 Claude: idle bottom, a live status row higher up", "claude-code", texts.submit,
      { prePaste: editLine(claude("after-enter-15s.J"), (line) => line.startsWith("✻ Cooked"), "✶ Marinating… (12s · ↓ 1.2k tokens)"),
        afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "not-idle", before: "exact", after: "empty", sameProcess: true }, false],
    ["A14 Codex: the completion row above the box, a status row higher up", "codex", texts.submit,
      { prePaste: editLine(codex("after-enter-15s.J"), (line) => line.startsWith("• OK"), "• Working (3s • esc to interrupt)"),
        afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "not-idle", before: "exact", after: "empty", sameProcess: true }, false],
    // An unknown layout before the paste: not on the idle allow-list, so unconfirmed even when the box reads well
    ["U1 Claude with a footer no posture of 2.1.296 under OpenRig draws (earlier versions' `? for shortcuts`)", "claude-code", texts.submit,
      { prePaste: editLine(claude("after-enter-15s.J"), claudeFooterRow, "  ? for shortcuts"),
        afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["U5 Claude: another seat's name on the box", "claude-code", texts.submit,
      { prePaste: nameBox(claude("after-enter-15s.J"), "dev-qa@my-rig"), afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    // A turn that starts after the pre-paste capture (ADV4-2): the seat read idle, so the queued reading of the frame
    // read before Enter is what rejects the send. A person or the agent itself (a background task finishing, a
    // scheduled wake-up, a teammate's message) can start one in the ~200 ms between that capture and Enter.
    ["Q1 (review 4 R4b) Claude: a turn starts after the pre-paste capture; one-row text, footer without esc to interrupt", "claude-code", texts.short,
      { prePaste: idle, afterPaste: claudeShortStagedWhileRunningTextFooter, afterEnter: claudeRunning },
      null, { seat: "idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["Q2 (review 4 R4d) Codex: a turn starts after the pre-paste capture; its Working row shows before Enter", "codex", texts.short,
      { prePaste: codex("idle"), afterPaste: codexStagedWhileRunning(texts.short), afterEnter: codexRunning },
      null, { seat: "idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["Q3 (review 4 R4, ADV4-4) Claude: a turn starts after the pre-paste capture; wrapped text, the status row above the 3-row box", "claude-code", texts.wrapped,
      { prePaste: idle, afterPaste: claudeWrappedStagedWhileRunningTextFooter, afterEnter: claudeRunning },
      null, { seat: "idle", before: "exact", after: "queued", sameProcess: true }, false],
    // A documented limit: a Codex turn that starts after the pre-paste capture and is already streaming before Enter
    // hides its Working row, so nothing in the frames shows it.
    ["L1 (review 4 R4c) Codex: a turn starts after the pre-paste capture and streams before Enter: verifies (documented limit)", "codex", texts.short,
      { prePaste: codex("idle"), afterPaste: codexStagedWhileStreaming(texts.short), afterEnter: codexStreaming },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    // OpenRig's own Claude launch (ADV4-1): named box, accept edits, the statusLine collector. Idle verifies; running,
    // where the footer looks idle, reads not-idle through the status row above the box.
    ["O1 OpenRig-launched Claude seat, idle: verified", "claude-code", texts.short,
      { prePaste: openRig.idle, afterPaste: openRig.staged(texts.short), afterEnter: openRig.running },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["O2 OpenRig-launched Claude seat, running before the paste (no esc to interrupt in its footer): unconfirmed", "claude-code", texts.short,
      { prePaste: openRig.running, afterPaste: openRig.stagedWhileRunning(texts.short), afterEnter: openRig.running },
      null, { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }, false],
    ["O3 OpenRig-launched Claude seat, running with a row no running pattern knows where the status row goes: unconfirmed", "claude-code", texts.short,
      { prePaste: editLine(openRig.running, claudeStatusRow, "⎿  Running…"), afterPaste: openRig.staged(texts.short), afterEnter: openRig.running },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["U2 Codex: a session header of a version with no captured frames", "codex", texts.submit,
      { prePaste: editLine(codex("idle"), (line) => line.includes(">_ OpenAI Codex"), "  >_ OpenAI Codex (v0.161.0)"),
        afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["U4 Codex: an interrupted turn above the box (no completion row)", "codex", texts.submit,
      { prePaste: editLine(codex("after-enter-15s.J"), (line) => line.includes("Worked for"),
        "■ Conversation interrupted - tell the model what to do differently."),
        afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["U3 Claude: a draft in the box before the paste", "claude-code", texts.submit,
      { prePaste: claude("staged-short.raw"), afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    // Review round 1, change 1: the exact-text check keeps word boundaries on both runtime paths. The maintainer's
    // case: `now here` pasted against a box that holds `nowhere`, then an empty box, read exact and delivered.
    ["R1-1 Claude: `now here` sent, the box holds `nowhere`", "claude-code", "now here",
      { prePaste: idle, afterPaste: claudeStagedAs("nowhere"), afterEnter: claude("after-enter-0.4s.J") },
      false, { seat: "idle", before: "other", after: "empty", sameProcess: true }, false],
    ["R1-2 Codex: `now here` sent, the box holds `nowhere`", "codex", "now here",
      { prePaste: codex("idle"), afterPaste: codexStagedAs("nowhere"), afterEnter: codex("after-enter-0.4s.J") },
      false, { seat: "idle", before: "other", after: "empty", sameProcess: true }, false],
    ["R1-3 Claude: `nowhere` sent, the box holds `now here`", "claude-code", "nowhere",
      { prePaste: idle, afterPaste: claudeStagedAs("now here"), afterEnter: claude("after-enter-0.4s.J") },
      false, { seat: "idle", before: "other", after: "empty", sameProcess: true }, false],
    ["R1-4 Codex: `nowhere` sent, the box holds `now here`", "codex", "nowhere",
      { prePaste: codex("idle"), afterPaste: codexStagedAs("now here"), afterEnter: codex("after-enter-0.4s.J") },
      false, { seat: "idle", before: "other", after: "empty", sameProcess: true }, false],
    ["R1-5 Claude: the box holds `now here` as sent: verified", "claude-code", "now here",
      { prePaste: idle, afterPaste: claudeStagedAs("now here"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["R1-6 Codex: the box holds `now here` as sent: verified", "codex", "now here",
      { prePaste: codex("idle"), afterPaste: codexStagedAs("now here"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["R1-7 Claude wrapped: a row break where the sent text has no space is ambiguous", "claude-code", wrappedJoinedAtBreak,
      { prePaste: idle, afterPaste: claude("staged-wrapped.raw"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["R1-8 Codex wrapped: a row break where the sent text has no space is ambiguous", "codex", wrappedJoinedAtBreak,
      { prePaste: codex("idle"), afterPaste: codex("staged-wrapped.raw"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    // Review round 1, change 2: a frame that visibly names another client version never confirms.
    ["R1-9 Claude: a finished-turn seat whose banner names 2.1.295", "claude-code", texts.submit,
      { prePaste: claudeVersion(claude("after-enter-15s.J"), "2.1.295"), afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["R1-10 Claude: the staged box under a banner that names 2.1.297", "claude-code", texts.submit,
      { prePaste: idle, afterPaste: claudeVersion(claude("submit-staged.J"), "2.1.297"), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "unrecognized", after: "empty", sameProcess: true }, false],
    ["R1-11 Codex: a finished-turn seat whose header names 0.161.0", "codex", texts.submit,
      { prePaste: codexHeaderVersion(codex("after-enter-15s.J"), "0.161.0"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["R1-12 Codex: a finished-turn seat whose update notice says it runs 0.159.0", "codex", texts.submit,
      { prePaste: codexUpdateFrom(codex("after-enter-15s.J"), "0.159.0"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    ["R1-13 Codex: the empty box after Enter under a header that names 0.159.0", "codex", texts.submit,
      { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codexHeaderVersion(codex("after-enter-0.4s.J"), "0.159.0") },
      null, { seat: "idle", before: "exact", after: "unrecognized", sameProcess: true }, false],
    // Review round 1, change 3: a blank status slot under streamed text is not proof of an idle Claude seat.
    ["R1-14 OpenRig-launched Claude seat streaming, its last streamed row blank: unconfirmed", "claude-code", texts.short,
      { prePaste: openRigStreamingBlankTail, afterPaste: openRig.staged(texts.short), afterEnter: openRig.idle },
      null, { seat: "unknown", before: "exact", after: "empty", sameProcess: true }, false],
    // Repair round 1 (review-safety-1): a row break that need not be whitespace of the box's text is not the sent
    // text's space. Before the repair each of these read exact, then empty, and verified.
    ["RS1-1 Claude: combining marks no longer widen the box; a space sent where a long word was split", "claude-code", nfdSentWithSpace,
      { prePaste: idle, afterPaste: claudeStagedRows(nfdRows), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS1-2 Codex: combining marks no longer widen the box; a space sent where a long word was split", "codex", nfdSentWithSpace,
      { prePaste: codex("idle"), afterPaste: codexStagedRows(nfdRows), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS1-3 Codex: a space sent where the box breaks after a hyphen (`self-review`)", "codex", "please run the self- review checklist",
      { prePaste: codex("idle"), afterPaste: codexStagedRows(["please run the self-", "review checklist"]), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS1-4 Codex: a space sent where the box breaks after a slash (`docs/guide`)", "codex", "open the docs/ guide today ok",
      { prePaste: codex("idle"), afterPaste: codexStagedRows(["open the docs/", "guide today ok"]), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS1-5 Codex: a space sent where the box breaks between ideographs", "codex", "please review 日本語 テキスト now",
      { prePaste: codex("idle"), afterPaste: codexStagedRows(["please review 日本語", "テキスト now"]), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS1-6 Codex: a hard line break after a hyphen, the next word would have fit before it: verified", "codex",
      "the long first row of this message self-\nreview now",
      { prePaste: codex("idle"), afterPaste: codexStagedRows(["the long first row of this message", "self-", "review now"]), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    // Repair round 2 (review-safety-2): a split between two letters is no space on a row that starts with the text's
    // own indentation, or after a break opportunity inside the row's last word. Before the repair RS2-1, RS2-2 and
    // RS2-4 read exact, then empty, and verified.
    ["RS2-1 Codex: an indented token split where its row fills; a space sent at the split", "codex", indentedTokenSentWithSpace,
      { prePaste: codex("idle"), afterPaste: codexIndentedToken, afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS2-2 Claude: the same rows in a Claude box (one rule for both runtimes)", "claude-code",
      `    ${"0123456789abcdefghijklmnopqrstuvwxyz".slice(0, 34)} yz\nPlease run this exact command from the repository root.`,
      { prePaste: idle, afterPaste: claudeStagedRows([`    ${"0123456789abcdefghijklmnopqrstuvwxyz".slice(0, 34)}`, "yz", "Please run this exact command from the", "repository root."]), afterEnter: claude("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
    ["RS2-3 Codex: an indented row whose next word would have fit after it: verified", "codex", "Please run this exact command from the\n    first step\nsecond step",
      { prePaste: codex("idle"), afterPaste: codexStagedRows(["Please run this exact command from the", "    first step", "second step"]), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "exact", after: "empty", sameProcess: true }, true],
    ["RS2-4 Codex: a space sent where a word after a hyphen in the row's last word is split", "codex", "aaaaaa c-ddddddddddd ddddd",
      { prePaste: codex("idle"), afterPaste: codexStagedRows(["aaaaaa c-ddddddddddd", "ddddd"]), afterEnter: codex("after-enter-0.4s.J") },
      null, { seat: "idle", before: "ambiguous", after: "empty", sameProcess: true }, false],
  ];

  describe.each(rows)("%s", (_id, runtime, text, frames, off, box, on) => {
    it("setting on: reports the input box and verifies only exact, then empty, on the same process", async () => {
      seedCanonicalRig(runtime);
      const { result, log } = await run({ frames }, text, true);
      expectOnePasteOneEnter(result, log);
      // The verdict first, so a changed verdict is reported as such, then the readings that explain it.
      expect(result.verified).toBe(on);
      expect(result.outcome).toBe(on ? "delivered" : "rendered-unconfirmed");
      // One capture and one pid read between paste and Enter, one pid read after the post capture.
      const enter = log.indexOf("sendKeys:Enter");
      expect(log.slice(log.indexOf("sendText") + 1, enter)).toEqual(["pid:afterPaste", "capture:afterPaste:30"]);
      expect(log.slice(enter + 1).at(-1)).toBe("pid:afterEnter");
    });

    it("setting off: the call log equals a transport built without the setting, and the verdict is today's", async () => {
      seedCanonicalRig(runtime);
      const withoutDep = await run({ frames }, text);
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      seedCanonicalRig(runtime);
      const settingOff = await run({ frames }, text, false);
      expect(settingOff.log).toEqual(withoutDep.log);
      expect(settingOff.log.some((call) => call.startsWith("pid:"))).toBe(false);
      expect(settingOff.result).toEqual(withoutDep.result);
      expectOnePasteOneEnter(settingOff.result, settingOff.log);
      if (off !== null) expect(settingOff.result.verified).toBe(off);
    });
  });

  describe("contrast with main: a match outside the box no longer verifies", () => {
    it("T14 Claude raw send: a draft sharing the first 40 characters is in the box and our Enter submits it", async () => {
      seedCanonicalRig("claude-code");
      const draft = `${texts.short.slice(0, 45)} and something else entirely`;
      const frames = {
        prePaste: idle,
        afterPaste: editLine(claude("staged-short.raw"), claudeBoxRow, `❯ ${draft}`),
        afterEnter: editLine(claude("after-enter-0.4s.J"), (line) => line.startsWith("❯ Reply"), `❯ ${draft}`),
      };
      expect((await run({ frames }, texts.short)).result.verified).toBe(true);
      const { result, log } = await run({ frames }, texts.short, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
    });

    it("T15 Codex: the box holds our text plus more", async () => {
      seedCanonicalRig("codex");
      const expected = texts.short.split(" ").slice(0, -2).join(" ");
      const frames = { prePaste: codex("idle"), afterPaste: codex("staged-short.J"), afterEnter: codex("after-enter-0.4s.J") };
      const { result, log } = await run({ frames }, expected, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false });
    });

    it("T17 Claude raw send: the box never held the text and an agent line repeats its first 40 characters", async () => {
      seedCanonicalRig("claude-code");
      const frames = {
        prePaste: idle,
        afterPaste: idle,
        afterEnter: editLine(claude("after-enter-0.4s.J"), (line) => line.startsWith("✶"), `● ${texts.short.slice(0, 40)}`),
      };
      expect((await run({ frames }, texts.short)).result.verified).toBe(true);
      const { result, log } = await run({ frames }, texts.short, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false });
    });

    it("T19 Claude envelope collapsed to a label of the right size: hidden, even though the transcript shows the whole envelope", async () => {
      seedCanonicalRig("claude-code");
      // Edit: the submitted envelope inserted into the transcript the way 2.1.296 renders a submitted paste.
      const rendered = ["❯ " + texts.envelope.split("\n")[0], ...texts.envelope.split("\n").slice(1).map((line) => `  ${line}`)];
      const frames = {
        prePaste: idle,
        afterPaste: claude("staged-envelope-collapsed.raw"),
        afterEnter: editLine(claude("after-enter-0.4s.J"), (line) => line.startsWith("❯ Reply"), rendered),
      };
      expect((await run({ frames }, texts.envelope)).result.verified).toBe(true);
      const { result, log } = await run({ frames }, texts.envelope, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
    });
  });

  describe("the seat before the paste: each idle allow-list entry verifies, read from the existing pre-paste capture", () => {
    // Edit: the row just above the box's opening rule of a real frame replaced by `row`.
    const aboveOpeningRule = (frame: string, row: string) => {
      const lines = frame.split("\n");
      lines[lines.findIndex(claudeBoxRow) - 2] = row;
      return lines.join("\n");
    };
    const focusNotice = claude("staged-short.raw").split("\n").find((line) => line.includes("tmux focus-events off"))!;
    const claudeAfter = { afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") };
    const codexAfter = { afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") };
    it.each([
      ["Claude footer, empty box, blank row above the rule (after-enter-15s.J)", "claude-code", claude("after-enter-15s.J")],
      ["Claude Try suggestion box, effort row above the rule (idle-fresh-suggestion)", "claude-code", idle],
      ["Claude tmux mouse notice above the rule (cleared-without-enter.J)", "claude-code", claude("cleared-without-enter.J")],
      ["Claude tmux focus-events notice above the rule (edit: staged-short.raw's real row in after-enter-15s.J)", "claude-code",
        aboveOpeningRule(claude("after-enter-15s.J"), focusNotice)],
      ["Codex fresh session, hint row alone (product-path-idle.J)", "codex", codex("product-path-idle.J")],
      ["Codex fresh session, hint row with a warning (idle)", "codex", codex("idle")],
      ["Codex finished turn: the completion row above the box (after-enter-15s.J)", "codex", codex("after-enter-15s.J")],
      // ADV4-3: the completion row on a 24-hour-clock host (edit, grammar from Codex 0.160 separators.rs and clock_format.rs).
      ["Codex finished turn on a 24-hour clock (edit)", "codex",
        editLine(codex("after-enter-15s.J"), (line) => line.includes("Worked for"), "  Worked for 3s • 15:12")],
      // ADV4-1: OpenRig's own launch. Each posture's footer row (from the 2.1.296 bundle) and the named box (edits).
      ["Claude posture acceptEdits (OpenRig's default)", "claude-code", posture(claude("after-enter-15s.J"), ACCEPT_EDITS_IDLE)],
      ["Claude posture auto", "claude-code", posture(claude("after-enter-15s.J"), "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents")],
      ["Claude posture dontAsk", "claude-code", posture(claude("after-enter-15s.J"), "⏵⏵ don't ask on (shift+tab to cycle) · ← for agents")],
      ["Claude posture plan", "claude-code", posture(claude("after-enter-15s.J"), "⏸ plan mode on (shift+tab to cycle) · ← for agents")],
      ["Claude posture default", "claude-code", posture(claude("after-enter-15s.J"), "⏸ manual mode on · ← for agents")],
      ["Claude box named for this seat, the 2.1.296 bundle's border", "claude-code", nameBox(claude("after-enter-15s.J"))],
      ["Claude box named for this seat, the border of real OpenRig seat frames", "claude-code", nameBox(claude("after-enter-15s.J"), "dev-impl@my-rig", 2)],
      ["Claude box named for this seat, Try suggestion and effort row", "claude-code", nameBox(idle)],
    ] as const)("%s", async (_id, runtime, prePaste) => {
      seedCanonicalRig(runtime);
      const { result, log } = await run({ frames: { prePaste, ...(runtime === "codex" ? codexAfter : claudeAfter) } }, texts.submit, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: true, outcome: "delivered" });
    });

    it.each([
      ["returns null", null],
      ["throws", new Error("capture failed")],
    ] as const)("the pre-paste capture %s: the seat reads unknown, unconfirmed, and the calls are today's", async (_id, prePaste) => {
      seedCanonicalRig("claude-code");
      const { result, log } = await run({ frames: { prePaste, ...claudeAfter } }, texts.submit, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
      // No read is added for the seat: the calls before the paste are those of the setting off.
      const off = await run({ frames: { prePaste, ...claudeAfter } }, texts.submit, false);
      expect(log.slice(0, log.indexOf("sendText"))).toEqual(off.log.slice(0, off.log.indexOf("sendText")));
    });
  });

  describe("real idle OpenRig-launched Claude seats (ADV5-1): the completion row in the status slot", () => {
    // Real frames of idle seats OpenRig launched (Claude Code 2.1.296, classic renderer, named box, OpenRig's
    // statusLine collector; fixtures/input-box/README.md). The slot two rows above the opening rule holds the last
    // turn's completion row. Edits of these frames are named where they are made.
    const realFooter = (line: string) => /^ {2}⏵⏵ (?:bypass permissions|accept edits) on/.test(line);
    const seats = {
      bypass: { frame: claude("openrig-seat-bypass-idle"), session: "orch-advisor@sample-rig", textFooter: "  ⏵⏵ bypass permissions on (shift+tab to cycle)" },
      acceptEdits: { frame: claude("openrig-seat-accept-edits-idle"), session: "review-r1@sample-rig", textFooter: `  ${ACCEPT_EDITS_TEXT}` },
    };
    type Seat = (typeof seats)[keyof typeof seats];
    /** Edit: the status slot (two rows above the opening rule) replaced by `row`. */
    const slot = (frame: string, row: string) => {
      const lines = frame.split("\n");
      lines[lines.findIndex(claudeBoxRow) - 3] = row;
      return lines.join("\n");
    };
    /** Edit: our text in the real live box row, under the footer Claude 2.1.296 draws while the box holds text. */
    const staged = (seat: Seat, text: string, frame = seat.frame) => editLine(editLine(frame, claudeBoxRow, `❯\u00a0${text}`), realFooter, seat.textFooter);
    const LIVE = "✶ Churning… (3s · ↓ 120 tokens)";
    // Edit: the turn running after Enter, as OpenRig's statusLine draws it: the live status row in the slot, the
    // footer unchanged (no `esc to interrupt`).
    const running = (seat: Seat) => slot(seat.frame, LIVE);
    const higherUp = (line: string) => line.startsWith("● I checked in") || line.startsWith("● I'm confirmed");

    async function runSeat(session: string, script: Script, text: string) {
      const [member, rigName] = session.split("@") as [string, string];
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, member.replace("-", "."), { role: "worker", runtime: "claude-code" });
      const row = sessionRegistry.registerSession(node.id, session);
      sessionRegistry.updateStatus(row.id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: session });
      const { tmux, log } = phasedTmux(script);
      const result = await transport(tmux, true).send(session, text, { verify: true });
      expectOnePasteOneEnter(result, log);
      return result;
    }

    it.each(Object.entries(seats))("R5-1 %s seat, idle after its turn: verified (box empty after Enter, then the turn running)", async (_name, seat) => {
      for (const afterEnter of [seat.frame, running(seat)]) {
        db.close(); db = createFullTestDb(); rigRepo = new RigRepository(db); sessionRegistry = new SessionRegistry(db);
        const result = await runSeat(seat.session, { frames: { prePaste: seat.frame, afterPaste: staged(seat, texts.short), afterEnter } }, texts.short);
        expect(result).toMatchObject({ verified: true, outcome: "delivered" });
      }
    });

    it.each([
      ["R5-2 running before the paste: the live status row in the slot", (seat: Seat) => ({
        prePaste: running(seat), afterPaste: staged(seat, texts.short, running(seat)), afterEnter: running(seat) }),
        { seat: "not-idle", before: "exact", after: "queued", sameProcess: true }],
      ["R5-3 running before the paste: the completion row in the slot, a live status row higher up", (seat: Seat) => ({
        prePaste: editLine(seat.frame, higherUp, LIVE), afterPaste: staged(seat, texts.short), afterEnter: running(seat) }),
        { seat: "not-idle", before: "exact", after: "empty", sameProcess: true }],
      ["R5-4 the completion row in the slot, the paste hint in the footer before the paste", (seat: Seat) => ({
        prePaste: editLine(seat.frame, realFooter, "  paste again to expand"), afterPaste: staged(seat, texts.short), afterEnter: running(seat) }),
        { seat: "not-idle", before: "exact", after: "empty", sameProcess: true }],
      ["R5-5 a completion row with a verb not on the bundle's list", (seat: Seat) => ({
        prePaste: slot(seat.frame, "✻ Marinated for 9s · done 10:50 PM"), afterPaste: staged(seat, texts.short), afterEnter: running(seat) }),
        { seat: "unknown", before: "exact", after: "empty", sameProcess: true }],
      ["R5-6 a completion row with trailing text", (seat: Seat) => ({
        prePaste: slot(seat.frame, "✻ Cooked for 9s · done 10:50 PM · 1 shell still running"), afterPaste: staged(seat, texts.short), afterEnter: running(seat) }),
        { seat: "unknown", before: "exact", after: "empty", sameProcess: true }],
      ["R5-7 an indented completion row", (seat: Seat) => ({
        prePaste: slot(seat.frame, "  ✻ Cooked for 9s · done 10:50 PM"), afterPaste: staged(seat, texts.short), afterEnter: running(seat) }),
        { seat: "unknown", before: "exact", after: "empty", sameProcess: true }],
    ] as const)("%s: unconfirmed", async (_id, frames, box) => {
      for (const seat of Object.values(seats)) {
        db.close(); db = createFullTestDb(); rigRepo = new RigRepository(db); sessionRegistry = new SessionRegistry(db);
        const result = await runSeat(seat.session, { frames: frames(seat) }, texts.short);
        expect(result.verified, seat.session).toBe(false);
        expect(result.outcome).toBe("rendered-unconfirmed");
      }
    });

    it("R5-8 a real seat's frame sent to another seat (another name on the box): unconfirmed", async () => {
      const result = await runSeat(seats.acceptEdits.session,
        { frames: { prePaste: seats.bypass.frame, afterPaste: staged(seats.bypass, texts.short), afterEnter: seats.bypass.frame } }, texts.short);
      expect(result).toMatchObject({ verified: false });
    });
  });

  describe("uncertainty from the capture: never a refusal, never a retry", () => {
    const frames = { prePaste: idle, afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") };

    it.each([
      ["T22 the pre-Enter capture returns null", { ...frames, afterPaste: null }, {}, { before: "unavailable", after: "empty", sameProcess: true }],
      ["T23 the pre-Enter capture throws", { ...frames, afterPaste: new Error("capture failed") }, {}, { before: "unavailable", after: "empty", sameProcess: true }],
      ["T26 the post capture returns null", { ...frames, afterEnter: null }, {}, { before: "exact", after: "unavailable", sameProcess: true }],
      ["T33 the pane process changed", frames, { afterPaste: 4242, afterEnter: 4343 }, { before: "exact", after: "empty", sameProcess: false }],
      ["T34 the pane process is unknown", frames, { afterPaste: null, afterEnter: null }, { before: "exact", after: "empty", sameProcess: false }],
    ] as Array<[string, Script["frames"], Script["pids"], object]>)("%s: unconfirmed, Enter once", async (_id, phases, pids, box) => {
      seedCanonicalRig("claude-code");
      const { result, log } = await run({ frames: phases, pids }, texts.submit, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ ok: true, verified: false, outcome: "rendered-unconfirmed" });
    });

    it("T27 the post capture throws: the existing catch branch, with the before reading kept", async () => {
      seedCanonicalRig("claude-code");
      const { result, log } = await run({ frames: { ...frames, afterEnter: new Error("capture failed") } }, texts.submit, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
    });

    it.each([
      ["T24 the pre-Enter capture never settles", { frames: { ...frames, afterPaste: "never" } } as Script],
      ["T25 the pre-Enter pid read never settles", { frames, pids: { afterPaste: "never" } } as Script],
    ])("%s: Enter waits at most 500 ms, then goes once; the late read is ignored", async (_id, script) => {
      vi.useFakeTimers();
      seedCanonicalRig("claude-code");
      const { tmux, log } = phasedTmux(script);
      const pending = transport(tmux, true).send(SESSION, texts.submit, { verify: true });
      await vi.advanceTimersByTimeAsync(499);
      expect(log).toContain("sendText");
      expect(log).not.toContain("sendKeys:Enter");
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
    });

    it("T28 the post pid read never settles: the result returns after 500 ms, unconfirmed", async () => {
      vi.useFakeTimers();
      seedCanonicalRig("codex");
      const { tmux, log } = phasedTmux({
        frames: { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
        pids: { afterEnter: "never" },
      });
      let settled = false;
      const pending = transport(tmux, true).send(SESSION, texts.submit, { verify: true }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(499);
      expect(log).toContain("sendKeys:Enter");
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false });
    });
  });

  describe("uncertainty from a changed binding", () => {
    it("T35 the binding's pane changes between Enter and the post read: unconfirmed", async () => {
      const { node } = seedCanonicalRig("codex");
      const { result, log } = await run({
        frames: { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") },
        onEnter: () => sessionRegistry.updateBinding(node.id, { tmuxSession: SESSION, tmuxPane: "%99" }),
      }, texts.submit, true);
      expectOnePasteOneEnter(result, log);
      expect(result).toMatchObject({ verified: false });
    });

    it("T36 Claude: a rebind during the pre-Enter read is refused by the existing recipient check, as today", async () => {
      const { node } = seedCanonicalRig("claude-code");
      const script: Script = {
        frames: { prePaste: idle, afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") },
        onAfterPasteCapture: () => sessionRegistry.updateBinding(node.id, { tmuxSession: SESSION, tmuxPane: "%99" }),
      };
      const { result, log } = await run(script, texts.submit, true);
      expect(result).toMatchObject({ ok: false, sent: true, reason: "target_runtime_conflict" });
      expect(log).not.toContain("sendKeys:Enter");
    });
  });

  describe("scope", () => {
    const claudeFrames = { prePaste: idle, afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") };

    it.each(["terminal", "stub", "pi", "omp", null])("T38 runtime %s: the setting is never read and nothing changes", async (runtime) => {
      seedCanonicalRig(runtime);
      const withoutDep = await run({ frames: claudeFrames }, texts.submit);
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      seedCanonicalRig(runtime);
      const setting = vi.fn(() => true);
      const { tmux, log } = phasedTmux({ frames: claudeFrames });
      const result = await transport(tmux, setting).send(SESSION, texts.submit, { verify: true });
      expect(setting).not.toHaveBeenCalled();
      expect(log).toEqual(withoutDep.log);
      expect(result).toEqual(withoutDep.result);
    });

    it("T39 without --verify: the setting is never read, no extra calls, no inputBox", async () => {
      seedCanonicalRig("claude-code");
      const setting = vi.fn(() => true);
      const { tmux, log } = phasedTmux({ frames: claudeFrames });
      const result = await transport(tmux, setting).send(SESSION, texts.submit);
      expect(setting).not.toHaveBeenCalled();
      expect(log.some((call) => call.startsWith("pid:") || call.startsWith("capture:afterPaste"))).toBe(false);
      expect(result.ok).toBe(true);
    });

    it("T40 submitOnly: unchanged with the setting on", async () => {
      seedCanonicalRig("claude-code");
      const opts: SendOpts = { verify: true, submitOnly: true, expectedStagedText: texts.submit };
      const frames = { prePaste: claude("submit-staged.J"), afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") };
      const off = await run({ frames }, "", undefined, opts);
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      seedCanonicalRig("claude-code");
      const on = await run({ frames }, "", true, opts);
      expect(on.log).toEqual(off.log);
      expect(on.result).toEqual(off.result);
      expect(on.log).not.toContain("sendText");
    });

    // Review round 1, change 4: an audited prompt answer reads no box, so with the setting on it says so plainly
    // (every inputBox field `unchecked`) and reads unconfirmed; it never falls back to today's count. In the echoed
    // case the frame after Enter shows the answer above an empty box, so today's count confirms it with the setting off.
    it.each([
      ["claude-code", false], ["codex", false], ["claude-code", true], ["codex", true],
    ] as const)("T41 an audited prompt answer to %s (answer echoed after Enter: %s): no box read, inputBox unchecked, unconfirmed", async (runtime, echoed) => {
      const answerFrame = (input: string, echo = "") => runtime === "codex" ? `${echo ? `› ${echo}\n\n` : ""}› ${input}\n\n  test-model · ~/example`
        : `${echo ? `❯ ${echo}\n\n` : ""}────────────────────\n❯ ${input}\n────────────────────\n\n  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;
      const frames = { prePaste: answerFrame(""), afterPaste: answerFrame("green please"), afterEnter: answerFrame("", echoed ? "green please" : "") };
      const answer = async (setting?: boolean) => {
        seedCanonicalRig(runtime);
        const eventBus = new EventBus(db);
        const activity = new AgentActivityStore({ db, eventBus });
        activity.recordHookEvent({ runtime, sessionName: SESSION, hookEvent: "PermissionRequest", subtype: "Bash" });
        const { tmux, log } = phasedTmux({ frames });
        const result = await new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus, agentActivityStore: activity,
          sleep: async () => {}, ...(setting === undefined ? {} : { verifyInputBox: () => setting }) })
          .send(SESSION, "green please", { verify: true, dangerouslyInteract: true, reason: "answer the text field" });
        return { result, log };
      };
      const off = await answer();
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      const on = await answer(true);
      expect(on.log).toEqual(off.log);
      expect(on.log.some((call) => call.startsWith("pid:"))).toBe(false);
      expect(off.result.promptInteraction).toBe("enter-sent");
      expect(off.result.verified).toBe(echoed);
      expect(on.result.promptInteraction).toBe("enter-sent");
      expect(on.result).toMatchObject({ ok: true, verified: false, outcome: "rendered-unconfirmed" });
    });

    it.each(["claude-code", "codex"] as const)("T41c an audited prompt answer to %s that is not visibly staged (no Enter): inputBox unchecked", async (runtime) => {
      const answerFrame = (input: string) => runtime === "codex" ? `› ${input}\n\n  test-model · ~/example`
        : `────────────────────\n❯\u00a0${input}\n────────────────────\n\n  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;
      // The answer never shows in the prompt, so the existing path sends no Enter.
      const frames = { prePaste: answerFrame(""), afterPaste: answerFrame(""), afterEnter: answerFrame("") };
      const answer = async (setting?: boolean) => {
        seedCanonicalRig(runtime);
        const eventBus = new EventBus(db);
        const activity = new AgentActivityStore({ db, eventBus });
        activity.recordHookEvent({ runtime, sessionName: SESSION, hookEvent: "PermissionRequest", subtype: "Bash" });
        const { tmux, log } = phasedTmux({ frames });
        const result = await new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus, agentActivityStore: activity,
          sleep: async () => {}, ...(setting === undefined ? {} : { verifyInputBox: () => setting }) })
          .send(SESSION, "green please", { verify: true, dangerouslyInteract: true, reason: "answer the text field" });
        return { result, log };
      };
      const off = await answer();
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      const on = await answer(true);
      expect(on.log).toEqual(off.log);
      expect(on.log.some((call) => call.startsWith("sendKeys"))).toBe(false);
      expect(off.result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed", promptInteraction: "unverified" });
      expect(on.result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed", promptInteraction: "unverified" });
    });

    it.each(["claude-code", "codex"] as const)("T41d an audited prompt answer to %s whose capture after Enter fails: inputBox unchecked", async (runtime) => {
      const answerFrame = (input: string) => runtime === "codex" ? `› ${input}\n\n  test-model · ~/example`
        : `────────────────────\n❯\u00a0${input}\n────────────────────\n\n  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;
      const frames = { prePaste: answerFrame(""), afterPaste: answerFrame("green please"), afterEnter: new Error("capture failed") };
      const answer = async (setting?: boolean) => {
        seedCanonicalRig(runtime);
        const eventBus = new EventBus(db);
        const activity = new AgentActivityStore({ db, eventBus });
        activity.recordHookEvent({ runtime, sessionName: SESSION, hookEvent: "PermissionRequest", subtype: "Bash" });
        const { tmux, log } = phasedTmux({ frames });
        const result = await new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus, agentActivityStore: activity,
          sleep: async () => {}, ...(setting === undefined ? {} : { verifyInputBox: () => setting }) })
          .send(SESSION, "green please", { verify: true, dangerouslyInteract: true, reason: "answer the text field" });
        return { result, log };
      };
      const off = await answer();
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      const on = await answer(true);
      expect(on.log).toEqual(off.log);
      expect(off.result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed", promptInteraction: "enter-sent" });
      expect(on.result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed", promptInteraction: "enter-sent" });
    });

    it("T42 the setting is read fresh per send", async () => {
      seedCanonicalRig("codex");
      let on = false;
      const frames = { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") };
      const first = phasedTmux({ frames });
      const second = phasedTmux({ frames });
      let current = first;
      const tmux = new Proxy({} as TmuxAdapter, { get: (_target, key) => (current.tmux as unknown as Record<string | symbol, unknown>)[key] });
      const t = transport(tmux, () => on);
      const before = await t.send(SESSION, texts.submit, { verify: true });
      on = true;
      current = second;
      const after = await t.send(SESSION, texts.submit, { verify: true });
      expect(first.log.some((call) => call.startsWith("pid:"))).toBe(false);
      expect(second.log.some((call) => call.startsWith("pid:"))).toBe(true);
    });

    it("a setting read that throws reads off", async () => {
      seedCanonicalRig("codex");
      const frames = { prePaste: codex("idle"), afterPaste: codex("submit-staged.J"), afterEnter: codex("after-enter-0.4s.J") };
      const { tmux, log } = phasedTmux({ frames });
      const result = await transport(tmux, () => { throw new Error("settings unreadable"); }).send(SESSION, texts.submit, { verify: true });
      expectOnePasteOneEnter(result, log);
    });
  });
});

describe("transport.verify_input_box production wiring", () => {
  interface StageRecord { site: string }
  class RecordingStageTimer {
    readonly records: StageRecord[] = [];
    async runStage<T>(site: string, fn: () => Promise<T>): Promise<T> {
      try { return await fn(); } finally { this.records.push({ site }); }
    }
  }
  const pluginVendorUrl = "https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz";

  it.each([
    ["W1 on", "1"],
    ["W2 off", "0"],
  ] as const)("%s: settings store → startup → transport → real TmuxAdapter: the reads, their order and their stages", async (_id, setting) => {
    const env = { kernel: process.env.OPENRIG_NO_KERNEL, setting: process.env.OPENRIG_TRANSPORT_VERIFY_INPUT_BOX };
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.OPENRIG_TRANSPORT_VERIFY_INPUT_BOX = setting;
    const timer = new RecordingStageTimer();
    const pane = "%42";
    let phase: "prePaste" | "afterPaste" | "afterEnter" = "prePaste";
    let logging = false;
    const commands: string[] = [];
    const frames = { prePaste: claude("idle-fresh-suggestion"), afterPaste: claude("submit-staged.J"), afterEnter: claude("after-enter-0.4s.J") };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== pluginVendorUrl) throw new Error(`unexpected startup fetch: ${url}`);
      return new Response(null, { status: 404 });
    };
    let daemon: Awaited<ReturnType<typeof createDaemon>>;
    try {
      daemon = await createDaemon({
        dbPath: ":memory:",
        tmuxExec: async (command: string) => {
          if (logging) commands.push(command);
          if (command.includes("paste-buffer")) phase = "afterPaste";
          if (command.includes("send-keys") && command.includes("Enter")) phase = "afterEnter";
          if (command.includes("capture-pane")) return frames[phase];
          if (command.includes("list-panes")) return `${pane}|0|/fixture|80|24|1`;
          // The pane process appears once the paste has happened; before it, the existing Claude recipient check
          // reads no pid and proceeds with its advisory (no process listing in this test).
          if (command.includes("#{pane_pid}")) return phase === "prePaste" ? "" : "4242";
          return "";
        },
        cmuxExec: async () => "",
        slowOpRecorder: timer,
      } as never);
    } finally {
      globalThis.fetch = originalFetch;
    }
    try {
      const rig = daemon.deps.rigRepo.createRig("wiring-rig");
      const node = daemon.deps.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
      const session = daemon.deps.sessionRegistry.registerSession(node.id, "dev-impl@wiring-rig");
      daemon.deps.sessionRegistry.updateStatus(session.id, "running");
      daemon.deps.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@wiring-rig", tmuxPane: pane });
      logging = true;
      const result = await daemon.deps.sessionTransport!.send("dev-impl@wiring-rig", texts.submit, { verify: true });

      expect(result.ok, JSON.stringify({ reason: result.reason, error: result.error })).toBe(true);
      const paste = commands.findIndex((command) => command.includes("paste-buffer"));
      const enter = commands.findIndex((command) => command.includes("send-keys") && command.includes("Enter"));
      const between = commands.slice(paste + 1, enter);
      if (setting === "0") {
        // Off: today's transcript verdict, no box read, no pid read, no new stage.
        expect(result).toMatchObject({ verified: true, outcome: "delivered" });
        expect(between.filter((command) => !command.includes("list-panes"))).toEqual([]);
        // After Enter only the existing post capture (the existing Claude recipient check reads the pid before the paste).
        expect(commands.slice(enter + 1).map((command) => command.includes("capture-pane") ? "capture" : command.includes("#{pane_pid}") ? "pid" : "other"))
          .toEqual(["capture"]);
        expect(timer.records.map((record) => record.site)).toEqual([
          "session_transport.pre_capture",
          "session_transport.send_text",
          "session_transport.submit",
          "session_transport.post_capture",
        ]);
        return;
      }
      expect(result).toMatchObject({ verified: true, outcome: "delivered" });
      // Besides the two new reads, only the adapter's existing guard runs before Enter (it resolves the pane).
      expect(between.filter((command) => !command.includes("list-panes"))).toHaveLength(2);
      expect(between.findLastIndex((command) => command.includes("list-panes"))).toBe(between.length - 1);
      expect(between.filter((command) => command.includes("capture-pane"))).toEqual([expect.stringMatching(/capture-pane -p -t \S+ -S -30$/)]);
      expect(between.filter((command) => command.includes("#{pane_pid}"))).toHaveLength(1);
      const after = commands.slice(enter + 1);
      expect(after.map((command) => command.includes("capture-pane") ? "capture" : command.includes("#{pane_pid}") ? "pid" : "other"))
        .toEqual(["capture", "pid"]);
      expect(timer.records.map((record) => record.site)).toEqual([
        "session_transport.pre_capture",
        "session_transport.send_text",
        "session_transport.input_box_capture",
        "session_transport.submit",
        "session_transport.post_capture",
        "session_transport.input_box_pane_pid",
      ]);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      for (const [key, value] of [["OPENRIG_NO_KERNEL", env.kernel], ["OPENRIG_TRANSPORT_VERIFY_INPUT_BOX", env.setting]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 10_000);
});
