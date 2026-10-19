// Founder requirement (2026-10-18): `rig capture` says which input-box text is likely a harness suggestion (ghost
// text) rather than the person's input, from the cursor and the text's styling, with unknown when it can't tell.
// The frames are real Claude Code 2.1.296 and Codex 0.160.0 screens (fixtures/input-box); styling and cursor
// positions are added per case, since the frames were captured as plain text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { annotateInputBox } from "../src/domain/session-transport.js";
import { transportRoutes } from "../src/routes/transport.js";

const FIXTURES = join(import.meta.dirname, "fixtures/input-box");
const frame = (name: string): string[] => readFileSync(join(FIXTURES, name), "utf8").replace(/\n$/, "").split("\n");
const FAINT = (text: string) => `\x1b[2m${text}\x1b[22m`;
const STYLED = "\x1b[0m"; // any SGR makes the capture a styled one, so "not faint" is evidence
const cursorAt = (x: number, y: number) => ({ x, y, width: 120, height: 40 });

/** A frame with its prompt row replaced, styled, as a capture with -e returns it. */
function withPrompt(name: string, glyph: string, styledText: string): { screen: string; row: number } {
  const lines = frame(name);
  const row = lines.findLastIndex((line) => line.startsWith(glyph));
  lines[row] = `${STYLED}${glyph} ${styledText}`;
  return { screen: lines.join("\n"), row };
}

