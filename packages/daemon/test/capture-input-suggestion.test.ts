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

  it("Claude Code's Try \"...\" words in an unstyled capture, cursor at their start, are only a possible suggestion: the words never stand in for faint styling", () => {
    const lines = frame("claude-code-2.1.296/idle-fresh-suggestion.txt");
    const row = lines.findLastIndex((line) => line.startsWith("❯"));
    const box = annotateInputBox(lines.join("\n"), cursorAt(2, row), "claude-code");
    expect(box).toMatchObject({ status: "likely-suggestion", confidence: "medium", suggestion: { text: 'Try "fix typecheck errors"' } });
    expect(box.hint).toContain("possibly a Claude Code suggestion");
    expect(box.hint).not.toContain("not something the person typed");
  });

  it("Try \"...\" words drawn partly faint and partly not, cursor at their start, are unknown: the words don't override contradictory styling", () => {
    const { screen, row } = withPrompt("claude-code-2.1.296/staged-short.raw.txt", "❯", `Try "run ${FAINT("unit tests")}"`);
    const box = annotateInputBox(screen, cursorAt(2, row), "claude-code");
    expect(box).toMatchObject({ status: "unknown", confidence: "unknown", suggestion: null });
    expect(box.hint).not.toContain("not something the person typed");
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

  it("an empty frame reads empty only with a steady cursor in it: outside, moved or missing, it's unknown", () => {
    const rule = "─".repeat(40);
    const screen = STYLED + ["Example:", rule, "❯ ", rule, "Working…"].join("\n");
    const outside = annotateInputBox(screen, cursorAt(0, 4), "claude-code");
    expect(outside).toMatchObject({ status: "unknown", confidence: "unknown", input: null, suggestion: null });
    expect(outside.evidence).toEqual(["no text in the input box", "cursor outside the input box"]);
    expect(annotateInputBox(screen, null, "claude-code", { cursorMoved: true })).toMatchObject({ status: "unknown", confidence: "unknown" });
    expect(annotateInputBox(screen, cursorAt(2, 2), "claude-code")).toMatchObject({ status: "empty", confidence: "high" });
    const missing = annotateInputBox(screen, null, "claude-code");
    expect(missing).toMatchObject({ status: "unknown", confidence: "unknown", input: null });
    expect(missing.evidence).toEqual(["no text in the input box", "cursor unavailable"]);
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

  async function makeTransport(getPaneCursorPosition: (promptRow: number) => Promise<unknown>, screenOverride?: string) {
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const prompt = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    const screen = screenOverride ?? prompt.screen;
    const row = prompt.row;
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

  it("when one cursor read fails, an outside reading from the other is kept: an empty frame and faint text both read unknown", async () => {
    const rule = "─".repeat(40);
    const emptyFrame = STYLED + ["Example:", rule, "❯ ", rule, "Working…"].join("\n");
    const firstOutsideThenFailed = () => {
      let call = 0;
      return async (row: number) => (call++ === 0 ? cursorAt(0, row + 2) : null);
    };
    const empty = await makeTransport(firstOutsideThenFailed(), emptyFrame);
    const emptyBox = (await empty.make("claude-code").capture("seat@rig", { inputBox: true })) as { inputBox: { status: string; cursor: unknown; evidence: string[] } };
    expect(emptyBox.inputBox).toMatchObject({ status: "unknown", cursor: null });
    expect(emptyBox.inputBox.evidence).toEqual(["no text in the input box", "cursor outside the input box (the other cursor read failed)"]);
    const faint = await makeTransport(firstOutsideThenFailed());
    const faintBox = (await faint.make("claude-code").capture("seat@rig", { inputBox: true })) as { inputBox: { status: string; evidence: string[]; hint: string } };
    expect(faintBox.inputBox).toMatchObject({ status: "unknown" });
    expect(faintBox.inputBox.evidence[0]).toBe("cursor outside the input box (the other cursor read failed)");
    expect(faintBox.inputBox.hint).not.toContain("not something the person typed");
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

  it("the capture route reads the input box only when the request asks (rig capture and MCP ask; send --verify and walk don't)", async () => {
    const capture = vi.fn(async (sessionName: string, _opts?: unknown) => ({ ok: true, sessionName, content: "x\n", lines: 20 }));
    const transport = { capture, resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "a@r" }, { sessionName: "b@r" }] }) };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
    app.route("/api/transport", transportRoutes());
    const post = (body: unknown) => app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{ session: "a@r", lines: 30 }, { session: "a@r", inputBox: true }, { rig: "r" }, { rig: "r", inputBox: true }]) {
      expect((await post(body)).status).toBe(200);
    }
    expect(capture.mock.calls.map(([session, opts]) => [session, (opts as { inputBox?: boolean }).inputBox === true])).toEqual([
      ["a@r", false], ["a@r", true], ["a@r", false], ["b@r", false], ["a@r", true], ["b@r", true],
    ]);
  });

  it("a rig capture's input-box reads share one 1 s budget, so slow tmux adds about 1 s to the fan-out, not 1 s per seat", async () => {
    vi.useFakeTimers();
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const { screen, row } = withPrompt("claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", "❯", FAINT("/compact"));
    const slowCursor = () => new Promise((resolve) => setTimeout(() => resolve(cursorAt(2, row)), 300));
    const tmux = {
      probeSession: vi.fn(async () => ({ state: "present" })),
      capturePaneContent: vi.fn(async (_s: string, lines: number, opts?: { escapeSequences?: boolean }) => (opts?.escapeSequences ? screen : `plain ${lines}`)),
      getPaneCursorPosition: vi.fn(slowCursor),
    };
    const seats = ["s1@r", "s2@r", "s3@r", "s4@r", "s5@r"];
    const transport = Object.create(SessionTransport.prototype) as InstanceType<typeof SessionTransport>;
    Object.assign(transport, {
      tmuxAdapter: tmux,
      getSessionMeta: () => ({ runtime: "claude-code", attachmentType: "tmux", nodeId: "n1", pane: "%1", occupant: null, resumeToken: null }),
      absenceProbeTarget: () => null,
      now: () => new Date(),
      recordSessionMissingVerdict: () => {},
      reconcileStartupReadiness: async () => {},
      resolveSessions: async () => ({ ok: true, sessions: seats.map((sessionName) => ({ sessionName })) }),
    });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
    app.route("/api/transport", transportRoutes());
    let settled: unknown = "pending";
    void app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rig: "r", inputBox: true }) })
      .then(async (res) => { settled = await res.json(); });
    // Each seat's three reads take 600 ms here; five seats with a 1 s deadline each would take 3 s.
    await vi.advanceTimersByTimeAsync(1_200);
    expect(settled).not.toBe("pending");
    const results = (settled as { results: Array<{ ok: boolean; content: string; inputBox: { status: string; hint: string } }> }).results;
    expect(results.map((r) => [r.ok, r.content])).toEqual(seats.map(() => [true, "plain 20"]));
    expect(results[0]!.inputBox.status).toBe("likely-suggestion");
    expect(results[1]!.inputBox).toMatchObject({ status: "unknown" });
    expect(results[1]!.inputBox.hint).toContain("didn't finish");
    for (const r of results.slice(2)) {
      expect(r.inputBox).toMatchObject({ status: "unknown", confidence: "unknown", input: null });
      expect(r.inputBox.hint).toContain("wasn't read");
    }
  });
});
