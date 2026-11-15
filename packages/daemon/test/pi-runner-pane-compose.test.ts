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

  it("measures a ZWJ family emoji as one two-cell grapheme at the wrap column", () => {
    // Width 4: "abc" fills columns 0-2; the family emoji is one grapheme taking two
    // cells, does not fit the last column, and wraps whole — two rows, not three.
    expect(composeLayout("abc\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", 4))
      .toEqual({ rows: 2, caretRow: 1, caretColumn: 2 });
  });

  it("advances a tab to the next tab stop, not by zero cells", () => {
    expect(composeLayout("ab\tc", 40)).toEqual({ rows: 1, caretRow: 0, caretColumn: 9 });
  });

  it("starts a new row at an explicit newline and puts the caret on that row", () => {
    expect(composeLayout("line1\nab", 40, 6)).toEqual({ rows: 2, caretRow: 1, caretColumn: 0 });
    expect(composeLayout("line1\nab", 40, 8)).toEqual({ rows: 2, caretRow: 1, caretColumn: 2 });
  });
});


/** A terminal double that models tmux's reflow: soft-wrapped rows join on widening,
 *  paragraphs split on narrowing, and the cursor stays on its character. An ASCII-width
 *  model, which is all these tests need. */
export class ReflowScreen {
  private rows: { text: string; soft: boolean }[] = [{ text: "", soft: false }];
  private row = 0;
  private col = 0;
  columns: number;
  private handlers = new Set<() => void>();
  private view: object | null = null;
  constructor(width: number) { this.columns = width; }
  terminal(): NodeJS.WriteStream {
    if (this.view) return this.view as unknown as NodeJS.WriteStream;
    const self = this;
    this.view = {
      isTTY: true,
      write: (data: string | Buffer) => self.write(typeof data === "string" ? data : data.toString("utf8")),
      on: (_event: string, handler: () => void) => { self.handlers.add(handler); },
      get columns() { return self.columns; },
    };
    return this.view as unknown as NodeJS.WriteStream;
  }
  private ensure(row: number, soft: boolean) {
    while (this.rows.length <= row) this.rows.push({ text: "", soft: false });
    if (row > 0) this.rows[row]!.soft = soft;
  }
  private place(ch: string) {
    if (this.col >= this.columns) { this.row += 1; this.col = 0; }
    // A row reached by wrapping continues the paragraph above; one reached by a
    // newline was created hard by the \n handler.
    while (this.rows.length <= this.row) this.rows.push({ text: "", soft: this.row > 0 });
    const line = this.rows[this.row]!;
    this.rows[this.row] = { ...line, text: line.text.padEnd(this.col, " ").slice(0, this.col) + ch + line.text.slice(this.col + 1) };
    this.col += 1;
  }
  write(text: string) {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (ch === "\u001b") {
        const match = /^\u001b\[\??(\d*)([A-Za-z])/.exec(text.slice(i));
        if (match) {
          const count = match[1] ? Number(match[1]) : 1;
          if (match[2] === "A") this.row = Math.max(0, this.row - count);
          else if (match[2] === "B") this.row += count;
          else if (match[2] === "C") this.col += count;
          else if (match[2] === "K" && count === 2) this.rows[this.row] = { ...this.rows[this.row]!, text: "" };
          i += match[0].length - 1;
        } else i += 1;
        continue;
      }
      if (ch === "\r") { this.col = 0; continue; }
      if (ch === "\n") { this.row += 1; this.ensure(this.row, false); this.col = 0; continue; }
      this.place(ch);
    }
  }
  /** Reflow to a new width the way tmux does, keeping the cursor on its character,
   *  then tell the compositor the terminal resized. */
  reflowTo(width: number) {
    let start = this.row;
    while (start > 0 && this.rows[start]?.soft) start -= 1;
    let paragraph = 0;
    for (let i = 0; i < start; i += 1) if (!this.rows[i]?.soft) paragraph += 1;
    let offset = this.col;
    for (let i = start; i < this.row; i += 1) offset += this.rows[i]?.text.length ?? 0;
    const paragraphs: string[] = [];
    let joined: string | null = null;
    for (const line of this.rows) {
      if (line.soft && joined !== null) joined += line.text;
      else { if (joined !== null) paragraphs.push(joined); joined = line.text; }
    }
    if (joined !== null) paragraphs.push(joined);
    const rendered: { text: string; soft: boolean }[] = [];
    const startRow: number[] = [];
    paragraphs.forEach(text => {
      startRow.push(rendered.length);
      if (text === "") { rendered.push({ text: "", soft: false }); return; }
      for (let i = 0; i < text.length; i += width) rendered.push({ text: text.slice(i, i + width), soft: i > 0 });
    });
    this.rows = rendered;
    const text = paragraphs[paragraph] ?? "";
    const clamped = Math.min(offset, text.length);
    this.row = (startRow[paragraph] ?? 0) + Math.floor(clamped / width);
    this.col = clamped % width;
    this.columns = width;
    for (const handler of this.handlers) handler();
  }
  lines(): string[] { return this.rows.map(line => line.text.replace(/ +$/, "")); }
}

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

  it("prints nothing itself when the width is unknown: the caller's transcript copy stands alone", () => {
    const { output, text } = paneOut(null);
    const pane = createPaneCompositor(output);
    pane.attach(() => "draft", () => output.write("draft"), () => 0);
    pane.line("[pi-runner] ERROR no width to pin into");
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

  it("narrows without leaving a stale wrapped status behind, and keeps the transcript above", () => {
    const term = new ReflowScreen(120);
    const pane = createPaneCompositor(term.terminal());
    pane.line("SENTINEL-ABOVE");
    pane.diagnostic("S".repeat(110)); // a 110-cell status: one row at 120, two at 80
    term.reflowTo(80); // tmux reflows; the cursor keeps its character
    const lines = term.lines();
    expect(lines.filter(line => line.includes("SENTINEL-ABOVE"))).toHaveLength(1);
    // The stale first-80-cells copy of the wrapped status must be gone.
    expect(lines.some(line => line === "S".repeat(80))).toBe(false);
    // The repainted pin is clipped to the new width instead.
    expect(lines.some(line => line === "S".repeat(79) + "\u2026")).toBe(true);
  });


  it("keeps the sentinel when a long pinned status is resized twice", () => {
    const term = new ReflowScreen(120);
    const pane = createPaneCompositor(term.terminal());
    pane.line("SENTINEL-ABOVE");
    pane.diagnostic("S".repeat(110));
    term.reflowTo(80); // the pin is repainted clipped to 80 cells
    term.reflowTo(40); // sized from what is on screen (80 cells = 2 rows), not the 110-cell text
    const lines = term.lines();
    expect(lines.filter(line => line.includes("SENTINEL-ABOVE"))).toHaveLength(1);
    expect(lines.some(line => line === "S".repeat(40))).toBe(false);
  });

  it("widens a wrapped draft without erasing the transcript line above it", () => {
    const term = new ReflowScreen(40);
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
    const output = term.terminal();
    const pane = createPaneCompositor(output);
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream, output, () => {}, pane);
    try {
      pane.line("SENTINEL-ABOVE");
      input.write("d".repeat(90)); // three draft rows at width 40
      input.write("\u001b[D".repeat(45)); // caret mid-draft
      term.reflowTo(120); // the draft joins into one row; the caret keeps its character
      const lines = term.lines();
      expect(lines.filter(line => line.includes("SENTINEL-ABOVE"))).toHaveLength(1);
      // One draft row repainted at the new width — not three, and not the sentinel.
      expect(lines.filter(line => line.replace(/ /g, "").startsWith("dddd")).length).toBe(1);
    } finally { editor.close(); }
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

  it("flushes a held streamed tail verbatim when the draft is killed (Ctrl-U)", () => {
    const t = terminal();
    try {
      t.input.write("abc");
      t.pane.transcript("an unfinished streamed tail");
      expect(t.screen()).not.toContain("an unfinished streamed tail");
      t.input.write("\u0015"); // kill line: the draft goes away, the tail is written as-is
      expect(t.screen()).toContain("an unfinished streamed tail");
    } finally { t.editor.close(); }
  });

  it("joins a flushed tail with the next delta instead of splitting mid-word", () => {
    const t = terminal();
    try {
      t.input.write("abc");
      t.pane.transcript("Hello wor");
      t.input.write("\u0015");
      t.pane.transcript("ld\n");
      expect(t.screen()).toContain("Hello world");
    } finally { t.editor.close(); }
  });

  it("keeps coalesced edit keys and text ordered with the compositor attached", () => {
    const t = terminal();
    try {
      t.input.write("ac\u001b[Db\u00e9\u{1F98A}\r");
      expect(t.blocks).toEqual(["ab\u00e9\u{1F98A}c"]);
    } finally { t.editor.close(); }
  });


  it("keeps the flushed tail line open so new typing starts on its own line", () => {
    const t = terminal();
    try {
      t.input.write("abc");
      t.pane.transcript("Hello wor");
      t.input.write("\u0015"); // flush "Hello wor" verbatim, no newline
      t.input.write("x"); // new draft, no newline
      t.input.write("y"); // the next keystroke must not erase the tail line
      const screen = t.screen();
      expect(screen).toContain("Hello wor\n");
      expect(screen).not.toContain("Hello worx");
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
