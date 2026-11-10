// Hermetic tests for the pane compositor: the bottom live region that keeps the
// operator's draft out of the transcript, pins the latest diagnostic as a copy
// (never the only one), flushes a held streamed tail when input goes away, and
// follows terminal resizes. No live pi.

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  composeLayout, createPaneCompositor, createRunnerInput, RunnerCore, type RunnerIo,
} from "../src/adapters/pi-runner.js";

function paneOut(columns: number | null = 40) {
  let buf = "";
  const output = Object.assign(new PassThrough(), typeof columns === "number" ? { isTTY: true, columns } : {});
  output.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { output: output as unknown as NodeJS.WriteStream, text: () => buf };
}

// ── One physical layout model ────────────────────────────────────────────────

describe("compose layout", () => {
  it("counts plain text as one row and places the caret at its end", () => {
    expect(composeLayout("ab", 40)).toEqual({ rows: 1, caretRow: 0, caretColumn: 2 });
  });

  it("wraps wide characters whole: a CJK glyph that does not fit starts the next row", () => {
    // Width 4: "abc" fills columns 0-2, 漢 needs two cells and only one is left, so it
    // wraps — three terminal rows would be wrong; the terminal uses two.
    expect(composeLayout("abc漢", 4)).toEqual({ rows: 2, caretRow: 1, caretColumn: 2 });
  });

  it("lays a 90-glyph CJK draft at width 40 into five rows", () => {
    expect(composeLayout("寛".repeat(90), 40).rows).toBe(5);
  });

  it("starts a new row at an explicit newline and puts the caret on that row", () => {
    expect(composeLayout("line1\nab", 40, 6)).toEqual({ rows: 2, caretRow: 1, caretColumn: 0 });
    expect(composeLayout("line1\nab", 40, 8)).toEqual({ rows: 2, caretRow: 1, caretColumn: 2 });
  });
});

// ── The compositor's transcript contract ─────────────────────────────────────