describe("annotateInputBox: Claude Code", () => {
  it("an empty input box is empty", () => {
    const lines = frame("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt");
    const row = lines.findLastIndex((line) => line.startsWith("❯"));
    const box = annotateInputBox(STYLED + lines.join("\n"), cursorAt(2, row), "claude-code");
    expect(box).toMatchObject({ status: "empty", confidence: "high", input: null, suggestion: null });
  });

  it("faint text with the cursor at the input's start is likely a suggestion, bounded and labelled as not the person's", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    const box = annotateInputBox(screen, cursorAt(2, row), "claude-code");
    expect(box).toMatchObject({
      status: "likely-suggestion", confidence: "high", cursor: { x: 2, y: row },
      input: { startRow: row, startCol: 2, endRow: row, endCol: 10, text: "/compact" },
      suggestion: { startRow: row, startCol: 2, endRow: row, endCol: 10, text: "/compact" },
    });
    expect(box.evidence).toEqual(["cursor at the input's start", "text drawn faint"]);
    expect(box.hint).toContain("not something the person typed");
    expect(box.hint).toContain("isn't their intent, a draft or a staged command");
  });

  it("Claude Code's Try \"...\" suggestion with the cursor at its start reads as a suggestion even unstyled", () => {
    const lines = frame("claude-code-2.1.296/idle-fresh-suggestion.txt");
    const row = lines.findLastIndex((line) => line.startsWith("❯"));
    const box = annotateInputBox(lines.join("\n"), cursorAt(2, row), "claude-code");
    expect(box).toMatchObject({ status: "likely-suggestion", confidence: "high", suggestion: { text: 'Try "fix typecheck errors"' } });
  });

  it("a typed draft with the cursor after it is the person's input", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/staged-short.raw.txt", "❯", "Queue handoff: qitem-capture-0001 - check your queue.");
    const box = annotateInputBox(screen, cursorAt(2 + 53, row), "claude-code");
    expect(box).toMatchObject({ status: "typed", confidence: "high", suggestion: null, input: { text: "Queue handoff: qitem-capture-0001 - check your queue." } });
    expect(box.hint).toContain("likely typed by the person");
  });

  it("a typed draft with the cursor moved inside it is still the person's input, not a suggestion", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/staged-short.raw.txt", "❯", "Queue handoff: qitem-capture-0001 - check your queue.");
    const box = annotateInputBox(screen, cursorAt(2 + 10, row), "claude-code");
    expect(box).toMatchObject({ status: "typed", confidence: "medium", suggestion: null });
    expect(box.evidence[0]).toBe("cursor inside the text");
  });

  it("typed text followed by a faint completion after the cursor bounds only the completion as the suggestion", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", `/com${FAINT("pact")}`);
    const box = annotateInputBox(screen, cursorAt(6, row), "claude-code");
    expect(box).toMatchObject({
      status: "typed-with-suggestion", confidence: "high",
      input: { text: "/compact" }, suggestion: { startRow: row, startCol: 6, endRow: row, endCol: 10, text: "pact" },
    });
  });

  it("unfaint text with the cursor at its start is unknown: the person may have moved the cursor back", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/staged-short.raw.txt", "❯", "Queue handoff: qitem-capture-0001 - check your queue.");
    expect(annotateInputBox(screen, cursorAt(2, row), "claude-code")).toMatchObject({ status: "unknown", confidence: "unknown", suggestion: null });
  });

  it("typed Try \"...\" text that isn't faint stays unknown with the cursor at its start or outside the box: the shape alone doesn't beat the styling", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/staged-short.raw.txt", "❯", 'Try "run unit tests"');
    for (const cursor of [cursorAt(2, row), cursorAt(0, row - 3)]) {
      const box = annotateInputBox(screen, cursor, "claude-code");
      expect(box).toMatchObject({ status: "unknown", confidence: "unknown", suggestion: null });
      expect(box.hint).not.toContain("not something the person typed");
    }
  });

  it("faint text with a cursor that moved during the read is unknown, not a suggestion", () => {
    const { screen } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    const box = annotateInputBox(screen, null, "claude-code", { cursorMoved: true });
    expect(box).toMatchObject({ status: "unknown", confidence: "unknown", suggestion: null });
    expect(box.hint).not.toContain("not something the person typed");
  });

  it("a medium-confidence suggestion is worded as possible, never as not the person's text", () => {
    const { screen } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    const box = annotateInputBox(screen, null, "claude-code");
    expect(box).toMatchObject({ status: "likely-suggestion", confidence: "medium" });
    expect(box.hint).toContain("possibly a Claude Code suggestion");
    expect(box.hint).not.toContain("not something the person typed");
  });

  it("committed scrollback is never the box: a committed ❯ message above a box row that isn't a prompt reads as no input box", () => {
    const lines = frame("claude-code-2.1.296/after-enter-15s.J.txt");
    const live = lines.findLastIndex((line) => line.startsWith("❯"));
    lines[live] = "! ls";
    const box = annotateInputBox(STYLED + lines.join("\n"), cursorAt(4, live), "claude-code");
    expect(box).toMatchObject({ status: "no-input-box", input: null, suggestion: null });
  });

  it("a prompt-looking line and a rule in output, with no input box, are not an input box", () => {
    const screen = STYLED + ["Previous example:", '❯ Try "run unit tests"', "────────────────────", "Working…"].join("\n");
    expect(annotateInputBox(screen, cursorAt(0, 3), "claude-code")).toMatchObject({ status: "no-input-box", input: null, suggestion: null });
  });

  it("a wrapped draft spans its rows; typed with the cursor after its last row, a suggestion when faint with the cursor at its start", () => {
    const lines = frame("claude-code-2.1.296/staged-wrapped.raw.txt");
    const first = lines.findLastIndex((line) => line.startsWith("❯"));
    const last = first + 2;
    const typed = annotateInputBox(STYLED + lines.join("\n"), cursorAt(lines[last]!.trimEnd().length, last), "claude-code");
    expect(typed).toMatchObject({ status: "typed", input: { startRow: first, startCol: 2, endRow: last } });
    expect(typed.input!.text.split("\n")).toHaveLength(3);
    const faint = [...lines];
    faint[first] = `❯ ${FAINT(lines[first]!.slice(2))}`;
    for (const row of [first + 1, last]) faint[row] = `  ${FAINT(lines[row]!.slice(2))}`;
    const suggested = annotateInputBox(faint.join("\n"), cursorAt(2, first), "claude-code");
    expect(suggested).toMatchObject({ status: "likely-suggestion", confidence: "high", suggestion: { startRow: first, endRow: last } });
  });

  it("with the slash-command menu open below the box, the box's typed text is input and the menu rows aren't", () => {
    const lines = frame("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt");
    const row = lines.findLastIndex((line) => line.startsWith("❯"));
    lines[row] = `${STYLED}❯ /com`;
    lines.splice(row + 2, lines.length - row - 2, "  /compact     Clear conversation history but keep a summary", "  /config      Open config panel");
    const box = annotateInputBox(lines.join("\n"), cursorAt(6, row), "claude-code");
    expect(box).toMatchObject({ status: "typed", input: { startRow: row, endRow: row, text: "/com" } });
  });

  it("busy output above the box is never part of the input", () => {
    const lines = frame("claude-code-2.1.296/after-enter-0.4s.J.txt");
    const row = lines.findLastIndex((line) => line.startsWith("❯"));
    const box = annotateInputBox(STYLED + lines.join("\n"), cursorAt(2, row), "claude-code");
    expect(box).toMatchObject({ status: "empty", input: null });
    expect(annotateInputBox(STYLED + ["✶ Marinating… ", "", "output line one", "output line two"].join("\n"), cursorAt(0, 3), "claude-code"))
      .toMatchObject({ status: "no-input-box", confidence: "unknown", input: null });
  });

  it("with no cursor, faint text is a suggestion at medium confidence and unfaint text is unknown", () => {
    const { screen } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    expect(annotateInputBox(screen, null, "claude-code")).toMatchObject({ status: "likely-suggestion", confidence: "medium", cursor: null });
    const typed = withPrompt("claude-code-2.1.296/staged-short.raw.txt", "❯", "Queue handoff: qitem-capture-0001 - check your queue.");
    const box = annotateInputBox(typed.screen, null, "claude-code", { cursorMoved: true });
    expect(box).toMatchObject({ status: "unknown", confidence: "unknown" });
    expect(box.evidence[0]).toBe("cursor moved during the capture");
  });

  it("a cursor outside the box is unknown", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", "/compact");
    expect(annotateInputBox(screen, cursorAt(0, row - 3), "claude-code")).toMatchObject({ status: "unknown", evidence: ["cursor outside the input box", "text not faint"] });
  });

  it("an unreadable screen is unknown, never a guess", () => {
    expect(annotateInputBox(null, cursorAt(2, 2), "claude-code")).toMatchObject({ status: "unknown", confidence: "unknown", input: null });
  });
});

