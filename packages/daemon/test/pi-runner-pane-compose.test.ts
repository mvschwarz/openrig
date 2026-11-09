// Hermetic tests for the pane compositor: the bottom live region that keeps the
// operator's draft out of the transcript, pins runner diagnostics to a status
// line, and leaves draftless streaming byte-identical. No live pi.

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  createPaneCompositor, createRunnerInput, textCells, type PaneCompositor,
} from "../src/adapters/pi-runner.js";

function paneOut(columns = 40) {
  let buf = "";
  const output = Object.assign(new PassThrough(), { isTTY: true, columns });
  output.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { output: output as unknown as NodeJS.WriteStream, text: () => buf };
}

// ── Terminal cell width ──────────────────────────────────────────────────────

describe("terminal cell width", () => {
  it("counts ASCII as one cell and CJK as two", () => {
    expect(textCells("ab")).toBe(2);
    expect(textCells("日本語")).toBe(6);
  });

  it("counts combining marks and emoji joiners as zero width", () => {
    expect(textCells("e\u0301")).toBe(1);
    expect(textCells("a\u200db")).toBe(2);
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

  it("pins diagnostics to a status line and drops it on clearStatus", () => {
    const { output, text } = paneOut(60);
    const pane = createPaneCompositor(output);
    pane.attach(() => "draft", () => output.write("draft"), () => 0);
    pane.line("transcript line");
    pane.diagnostic("[pi-runner] ERROR quota reached");
    expect(text()).toContain("[pi-runner] ERROR quota reached");
    pane.diagnostic("[pi-runner] second notice");
    expect(text().match(/\[pi-runner\] second notice/g)).toHaveLength(1);
    pane.detach();
    pane.clearStatus();
    // With no live region, transcript writes are verbatim again.
    const before = text().length;
    pane.transcript("plain tail\n");
    expect(text().slice(before)).toBe("plain tail\n");
  });

  it("keeps READY and EXITED markers in the transcript, verbatim", () => {
    const { output, text } = paneOut();
    const pane = createPaneCompositor(output);
    pane.line("[pi-runner] READY session=/state/s.jsonl");
    pane.line("[pi-runner] EXITED pi exited (code 0)");
    expect(text()).toBe("[pi-runner] READY session=/state/s.jsonl\n[pi-runner] EXITED pi exited (code 0)\n");
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

  it("submits the full draft once, with no partial copy left in the stream", () => {
    const t = terminal();
    try {
      t.input.write("hello compose");
      t.input.write("\r");
      expect(t.blocks).toEqual(["hello compose"]);
      const screen = t.screen();
      // The draft rendered, and was erased before the submit: the only durable
      // copy of the text is the submitted block, never a frozen draft line.
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
      // 90 wide glyphs = 180 cells at width 40 → a 5-row compose region. A
      // later keystroke must erase exactly those rows; counting characters
      // instead of cells under-erases and floods the pane with stale rows.
      t.input.write("寛".repeat(90));
      t.input.write("x");
      expect(t.screen().match(/\u001b\[2K/g)).toHaveLength(5);
    } finally { t.editor.close(); }
  });
});