describe("pane compositor", () => {
  it("keeps draftless streaming byte-identical to the bare renderer", () => {
    const { output, text } = paneOut();
    const pane = createPaneCompositor(output);
    pane.transcript("The quick ");
    pane.transcript("brown fox\n");
    pane.line("jumps over");
    expect(text()).toBe("The quick brown fox\njumps over\n");
  });

  it("writes complete streamed lines above a draft exactly once and holds the unfinished tail", () => {
    const { output, text } = paneOut();
    const pane = createPaneCompositor(output);
    pane.attach(() => "my draft", () => output.write("my draft"), () => 0);
    pane.transcript("streamed words here\npartial");
    const raw = text();
    expect(raw.match(/streamed words here/g)).toHaveLength(1);
    expect(raw).not.toContain("partial");
    pane.transcript(" tail\n");
    expect(text().match(/partial tail\n/g)).toHaveLength(1);
  });

  it("pins diagnostics to a status line, as a copy, and drops the pin on clearStatus", () => {
    const { output, text } = paneOut(60);
    const pane = createPaneCompositor(output);
    pane.attach(() => "draft", () => output.write("draft"), () => 0);
    pane.line("transcript line");
    pane.line("[pi-runner] ERROR quota reached, with long trailing advice for the operator");
    pane.diagnostic("[pi-runner] ERROR quota reached, with long trailing advice for the operator");
    expect(text()).toContain("[pi-runner] ERROR quota reached");
    pane.diagnostic("[pi-runner] second notice");
    expect(text().match(/\[pi-runner\] second notice/g)).toHaveLength(1);
    pane.detach();
    pane.clearStatus();
    const before = text().length;
    pane.transcript("plain tail\n");
    expect(text().slice(before)).toBe("plain tail\n");
  });

  it("falls back to plain output when the terminal width is unknown", () => {
    const { output, text } = paneOut(null);
    const pane = createPaneCompositor(output);
    pane.attach(() => "draft", () => output.write("draft"), () => 0);
    pane.diagnostic("[pi-runner] ERROR no width to pin into");
    expect(text()).toBe("[pi-runner] ERROR no width to pin into\n");
  });

  it("keeps READY and EXITED markers in the transcript, verbatim", () => {
    const { output, text } = paneOut();
    const pane = createPaneCompositor(output);
    pane.line("[pi-runner] READY session=/state/s.jsonl");
    pane.line("[pi-runner] EXITED pi exited (code 0)");
    expect(text()).toBe("[pi-runner] READY session=/state/s.jsonl\n[pi-runner] EXITED pi exited (code 0)\n");
  });

  it("erases with the wider of the recorded and recomputed rows on a resize", () => {
    const { output, text } = paneOut(120);
    const pane = createPaneCompositor(output);
    const draft = "d".repeat(100); // one row at width 120, three at width 40
    pane.attach(() => draft, () => output.write(draft), () => 0);
    pane.refresh();
    expect(text().match(/\u001b\[2K/g) ?? []).toHaveLength(0);
    Object.assign(output, { columns: 40 });
    output.emit("resize");
    expect(text().match(/\u001b\[2K/g) ?? []).toHaveLength(3);
  });
});

// ── The compose line through the real line editor ────────────────────────────

describe("compose line through the real editor", () => {
  function terminal(columns = 80) {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns });
    const blocks: string[] = [];
    let screen = "";
    output.on("data", chunk => { screen += chunk.toString(); });
    const pane = createPaneCompositor(output as unknown as NodeJS.WriteStream);
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, s => { blocks.push(s); }, pane);
    return { input, output, editor, pane, blocks, screen: () => screen };
  }

  it("submits the full draft once, on readline's decoded line, with no partial copy left", () => {
    const t = terminal();
    try {
      t.input.write("hello compose");
      t.input.write("\r");
      expect(t.blocks).toEqual(["hello compose"]);
      const screen = t.screen();
      expect(screen).toContain("hello compose");
      expect(screen).toContain("\u001b[2K");
      expect(screen).not.toContain("hello compose\n");
    } finally { t.editor.close(); }
  });

  it("streams around an active draft without fusing", () => {
    const t = terminal();
    try {
      t.input.write("draft line");
      t.pane.line("streamed model line");
      const screen = t.screen();
      expect(screen.match(/streamed model line\n/g)).toHaveLength(1);
      expect(screen).not.toContain("model linedraft");
      t.input.write("\r");
      expect(t.blocks).toEqual(["draft line"]);
    } finally { t.editor.close(); }
  });

  it("measures CJK drafts in terminal cells, not UTF-16 characters", () => {
    const t = terminal(40);
    try {
      t.input.write("寛".repeat(90));
      t.input.write("x");
      expect(t.screen().match(/\u001b\[2K/g)).toHaveLength(5);
    } finally { t.editor.close(); }
  });

  it("leaves meta-return to readline: no submit, together or split", () => {
    const together = terminal();
    try {
      together.input.write("abc");
      together.input.write("\u001b\r");
      expect(together.blocks).toEqual([]);
    } finally { together.editor.close(); }
    const split = terminal();
    try {
      split.input.write("abc");
      split.input.write("\u001b");
      split.input.write("\r");
      expect(split.blocks).toEqual([]);
    } finally { split.editor.close(); }
  });

  it("clears the edit history with the submit: undo does not resurrect the draft", () => {
    const t = terminal();
    try {
      t.input.write("abc\r");
      expect(t.blocks).toEqual(["abc"]);
      t.input.write("\u001f"); // Ctrl-_ on the now-empty line
      t.input.write("\r");
      expect(t.blocks).toEqual(["abc"]);
    } finally { t.editor.close(); }
  });

  it("flushes a held streamed tail when the draft is killed (Ctrl-U)", () => {
    const t = terminal();
    try {
      t.input.write("abc");
      t.pane.transcript("an unfinished streamed tail");
      expect(t.screen()).not.toContain("an unfinished streamed tail\n");
      t.input.write("\u0015"); // kill line: the draft goes away, the tail is written
      expect(t.screen()).toContain("an unfinished streamed tail\n");
    } finally { t.editor.close(); }
  });

  it("flushes a held streamed tail at EOF", () => {
    const t = terminal();
    t.input.write("x");
    t.pane.transcript("tail at exit");
    t.editor.close();
    expect(t.screen()).toContain("tail at exit\n");
  });
});

// ── Diagnostics reach the transcript, not only the status pin ────────────────

describe("runner diagnostics", () => {
  function coreWith() {
    const lines: string[] = [];
    const pins: string[] = [];
    const io: RunnerIo = {
      sendRpc: () => {},
      mirrorLine: (line) => lines.push(line),
      mirrorAppend: () => {},
      postActivity: () => {},
      writeSidecar: () => {},
      now: () => "2026-11-10T00:00:00Z",
      diagnostic: (text) => pins.push(text),
      clearStatus: () => pins.push(""),
    };
    const core = new RunnerCore(io, { sessionName: "seat-a@some-rig", nodeId: "node-1", launchId: "launch-1" });
    core.start();
    return { core, lines, pins };
  }

  it("writes every diagnostic to the transcript and only pins the latest", () => {
    const { core, lines, pins } = coreWith();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state", success: false,
      error: "boom: the full provider setup advice follows at length",
    }));
    expect(lines.some(line => line.startsWith("[pi-runner] ERROR"))).toBe(true);
    expect(pins.at(-1)).toContain("the full provider setup advice follows at length");
    core.handlePiLine(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "second failure with different advice" } }));
    // The first failure's full text is still in the transcript history.
    expect(lines.some(line => line.includes("the full provider setup advice follows at length"))).toBe(true);
    expect(lines.some(line => line.includes("second failure with different advice"))).toBe(true);
  });

  it("keeps the ERROR marker inside the pane's last 40 lines after later traffic", () => {
    const { core, lines } = coreWith();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state", success: false, error: "quota",
    }));
    for (let i = 0; i < 5; i += 1) core.handlePiLine(JSON.stringify({ type: "message_update", delta: "later traffic " }));
    const tail = lines.slice(-40);
    expect(tail.some(line => line.includes("[pi-runner] ERROR"))).toBe(true);
  });
});