describe("annotateInputBox: Codex", () => {
  it("Codex's empty placeholder is an empty box", () => {
    const lines = frame("codex-0.160.0/idle.txt");
    const row = lines.findLastIndex((line) => line.startsWith("›"));
    expect(annotateInputBox(STYLED + lines.join("\n"), cursorAt(2, row), "codex")).toMatchObject({ status: "empty" });
  });

  it("typed text with the cursor after it is input; unfaint text with the cursor at its start is unknown, as in Claude Code", () => {
    const { screen, row } = withPrompt("codex-0.160.0/staged-short.raw.txt", "›", "Queue handoff: qitem-capture-0001 - check your queue.");
    expect(annotateInputBox(screen, cursorAt(2 + 53, row), "codex")).toMatchObject({ status: "typed", confidence: "high" });
    const start = annotateInputBox(screen, cursorAt(2, row), "codex");
    expect(start).toMatchObject({ status: "unknown", confidence: "unknown", suggestion: null });
    expect(start.hint).not.toContain("not something the person typed");
  });

  it("faint text with the cursor at its start is likely a suggestion", () => {
    const { screen, row } = withPrompt("codex-0.160.0/staged-short.raw.txt", "›", FAINT("Explain this codebase"));
    expect(annotateInputBox(screen, cursorAt(2, row), "codex")).toMatchObject({ status: "likely-suggestion", confidence: "high", suggestion: { text: "Explain this codebase" } });
  });
});

describe("rig capture reports the input box for agent seats only, leaving the pane text as it was", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function makeTransport(getPaneCursorPosition: (promptRow: number) => Promise<unknown>) {
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const { screen, row } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    const capturePaneContent = vi.fn(async (_s: string, lines: number, opts?: { escapeSequences?: boolean }) => (opts?.escapeSequences ? screen : `plain ${lines}`));
    const cursor = vi.fn(() => getPaneCursorPosition(row));
    const tmux = { probeSession: vi.fn(async () => ({ state: "present" })), capturePaneContent, getPaneCursorPosition: cursor };
    const make = (runtime: string) => {
      const transport = Object.create(SessionTransport.prototype) as InstanceType<typeof SessionTransport>;
      Object.assign(transport, {
        tmuxAdapter: tmux,
        getSessionMeta: () => ({ runtime, attachmentType: "tmux", nodeId: "n1", pane: "%1", occupant: null, resumeToken: null }),
        absenceProbeTarget: () => null,
        now: () => new Date(),
        recordSessionMissingVerdict: () => {},
        reconcileStartupReadiness: async () => {},
      });
      return transport;
    };
    return { make, capturePaneContent, cursor };
  }

  it("adds inputBox from a styled visible-screen read and two cursor reads when asked, and keeps content unchanged", async () => {
    const { make, capturePaneContent } = await makeTransport(async (row) => cursorAt(2, row));
    const agent = await make("claude-code").capture("seat@rig", { inputBox: true });
    expect(agent).toMatchObject({ ok: true, content: "plain 20", lines: 20, inputBox: { status: "likely-suggestion", suggestion: { text: "/compact" } } });
    expect(capturePaneContent).toHaveBeenCalledWith("seat@rig", 0, { escapeSequences: true });
    const shell = await make("terminal").capture("seat@rig", { inputBox: true });
    expect(shell).toEqual({ ok: true, sessionName: "seat@rig", content: "plain 20", lines: 20 });
  });

  it("a caller that doesn't ask (the preview routes, attention recovery) gets main's result with no extra reads", async () => {
    const { make, capturePaneContent, cursor } = await makeTransport(async (row) => cursorAt(2, row));
    const agent = await make("claude-code").capture("seat@rig", { lines: 50 });
    expect(agent).toEqual({ ok: true, sessionName: "seat@rig", content: "plain 50", lines: 50 });
    expect(capturePaneContent).toHaveBeenCalledTimes(1);
    expect(cursor).not.toHaveBeenCalled();
  });

  it("a stalled input-box read doesn't hold the capture: it returns the pane text with the input box unknown", async () => {
    vi.useFakeTimers();
    const { make } = await makeTransport(() => new Promise(() => {}));
    let settled: unknown = "pending";
    void make("claude-code").capture("seat@rig", { inputBox: true }).then((result) => { settled = result; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toMatchObject({ ok: true, content: "plain 20", lines: 20, inputBox: { status: "unknown", confidence: "unknown", input: null, suggestion: null } });
    expect((settled as { inputBox: { hint: string } }).inputBox.hint).toContain("didn't finish");
  });

  it("a failed input-box read leaves the capture as it was, with the input box unknown", async () => {
    const { make } = await makeTransport(async () => { throw new Error("tmux went away"); });
    expect(await make("claude-code").capture("seat@rig", { inputBox: true }))
      .toMatchObject({ ok: true, content: "plain 20", inputBox: { status: "unknown", confidence: "unknown", input: null } });
  });

  it("a pane that resized between the cursor reads counts as a moved cursor, so faint text is unknown", async () => {
    let call = 0;
    const { make } = await makeTransport(async (row) => ({ ...cursorAt(2, row), width: call++ === 0 ? 120 : 100 }));
    const box = (await make("claude-code").capture("seat@rig", { inputBox: true })) as { inputBox: { status: string; cursor: unknown; evidence: string[] } };
    expect(box.inputBox).toMatchObject({ status: "unknown", cursor: null });
    expect(box.inputBox.evidence[0]).toBe("cursor moved during the capture");
  });

  it("the capture route asks for the input box, for one seat and for a rig (what the CLI and MCP read)", async () => {
    const capture = vi.fn(async (sessionName: string, _opts?: unknown) => ({ ok: true, sessionName, content: "x\n", lines: 20 }));
    const transport = { capture, resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "a@r" }, { sessionName: "b@r" }] }) };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
    app.route("/api/transport", transportRoutes());
    const post = (body: unknown) => app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ session: "a@r", lines: 30 })).status).toBe(200);
    expect((await post({ rig: "r" })).status).toBe(200);
    expect(capture.mock.calls).toEqual([
      ["a@r", { lines: 30, inputBox: true }],
      ["a@r", { lines: undefined, inputBox: true }],
      ["b@r", { lines: undefined, inputBox: true }],
    ]);
  });
});
