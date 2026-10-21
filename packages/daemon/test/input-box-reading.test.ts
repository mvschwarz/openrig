import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readInputBox, readSeatBeforePaste, type InputBoxReading, type SeatReading } from "../src/domain/session-transport.js";

// Real Claude Code 2.1.296 and Codex 0.160.0 frames (see fixtures/input-box/README.md), plus upstream's own
// 2.1.289 crops and the Codex 0.160.0 update menu. Frames not captured are one-line edits of a real frame,
// made in the test and named where they are made.
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
type TextName = keyof typeof texts;
const TEXT_NAMES = Object.keys(texts) as TextName[];
const startupPaste = JSON.parse(readFileSync(new URL("./fixtures/claude-startup-paste-2.1.289.json", import.meta.url), "utf8")) as Array<{ name: string; pane: string }>;
const crop = (name: string) => startupPaste.find((frame) => frame.name === name)!.pane;
const picker = JSON.parse(readFileSync(new URL("./fixtures/claude-question-picker-2.1.289.json", import.meta.url), "utf8")) as Record<string, string>;
const codexUpdate = readFileSync(new URL("./fixtures/codex-update-0.160.0.txt", import.meta.url), "utf8");

/** Replace the one line that matches, or drop it when `replacement` is null. */
function editLine(frame: string, match: (line: string) => boolean, replacement: string | string[] | null): string {
  const lines = frame.split("\n");
  const hits = lines.flatMap((line, index) => (match(line) ? [index] : []));
  expect(hits, "the edit must hit exactly one line").toHaveLength(1);
  lines.splice(hits[0]!, 1, ...(replacement === null ? [] : Array.isArray(replacement) ? replacement : [replacement]));
  return lines.join("\n");
}
// The live box row draws a no-break space after the marker; transcript rows draw a plain space.
const claudeBoxRow = (line: string) => line.startsWith("❯\u00a0");
const codexBoxRow = (line: string) => line.startsWith("›");
const SEAT = "dev-impl@my-rig";
/** Edit (ADV4-1): the box's opening rule (the rule above the last `❯` row) drawn with a session name, as Claude Code
 *  draws `--name`: the rule, the name padded by one space each side, then `trailing` rule cells (one in the 2.1.296
 *  bundle, two in real frames of OpenRig seats from earlier versions), as wide as the plain rule it replaces. */
function nameBox(frame: string, name = SEAT, trailing = 1, widthDelta = 0): string {
  const lines = frame.split("\n");
  let box = lines.length - 1;
  while (box >= 0 && !lines[box]!.startsWith("❯")) box--;
  const rule = lines[box - 1]!.trimEnd();
  expect(rule).toMatch(/^─{10,}$/);
  lines[box - 1] = `${"─".repeat([...rule].length + widthDelta - name.length - 2 - trailing)} ${name} ${"─".repeat(trailing)}`;
  return lines.join("\n");
}

describe("readInputBox: Claude Code 2.1.296 frames", () => {
  const staged: Array<[string, TextName]> = [
    ["staged-short.raw", "short"], ["staged-short.J", "short"],
    ["staged-wrapped.raw", "wrapped"], ["staged-wrapped.J", "wrapped"],
    ["submit-staged.J", "submit"],
  ];

  it.each(staged)("%s holds exactly its own text and reads other for every other text", (frame, own) => {
    for (const name of TEXT_NAMES) {
      expect(readInputBox(claude(frame), "claude-code", texts[name]), name).toBe(name === own ? "exact" : "other");
    }
  });

  it.each(["staged-envelope-collapsed.raw", "staged-envelope-collapsed.J", "staged-large-collapsed.J"])(
    "%s shows a collapsed paste label: hidden against every text, including its own", (frame) => {
      for (const name of TEXT_NAMES) expect(readInputBox(claude(frame), "claude-code", texts[name]), name).toBe("hidden");
    });

  it("a label is never identity, even for a text that is the label itself", () => {
    expect(readInputBox(claude("staged-envelope-collapsed.raw"), "claude-code", "[Pasted text #1 +6 lines]")).toBe("hidden");
  });

  it.each(["idle-fresh-suggestion", "cleared-without-enter.J"])("%s shows the Try suggestion: other", (frame) => {
    for (const name of TEXT_NAMES) expect(readInputBox(claude(frame), "claude-code", texts[name])).toBe("other");
  });

  it("the Try suggestion is never identity, even for a text that is the suggestion itself", () => {
    expect(readInputBox(claude("idle-fresh-suggestion"), "claude-code", 'Try "fix typecheck errors"')).toBe("other");
    expect(readInputBox(claude("cleared-without-enter.J"), "claude-code", 'Try "fix typecheck errors"')).toBe("other");
  });

  it.each(["after-enter-0.4s.J", "after-enter-15s.J"])("%s: empty box, though the sent text is in the transcript above", (frame) => {
    expect(claude(frame)).toContain(texts.submit);
    expect(readInputBox(claude(frame), "claude-code", texts.submit)).toBe("empty");
  });

  it("the queued-messages label reads queued (edit: the box row of a real frame)", () => {
    const queued = editLine(claude("submit-staged.J"), claudeBoxRow, "❯ Press up to edit queued messages");
    expect(readInputBox(queued, "claude-code", texts.submit)).toBe("queued");
  });

  describe("an empty box after a running turn reads queued: Claude labels its queue only while a hint counter is low", () => {
    // The real frame 0.4 s after a submit: a live status row above an empty box and `esc to interrupt` in the footer.
    const running = claude("after-enter-0.4s.J");
    // Edit: our text staged in the box of that real frame (a turn is running when Enter is pressed).
    const stagedWhileRunning = editLine(running, claudeBoxRow, `❯\u00a0${texts.short}`);
    const idleFooter = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";

    it("the frame read before Enter showed a running turn", () => {
      expect(stagedWhileRunning).toContain("esc to interrupt");
      expect(readInputBox(stagedWhileRunning, "claude-code", texts.short)).toBe("exact");
      expect(readInputBox(running, "claude-code", texts.short, stagedWhileRunning)).toBe("queued");
    });

    it("either signal alone is a running turn: the footer, or the live status row above the box", () => {
      // Edits of that frame: the status row blanked, or the footer replaced by the idle one.
      const footerOnly = editLine(stagedWhileRunning, (line) => line.startsWith("✶"), "");
      const statusOnly = editLine(stagedWhileRunning, (line) => line.includes("esc to interrupt"), idleFooter);
      expect(readInputBox(running, "claude-code", texts.short, footerOnly)).toBe("queued");
      expect(readInputBox(running, "claude-code", texts.short, statusOnly)).toBe("queued");
    });

    it("an idle box before Enter: empty, even when a turn is running after it", () => {
      expect(readInputBox(running, "claude-code", texts.submit, claude("submit-staged.J"))).toBe("empty");
      expect(readInputBox(running, "claude-code", texts.short, claude("staged-short.raw"))).toBe("empty");
      expect(readInputBox(claude("after-enter-15s.J"), "claude-code", texts.short, claude("staged-short.raw"))).toBe("empty");
    });

    it("a completed status row above the box is not a running turn", () => {
      const done = claude("after-enter-15s.J");
      expect(done).toContain("✻ Cooked for 2s");
      expect(readInputBox(done, "claude-code", texts.submit, done)).toBe("empty");
    });

    it("a live status row above a wrapped (multi-row) box before Enter reads queued (ADV4-4)", () => {
      // Edits of the running frame: the 3 real rows of staged-wrapped.raw in its box, under the real footer Claude
      // 2.1.296 draws while the box holds text (staged-short.raw: no `esc to interrupt`). The status row sits two
      // rows above the opening rule, which findClaudeComposer cannot see over a 3-row box.
      const wrapped = claude("staged-wrapped.raw").split("\n");
      const at = wrapped.findIndex(claudeBoxRow);
      const textFooter = claude("staged-short.raw").split("\n").find((line) => line.startsWith("  ⏵⏵ bypass permissions on"))!;
      const before = editLine(editLine(running, claudeBoxRow, wrapped.slice(at, at + 3)), (line) => line.includes("esc to interrupt"), textFooter);
      expect(before).not.toContain("esc to interrupt");
      expect(readInputBox(before, "claude-code", texts.wrapped)).toBe("exact");
      expect(readInputBox(running, "claude-code", texts.wrapped, before)).toBe("queued");
      // The same box with the status slot blank (the real staged frame), or a completed status row there: empty.
      expect(readInputBox(running, "claude-code", texts.wrapped, claude("staged-wrapped.raw"))).toBe("empty");
      const completed = editLine(before, (line) => line.startsWith("✶"), "✻ Cooked for 2s · done 3:11 PM");
      expect(readInputBox(running, "claude-code", texts.wrapped, completed)).toBe("empty");
    });

    it("a running-turn signature inside the staged text itself is not a running turn", () => {
      const spoof = "✶ Marinating… · esc to interrupt";
      const staged = editLine(claude("submit-staged.J"), claudeBoxRow, `❯\u00a0${spoof}`);
      expect(readInputBox(staged, "claude-code", spoof)).toBe("exact");
      expect(readInputBox(claude("after-enter-15s.J"), "claude-code", spoof, staged)).toBe("empty");
    });

    it("a box that still holds text, or the queued label, is read as usual whatever the frame before Enter showed", () => {
      expect(readInputBox(stagedWhileRunning, "claude-code", texts.short, stagedWhileRunning)).toBe("exact");
      const labelled = editLine(running, claudeBoxRow, "❯ Press up to edit queued messages");
      expect(readInputBox(labelled, "claude-code", texts.short, stagedWhileRunning)).toBe("queued");
      expect(readInputBox(labelled, "claude-code", texts.short, claude("staged-short.raw"))).toBe("queued");
    });
  });
});

describe("readInputBox: Codex 0.160.0 frames", () => {
  const staged: Array<[string, TextName]> = [
    ["staged-short.raw", "short"], ["staged-short.J", "short"],
    ["staged-envelope.J", "envelope"],
    ["staged-wrapped.raw", "wrapped"], ["staged-wrapped.J", "wrapped"],
    ["submit-staged.J", "submit"],
    // Launched without the background server: the footer is the status line alone.
    ["product-path-staged-short.J", "short"], ["product-path-staged-envelope.J", "envelope"],
  ];

  it.each(staged)("%s holds exactly its own text and reads other for every other text", (frame, own) => {
    for (const name of TEXT_NAMES) {
      expect(readInputBox(codex(frame), "codex", texts[name]), name).toBe(name === own ? "exact" : "other");
    }
  });

  it("a collapsed paste label is hidden against every text, including the label itself", () => {
    for (const name of TEXT_NAMES) expect(readInputBox(codex("staged-large-collapsed.J"), "codex", texts[name])).toBe("hidden");
    expect(readInputBox(codex("staged-large-collapsed.J"), "codex", "[Pasted Content 6770 chars]")).toBe("hidden");
  });

  it.each(["idle", "cleared-without-enter.J", "after-enter-0.4s.J", "after-enter-1s.J", "after-enter-15s.J", "product-path-idle.J"])(
    "%s: empty box (the placeholder, or a bare prompt), whatever is in the history above", (frame) => {
      for (const name of TEXT_NAMES) expect(readInputBox(codex(frame), "codex", texts[name])).toBe("empty");
    });

  it("a text equal to the placeholder never reads exact", () => {
    expect(readInputBox(codex("idle"), "codex", "Ask Codex to do anything")).toBe("empty");
  });

  describe("an empty box while a turn runs reads queued: Codex draws it the same after a submit and after a queue", () => {
    // The real frame 0.4 s after a submit: the running-turn status row above an empty box.
    const running = codex("after-enter-0.4s.J");
    // Edit: our text staged in the box of that real frame (a turn is running when Enter is pressed).
    const stagedWhileRunning = editLine(running, (line) => line.startsWith("› Ask Codex"), `› ${texts.short}`);
    // Edit: one row under the status row of that real frame, where Codex lists messages waiting behind a turn.
    const rowBehindTurn = editLine(running, (line) => line.startsWith("• Working"), ["• Working (0s • esc to interrupt)", "  ↳ a message waiting behind the turn"]);

    it("the frame read before Enter showed the running-turn status row", () => {
      expect(readInputBox(stagedWhileRunning, "codex", texts.short)).toBe("exact");
      expect(readInputBox(running, "codex", texts.short, stagedWhileRunning)).toBe("queued");
    });

    it("a row sits between the running-turn status row and the empty box", () => {
      expect(readInputBox(rowBehindTurn, "codex", texts.submit)).toBe("queued");
      expect(readInputBox(rowBehindTurn, "codex", texts.submit, codex("submit-staged.J"))).toBe("queued");
    });

    it.each([
      "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
      "• Messages to be submitted at end of turn",
      "• Queued follow-up inputs",
    ])("Codex's pending-input header %j above the empty box reads queued, with no status row drawn (edit)", (header) => {
      // Codex hides the status row while it streams, so the header is the only sign of the waiting message.
      const pending = editLine(running, (line) => line.startsWith("• Working"), [header, `  ↳ ${texts.short}`]);
      expect(readInputBox(pending, "codex", texts.short)).toBe("queued");
      expect(readInputBox(pending, "codex", texts.short, codex("staged-short.J"))).toBe("queued");
    });

    it("a `↳` row of Codex's pending-input list above the empty box reads queued without a header or status row (edit)", () => {
      const waiting = editLine(running, (line) => line.startsWith("• Working"), `  ↳ ${texts.short}`);
      expect(readInputBox(waiting, "codex", texts.short, codex("staged-short.J"))).toBe("queued");
    });

    it("an idle box before Enter and only blank rows under the status row after it: empty", () => {
      expect(readInputBox(running, "codex", texts.submit, codex("submit-staged.J"))).toBe("empty");
      expect(readInputBox(codex("after-enter-1s.J"), "codex", texts.submit, codex("submit-staged.J"))).toBe("empty");
    });

    it("a status row inside the staged text itself is not a running turn", () => {
      const spoof = "• Working (1s • esc to interrupt)";
      const staged = editLine(codex("submit-staged.J"), codexBoxRow, `› ${spoof}`);
      expect(readInputBox(staged, "codex", spoof)).toBe("exact");
      expect(readInputBox(codex("after-enter-15s.J"), "codex", spoof, staged)).toBe("empty");
    });

    it("a box that still holds text is read as usual whatever the frame before Enter showed", () => {
      expect(readInputBox(stagedWhileRunning, "codex", texts.short, stagedWhileRunning)).toBe("exact");
    });
  });
});

describe("readInputBox: upstream Claude 2.1.289 crops", () => {
  it.each([
    ["empty-paste-hint-effort", "empty"], ["empty-paste-hint", "empty"],
    ["queued-paste-hint", "queued"], ["queued-mode-bar", "queued"],
    ["collapsed-paste-hint", "hidden"], ["ghost-mode-bar", "other"],
  ] as Array<[string, InputBoxReading]>)("%s reads %s", (name, expected) => {
    expect(readInputBox(crop(name), "claude-code", texts.short)).toBe(expected);
  });

  it("a text equal to the queued label reads queued, never exact", () => {
    expect(readInputBox(crop("queued-mode-bar"), "claude-code", "Press up to edit queued messages")).toBe("queued");
  });
});

describe("readInputBox: a shared prefix is not the message", () => {
  it.each([
    ["claude-code", claude("staged-short.raw")],
    ["codex", codex("staged-short.J")],
  ] as const)("%s: the text plus more, or the text minus its last character, reads other", (runtime, frame) => {
    expect(readInputBox(frame, runtime, `${texts.short} more`)).toBe("other");
    expect(readInputBox(frame, runtime, texts.short.slice(0, -1))).toBe("other");
  });
});

describe("readInputBox: uncertainty from the capture or the layout", () => {
  it.each([null, "", "  \n \n"])("no capture (%j) reads unavailable", (pane) => {
    expect(readInputBox(pane, "claude-code", texts.short)).toBe("unavailable");
    expect(readInputBox(pane, "codex", texts.short)).toBe("unavailable");
  });

  it("text taller than the capture: with the prompt row cut off, the box is never exact", () => {
    const cut = (frame: string, isBox: (line: string) => boolean) => frame.split("\n").filter((line) => !isBox(line)).join("\n");
    expect(["unrecognized", "other"]).toContain(readInputBox(cut(claude("staged-wrapped.raw"), claudeBoxRow), "claude-code", texts.wrapped));
    expect(["unrecognized", "other"]).toContain(readInputBox(cut(codex("staged-wrapped.raw"), codexBoxRow), "codex", texts.wrapped));
  });

  it("Claude: a question picker, an unknown footer, or a frame cut before its rule reads unrecognized", () => {
    expect(readInputBox(picker.picker160!, "claude-code", texts.short)).toBe("unrecognized");
    expect(readInputBox(picker.picker100!, "claude-code", texts.short)).toBe("unrecognized");
    // Edit: the mode bar replaced by a footer this reader does not know.
    const unknownFooter = editLine(claude("staged-short.raw"), (line) => line.includes("bypass permissions on"), "  some new footer");
    expect(readInputBox(unknownFooter, "claude-code", texts.short)).toBe("unrecognized");
    const truncated = claude("staged-short.raw").split("\n").slice(0, -3).join("\n");
    expect(readInputBox(truncated, "claude-code", texts.short)).toBe("unrecognized");
  });

  it("Codex: the update menu reads unrecognized", () => {
    expect(readInputBox(codexUpdate, "codex", texts.short)).toBe("unrecognized");
  });

  describe("Codex: one-line edits of a staged frame read unrecognized", () => {
    const frame = codex("staged-short.J");
    const lines = frame.split("\n");
    const box = lines.findIndex(codexBoxRow);
    it("the frame itself reads exact", () => expect(readInputBox(frame, "codex", texts.short)).toBe("exact"));
    it.each([
      // The 0.157 shape: no blank row between the box and the footer.
      ["no blank separator", () => [...lines.slice(0, box + 1), ...lines.slice(box + 2)].join("\n")],
      ["a three-row footer", () => editLine(frame, (line) => line.includes("f2 to view"), [lines.find((line) => line.includes("f2 to view"))!, "  another row"])],
      ["an unknown hint row", () => editLine(frame, (line) => line.includes("f2 to view"), "  some other hint")],
      ["a non-indented row inside the box", () => editLine(frame, codexBoxRow, [lines[box]!, "unindented"])],
      ["a status line with no path field", () => editLine(frame, (line) => line.startsWith("  GPT-6.1-Sol"), "  GPT-6.1-Sol default")],
      ["a numbered selector", () => editLine(frame, codexBoxRow, "› 1. Yes, continue")],
    ])("%s", (_name, edit) => {
      expect(readInputBox(edit(), "codex", texts.short)).toBe("unrecognized");
    });
  });
});

describe("readSeatBeforePaste: verified needs a seat proven idle before the paste (fail closed)", () => {
  const claudeFooterRow = (line: string) => line.startsWith("  ⏵⏵ bypass permissions on");
  // Edit: the row `offset` rows above the Claude box row of a real frame replaced by `row`.
  const aboveBox = (frame: string, offset: number, row: string) => {
    const lines = frame.split("\n");
    lines[lines.findIndex(claudeBoxRow) - offset] = row;
    return lines.join("\n");
  };
  const focusNotice = claude("staged-short.raw").split("\n").find((line) => line.includes("tmux focus-events off"))!;
  const dismissed = picker.dismissed100!;

  describe("each idle allow-list entry, on a real frame that needs it", () => {
    it.each([
      ["Claude footer `⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`, empty box, blank row above the rule", "claude-code", claude("after-enter-15s.J")],
      ["Claude Try suggestion box, effort row above the rule", "claude-code", claude("idle-fresh-suggestion")],
      ["Claude tmux mouse notice above the rule", "claude-code", claude("cleared-without-enter.J")],
      ["Claude tmux focus-events notice above the rule (edit: staged-short.raw's real row in after-enter-15s.J)", "claude-code",
        aboveBox(claude("after-enter-15s.J"), 2, focusNotice)],
      // Upstream's real Claude 2.1.289 frame of an idle seat (claude-question-picker.test.ts reads it agent_idle): the
      // classic renderer's completion row in the status slot (ADV5-1), the effort row, the auto-mode footer.
      ["Claude 2.1.289 idle seat: completion row in the status slot, effort row above the rule, auto mode", "claude-code", dismissed],
      ["Codex hint row `? for shortcuts`, fresh session", "codex", codex("product-path-idle.J")],
      ["Codex hint row with a warning, fresh session", "codex", codex("idle")],
      ["Codex fresh session after a paste cleared with C-c", "codex", codex("cleared-without-enter.J")],
      ["Codex finished turn: the completion row above the box", "codex", codex("after-enter-15s.J")],
    ] as const)("%s: idle", (_entry, runtime, frame) => {
      expect(readSeatBeforePaste(frame, runtime)).toBe("idle");
    });
  });

  describe("not idle: a running, streaming, queued, pending-input or paste-hint row anywhere", () => {
    it.each([
      ["Claude running: live status row, esc to interrupt", "claude-code", claude("after-enter-0.4s.J")],
      ["Claude paste hint under a collapsed paste", "claude-code", claude("staged-envelope-collapsed.raw")],
      ["Claude paste hint under wrapped text", "claude-code", claude("staged-wrapped.raw")],
      ["Claude 2.1.289 crop: empty box under the paste hint", "claude-code", crop("empty-paste-hint")],
      ["Claude 2.1.289 crop: the queued label under the idle footer", "claude-code", crop("queued-mode-bar")],
      ["Claude running with only the paste-hint footer (edit)", "claude-code",
        editLine(claude("after-enter-0.4s.J"), (line) => line.includes("esc to interrupt"), "  paste again to expand")],
      ["Claude running with the status row blanked: esc to interrupt in the footer (edit)", "claude-code",
        editLine(claude("after-enter-0.4s.J"), (line) => line.startsWith("✶"), "")],
      ["Claude idle bottom, a live status row far above it (edit)", "claude-code",
        editLine(claude("after-enter-15s.J"), (line) => line.startsWith("✻ Cooked"), "✶ Marinating… (12s · ↓ 1.2k tokens)")],
      ["Claude idle bottom, a timer-less live status row far above it (edit)", "claude-code",
        editLine(claude("after-enter-15s.J"), (line) => line.startsWith("✻ Cooked"), "✻ Compacting conversation…")],
      ["Codex running: the status row", "codex", codex("after-enter-0.4s.J")],
      ["Codex running: the status line spinner", "codex", codex("after-enter-1s.J")],
      ["Codex streaming: status hidden, a pending steer above the box (edit)", "codex",
        editLine(codex("after-enter-0.4s.J"), (line) => line.startsWith("• Working"),
          ["• Messages to be submitted after next tool call (press esc to interrupt and send immediately)", "  ↳ an earlier message"])],
      ["Codex queued follow-up header (edit)", "codex",
        editLine(codex("after-enter-0.4s.J"), (line) => line.startsWith("• Working"), ["• Queued follow-up inputs", "  ↳ an earlier message"])],
      ["Codex completion row above the box, a status row far above it (edit)", "codex",
        editLine(codex("after-enter-15s.J"), (line) => line.startsWith("• OK"), "• Working (3s • esc to interrupt)")],
    ] as const)("%s", (_name, runtime, frame) => {
      expect(readSeatBeforePaste(frame, runtime)).toBe("not-idle");
    });
  });

  describe("unknown: any layout not on the allow-list, or no capture", () => {
    it.each([null, "", "  \n \n"])("no capture (%j)", (pane) => {
      expect(readSeatBeforePaste(pane, "claude-code")).toBe("unknown");
      expect(readSeatBeforePaste(pane, "codex")).toBe("unknown");
    });

    it.each([
      ["Claude default-mode footer of earlier versions, `? for shortcuts` (edit)", "claude-code", editLine(claude("after-enter-15s.J"), claudeFooterRow, "  ? for shortcuts")],
      ["Claude an unknown footer (edit)", "claude-code", editLine(claude("after-enter-15s.J"), claudeFooterRow, "  some new footer")],
      ["Claude a question picker", "claude-code", picker.picker160!],
      ["Claude a draft in the box", "claude-code", claude("staged-short.raw")],
      ["Claude other text in the box under the idle footer (edit)", "claude-code",
        editLine(claude("after-enter-15s.J"), claudeBoxRow, "❯\u00a0someone's draft")],
      ["Claude an unknown row just above the rule (edit)", "claude-code", aboveBox(claude("after-enter-15s.J"), 2, "  a notice no frame showed")],
      ["Claude a row where a running turn draws its status (edit)", "claude-code", aboveBox(claude("after-enter-15s.J"), 3, "● a transcript row")],
      ["Claude a frame cut before its footer (edit: footer dropped)", "claude-code", editLine(claude("after-enter-15s.J"), claudeFooterRow, null)],
      ["Codex streaming: status row hidden, streamed text above the box (edit)", "codex",
        editLine(codex("after-enter-0.4s.J"), (line) => line.startsWith("• Working"), "• I am checking the repository layout before editing the files.")],
      ["Codex an interrupted turn (edit)", "codex",
        editLine(codex("after-enter-15s.J"), (line) => line.includes("Worked for"), "■ Conversation interrupted - tell the model what to do differently.")],
      ["Codex our own message as the last row (edit: completion row removed)", "codex",
        editLine(codex("after-enter-15s.J"), (line) => line.includes("Worked for"), "")],
      ["Codex a session header of another version (edit)", "codex",
        editLine(codex("idle"), (line) => line.includes(">_ OpenAI Codex"), "  >_ OpenAI Codex (v0.161.0)")],
      ["Codex a row between the greeting and the box (edit)", "codex",
        editLine(codex("product-path-idle.J"), (line) => line.startsWith("› Ask Codex"), ["• MCP servers ready", "", "› Ask Codex to do anything"])],
      ["Codex no hint row (edit)", "codex", editLine(codex("product-path-idle.J"), (line) => line.trim() === "? for shortcuts", "")],
      ["Codex a draft in the box", "codex", codex("staged-short.J")],
      ["Codex the update menu", "codex", codexUpdate],
    ] as Array<[string, "claude-code" | "codex", string]>)("%s", (_name, runtime, frame) => {
      expect(readSeatBeforePaste(frame, runtime)).toBe("unknown" satisfies SeatReading);
    });
  });
  describe("OpenRig's own Claude launch (ADV4-1): the named box, each permission posture, the statusLine collector", () => {
    const idleFrame = claude("after-enter-15s.J");
    const posture = (frame: string, footer: string) => editLine(frame, claudeFooterRow, `  ${footer}`);
    // Every footer below is drawn by the Claude Code 2.1.296 bundle for the mode claudePostureFlag launches
    // (bypass is also the real frame; accept edits also a real 2.1.220 capture).
    const footers = {
      bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
      auto: "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
      dontAsk: "⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
      plan: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
      default: "⏸ manual mode on · ← for agents",
    };
    // The running frame as an OpenRig seat draws it (edit): named box, accept edits, and the footer OpenRig's statusLine
    // leaves (no `esc to interrupt`, so it equals the idle footer); the live status row is the one running signal.
    const openRigRunning = posture(nameBox(claude("after-enter-0.4s.J")), footers.acceptEdits);

    it.each(Object.entries(footers))("posture %s: its footer row is on the allow-list", (_mode, footer) => {
      expect(readSeatBeforePaste(posture(idleFrame, footer), "claude-code")).toBe("idle");
      expect(readSeatBeforePaste(posture(nameBox(idleFrame), footer), "claude-code", SEAT)).toBe("idle");
    });

    it.each([
      ["the 2.1.296 bundle's border, one trailing rule cell", 1],
      ["the border of real OpenRig seat frames, two trailing rule cells", 2],
    ] as const)("the opening rule with this seat's session name: %s", (_name, trailing) => {
      expect(readSeatBeforePaste(nameBox(idleFrame, SEAT, trailing), "claude-code", SEAT)).toBe("idle");
      expect(readSeatBeforePaste(nameBox(claude("idle-fresh-suggestion"), SEAT, trailing), "claude-code", SEAT)).toBe("idle");
      expect(readSeatBeforePaste(posture(nameBox(idleFrame, SEAT, trailing), footers.acceptEdits), "claude-code", SEAT)).toBe("idle");
    });

    it("the statusLine collector draws no row: the footer directly under the closing rule", () => {
      // The captured frames have no statusLine; OpenRig's collector prints nothing, so its seats draw the same rows.
      const lines = idleFrame.split("\n").map((line) => line.trimEnd());
      const footer = lines.findIndex(claudeFooterRow);
      expect(lines[footer - 1]).toMatch(/^─{10,}$/);
      expect(readSeatBeforePaste(idleFrame, "claude-code")).toBe("idle");
    });

    it("running under OpenRig's statusLine: the footer looks idle, the status row above the box reads not-idle", () => {
      expect(openRigRunning).not.toContain("esc to interrupt");
      expect(readSeatBeforePaste(openRigRunning, "claude-code", SEAT)).toBe("not-idle");
    });

    it.each([
      ["a row that matches no running pattern where the status row goes", posture(nameBox(editLine(claude("after-enter-0.4s.J"),
        (line) => line.startsWith("✶"), "⎿  Running…")), footers.acceptEdits)],
      ["another seat's name", nameBox(idleFrame, "dev-qa@my-rig")],
      ["the name cut short", nameBox(idleFrame, "dev-impl@my-r…")],
      ["a named border one cell wider than the closing rule", nameBox(idleFrame, SEAT, 1, 1)],
      ["three trailing rule cells", nameBox(idleFrame, SEAT, 3)],
      ["a statusLine that prints a row between the closing rule and the footer", editLine(idleFrame, claudeFooterRow,
        ["  Opus 5.5 · ctx 12% · ~/work", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"])],
      ["the default footer without a statusLine (`? for shortcuts` drawn)", posture(idleFrame, "⏸ manual mode on · ? for shortcuts · ← for agents")],
      ["accept edits with a background shell (real 2.1.220 shape)", posture(idleFrame, "⏵⏵ accept edits on · 1 shell · ← for agents")],
      ["a mode with no cycle hint", posture(idleFrame, "⏵⏵ accept edits on · ← for agents")],
    ])("unknown: %s", (_name, frame) => {
      expect(readSeatBeforePaste(frame, "claude-code", SEAT)).toBe("unknown");
    });

    it("unknown: the named box read without the seat's name", () => {
      expect(readSeatBeforePaste(nameBox(idleFrame), "claude-code")).toBe("unknown");
    });

    it("the named box reads the input box as before (exact, then empty)", () => {
      const staged = posture(nameBox(claude("staged-short.raw")), "⏵⏵ accept edits on (shift+tab to cycle)");
      expect(readInputBox(staged, "claude-code", texts.short)).toBe("exact");
      expect(readInputBox(posture(nameBox(idleFrame), footers.acceptEdits), "claude-code", texts.short, staged)).toBe("empty");
      expect(readInputBox(openRigRunning, "claude-code", texts.short, editLine(openRigRunning, claudeBoxRow, `❯\u00a0${texts.short}`))).toBe("queued");
    });
  });

  describe("Claude's completion row in the status slot (ADV5-1): idle OpenRig-launched seats after their first turn", () => {
    // Real frames of idle seats OpenRig launched (Claude Code 2.1.296, classic renderer, named box, OpenRig's
    // statusLine collector, 80 columns; see fixtures/input-box/README.md). The box follows the transcript, so the
    // status slot two rows above the opening rule holds the last turn's completion row.
    const seats = [
      ["openrig-seat-bypass-idle", "orch-advisor@sample-rig", "✻ Crunched for 9s · done 10:50 PM"],
      ["openrig-seat-accept-edits-idle", "review-r1@sample-rig", "✻ Churned for 4s · done 5:24 PM"],
    ] as const;
    const slotOf = (frame: string) => {
      const lines = frame.split("\n");
      return lines.findIndex(claudeBoxRow) - 3;
    };
    // Edit: the status slot of a real frame replaced by `row`.
    const slot = (frame: string, row: string) => {
      const lines = frame.split("\n");
      lines[slotOf(frame)] = row;
      return lines.join("\n");
    };
    const footerRow = (line: string) => /^ {2}⏵⏵ (?:bypass permissions|accept edits) on/.test(line);
    const [bypass, bypassSeat] = [claude(seats[0][0]), seats[0][1]];

    it.each(seats)("%s: the real frame reads idle for its own seat, and its slot is the completion row", (name, seat, row) => {
      const frame = claude(name);
      expect(frame.split("\n")[slotOf(frame)]).toBe(row);
      expect(readSeatBeforePaste(frame, "claude-code", seat)).toBe("idle");
      // Review round 1, change 3: the same frame with the slot blank has the seat's last message right above it,
      // which is how a classic frame can look while Claude Code hides its spinner for streamed text: unknown.
      expect(readSeatBeforePaste(slot(frame, ""), "claude-code", seat)).toBe("unknown");
    });

    it.each(seats)("%s: unknown without the seat's name or for another seat", (name, seat) => {
      expect(readSeatBeforePaste(claude(name), "claude-code")).toBe("unknown");
      expect(readSeatBeforePaste(claude(name), "claude-code", seat === bypassSeat ? seats[1][1] : bypassSeat)).toBe("unknown");
    });

    it.each(seats)("%s: idle under every posture footer OpenRig can launch (edit: the footer row)", (name, seat) => {
      for (const footer of ["⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents", "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
        "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents", "⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
        "⏸ plan mode on (shift+tab to cycle) · ← for agents", "⏸ manual mode on · ← for agents"]) {
        expect(readSeatBeforePaste(editLine(claude(name), footerRow, `  ${footer}`), "claude-code", seat), footer).toBe("idle");
      }
    });

    it.each(seats)("%s: the box reads as before (empty; exact when staged; queued after a running frame)", (name, seat) => {
      const frame = claude(name);
      const staged = editLine(frame, claudeBoxRow, `❯\u00a0${texts.short}`);
      expect(readInputBox(frame, "claude-code", texts.short)).toBe("empty");
      expect(readInputBox(staged, "claude-code", texts.short)).toBe("exact");
      expect(readInputBox(frame, "claude-code", texts.short, staged)).toBe("empty");
      expect(readInputBox(frame, "claude-code", texts.short, slot(staged, "✶ Churning… (3s · ↓ 120 tokens)"))).toBe("queued");
      expect(seat).toMatch(/@sample-rig$/);
    });

    // The grammar of the Claude Code 2.1.296 bundle (edits of the slot row of the real bypass frame): every verb of its
    // list, its duration format, the clock of its time-format presets in en-US.
    it.each([
      ...["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"].map((verb) => [`verb ${verb}`, `✻ ${verb} for 9s · done 10:50 PM`]),
      ["zero seconds", "✻ Cooked for 0s · done 10:50 PM"],
      ["under a millisecond", "✻ Cooked for 0.0s · done 10:50 PM"],
      ["59 seconds", "✻ Cooked for 59s · done 10:50 PM"],
      ["minutes", "✻ Cooked for 1m 0s · done 10:50 PM"],
      ["59 minutes 59 seconds", "✻ Cooked for 59m 59s · done 10:50 PM"],
      ["hours", "✻ Cooked for 1h 0m 5s · done 10:50 PM"],
      ["23 hours", "✻ Cooked for 23h 59m 59s · done 10:50 PM"],
      ["days", "✻ Cooked for 2d 0h 5m · done 10:50 PM"],
      ["12-hour clock, one-digit hour", "✻ Cooked for 9s · done 5:24 PM"],
      ["12-hour clock, morning", "✻ Cooked for 9s · done 1:42 AM"],
      ["12-hour clock, midnight", "✻ Cooked for 9s · done 12:00 AM"],
      ["24-hour clock", "✻ Cooked for 9s · done 17:24"],
      ["24-hour clock before ten", "✻ Cooked for 9s · done 09:05"],
      ["24-hour clock, midnight", "✻ Cooked for 9s · done 00:00"],
      ["24-hour UTC clock", "✻ Cooked for 9s · done 17:24Z"],
    ])("completion row, %s: idle", (_name, row) => {
      expect(readSeatBeforePaste(slot(bypass, row), "claude-code", bypassSeat)).toBe("idle");
    });

    it.each([
      ["a verb not on the list", "✻ Marinated for 9s · done 10:50 PM"],
      ["a lower-case verb", "✻ cooked for 9s · done 10:50 PM"],
      ["no `· done` and time", "✻ Cooked for 9s"],
      ["`done` without its separator", "✻ Cooked for 9s done 10:50 PM"],
      ["indented", "  ✻ Cooked for 9s · done 10:50 PM"],
      ["trailing text", "✻ Cooked for 9s · done 10:50 PM · 1 shell still running"],
      ["another glyph", "✶ Cooked for 9s · done 10:50 PM"],
      ["no glyph", "Cooked for 9s · done 10:50 PM"],
      ["two spaces after the glyph", "✻  Cooked for 9s · done 10:50 PM"],
      ["sixty seconds", "✻ Cooked for 60s · done 10:50 PM"],
      ["zero minutes", "✻ Cooked for 0m 5s · done 10:50 PM"],
      ["a minute of 60", "✻ Cooked for 1h 60m 5s · done 10:50 PM"],
      ["hours without minutes", "✻ Cooked for 1h 5s · done 10:50 PM"],
      ["a duration in words", "✻ Cooked for a while · done 10:50 PM"],
      ["a zero-padded 12-hour clock", "✻ Cooked for 9s · done 05:24 PM"],
      ["a 12-hour hour of 13", "✻ Cooked for 9s · done 13:24 PM"],
      ["a lower-case meridiem", "✻ Cooked for 9s · done 5:24 pm"],
      ["a narrow no-break space before the meridiem", "✻ Cooked for 9s · done 5:24\u202fPM"],
      ["a one-digit 24-hour hour", "✻ Cooked for 9s · done 9:05"],
      ["a 24-hour hour of 24", "✻ Cooked for 9s · done 24:00"],
      ["the weekday of an earlier day", "✻ Cooked for 9s · done Monday 5:24 PM"],
      ["an agent row", "● Cooked for 9s · done 10:50 PM"],
    ])("completion row, malformed: %s: unknown", (_name, row) => {
      expect(readSeatBeforePaste(slot(bypass, row), "claude-code", bypassSeat)).toBe("unknown");
    });

    it.each([
      ["a live status row in the slot", slot(bypass, "✶ Churning… (3s · ↓ 120 tokens)")],
      ["a timer-less live status row in the slot", slot(bypass, "✻ Churning…")],
      ["the completion row in the slot, a live status row higher up (edit: an agent row)", editLine(bypass,
        (line) => line.startsWith("● I checked in"), "✶ Churning… (3s · ↓ 120 tokens)")],
      ["the completion row in the slot, a timer-less live status row higher up (edit)", editLine(bypass,
        (line) => line.startsWith("● I checked in"), "✻ Compacting conversation…")],
      ["the completion row in the slot, `esc to interrupt` in the footer (edit)", editLine(bypass, footerRow,
        "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents")],
      ["the completion row in the slot, the paste hint in the footer (edit)", editLine(bypass, footerRow, "  paste again to expand")],
      ["the completion row in the slot, the queued label in the box (edit)", editLine(bypass, claudeBoxRow, "❯ Press up to edit queued messages")],
      ["the completion row in the slot, a braille spinner higher up (edit)", editLine(bypass,
        (line) => line.startsWith("● I checked in"), "⠋ Working")],
    ])("running: %s: not-idle", (_name, frame) => {
      expect(readSeatBeforePaste(frame, "claude-code", bypassSeat)).toBe("not-idle");
    });
  });

  describe("the Codex completion row (ADV4-3): the grammar of separators.rs and clock_format.rs at rust-v0.160.0", () => {
    const completion = (row: string) => editLine(codex("after-enter-15s.J"), (line) => line.includes("Worked for"), `  ${row}`);
    it.each([
      ["12-hour clock (the real frame)", "Worked for 3s • 3:12 PM"],
      ["24-hour clock", "Worked for 3s • 15:12"],
      ["24-hour clock before ten", "Worked for 3s • 09:05"],
      ["24-hour clock at midnight", "Worked for 3s • 00:00"],
      ["12-hour clock at noon", "Worked for 3s • 12:00 PM"],
      ["the date prefix for another day this year", "Worked for 3s • Oct 3 at 3:12 PM"],
      ["the date prefix for another year, 24-hour", "Worked for 3s • Dec 31, 2025 at 23:59"],
      ["under a second", "Worked for <1s • 3:12 PM"],
      ["minutes", "Worked for 2m 0s • 3:12 PM"],
      ["hours", "Worked for 1h 0m 5s • 15:12"],
      ["appended runtime metrics", "Worked for 3s • 3:12 PM • Local tools: 2 calls (1.2s) • Inference: 1 call (850ms)"],
      ["every runtime metric, in source order", "Worked for 3s • 15:12 • Local tools: 1 call (0ms) • Inference: 3 calls (2.0s) • WebSocket: 4 events send (12ms) • Stream: 1 event (5ms) • 7 events received (9ms) • Responses API overhead: 40ms • Responses API inference: 1.5s • TTFT: 300ms (iapi) 310ms (service) • TBT: 20ms (service)"],
    ])("%s: idle", (_name, row) => {
      expect(readSeatBeforePaste(completion(row), "codex")).toBe("idle");
    });

    it.each([
      ["an hour of 25", "Worked for 3s • 25:12"],
      ["a lower-case meridiem", "Worked for 3s • 3:12 pm"],
      ["a 24-hour time with a meridiem", "Worked for 3s • 15:12 PM"],
      ["a one-digit 24-hour hour", "Worked for 3s • 9:05"],
      ["the wrong separator", "Worked for 3s · 3:12 PM"],
      ["a date with no `at`", "Worked for 3s • Oct 3 3:12 PM"],
      ["no time", "Worked for 3s"],
      ["no elapsed time", "3:12 PM"],
      ["a zero elapsed time", "Worked for 0s • 3:12 PM"],
      ["sixty seconds", "Worked for 60s • 3:12 PM"],
      ["a singular count drawn plural", "Worked for 3s • 3:12 PM • Local tools: 1 calls (1.2s)"],
      ["metrics out of source order", "Worked for 3s • 3:12 PM • Inference: 1 call (850ms) • Local tools: 2 calls (1.2s)"],
      ["an unknown trailing part", "Worked for 3s • 3:12 PM • something else"],
    ])("malformed, %s: unknown", (_name, row) => {
      expect(readSeatBeforePaste(completion(row), "codex")).toBe("unknown");
    });
  });
});

// Review round 1: the maintainer's changes 1 to 3, read on real frames and one- or two-line edits of them, named
// where they are made. Change 4 (audited prompt answers) is in session-transport-input-box.test.ts (T41, T41c).
describe("review round 1, change 1: the exact-text check keeps word boundaries (both runtime paths)", () => {
  // Edits: the box row of a real staged frame replaced by `box`; for Codex, `more` adds continuation rows.
  const claudeBox = (box: string) => editLine(claude("staged-short.raw"), claudeBoxRow, `❯\u00a0${box}`);
  const codexBox = (box: string, more: string[] = []) => editLine(codex("staged-short.J"), codexBoxRow, [`› ${box}`, ...more.map((row) => `  ${row}`)]);
  const both = [["claude-code", claudeBox], ["codex", codexBox]] as const;

  it.each(both)("%s: `now here` is not `nowhere`, either way round", (runtime, box) => {
    expect(readInputBox(box("nowhere"), runtime, "now here")).toBe("other");
    expect(readInputBox(box("now here"), runtime, "nowhere")).toBe("other");
    expect(readInputBox(box("now here"), runtime, "now here")).toBe("exact");
    expect(readInputBox(box("nowhere"), runtime, "nowhere")).toBe("exact");
  });

  it.each(both)("%s: a run of spaces or a Unicode space compares as one space, and only as a space", (runtime, box) => {
    expect(readInputBox(box("now   here"), runtime, "now here")).toBe("exact");
    expect(readInputBox(box("now here"), runtime, "now\u00a0\u2003here")).toBe("exact");
    expect(readInputBox(box("now here"), runtime, "  now here\n")).toBe("exact");
    expect(readInputBox(box("now here"), runtime, "nowhere ")).toBe("other");
  });

  it.each([
    ["claude-code", "staged-wrapped.raw"], ["claude-code", "staged-wrapped.J"], ["codex", "staged-wrapped.raw"], ["codex", "staged-wrapped.J"],
  ] as const)("%s %s: the real wrapped frame breaks rows at spaces, so the text is exact; the text with a break inside a word is ambiguous", (runtime, name) => {
    const frame = runtime === "codex" ? codex(name) : claude(name);
    expect(readInputBox(frame, runtime, texts.wrapped)).toBe("exact");
    // The first row break of the real frame falls between `next` and `scheduled`; without that space in the sent text
    // the break would be inside a word, which the box draws the same way.
    expect(readInputBox(frame, runtime, texts.wrapped.replace("next scheduled", "nextscheduled"))).toBe("ambiguous");
    // A space missing inside a row is a different text.
    expect(readInputBox(frame, runtime, texts.wrapped.replace("Background instructions", "Backgroundinstructions"))).toBe("other");
  });

  it("codex: the inline envelope's line breaks are row breaks between words, so it stays exact", () => {
    expect(readInputBox(codex("staged-envelope.J"), "codex", texts.envelope)).toBe("exact");
    expect(readInputBox(codex("product-path-staged-envelope.J"), "codex", texts.envelope)).toBe("exact");
  });

  it("codex: a row break counts as a space only where the two words joined would fit in the box's widest row", () => {
    // Edits: the box drawn over two rows. `now` and `here` joined (7 cells) fit in the 19-cell first row, so a word
    // wrapper would not have split `nowhere` there: the break is a space.
    expect(readInputBox(codexBox("check the queue now", ["here"]), "codex", "check the queue now here")).toBe("exact");
    // In a box no wider than 4 cells, `nowhere` would have to be split, so the break could be inside it: ambiguous.
    expect(readInputBox(codexBox("now", ["here"]), "codex", "now here")).toBe("ambiguous");
    // Wide characters count as two cells for the joined words: 3 + 4 wide characters may take 14 cells.
    expect(readInputBox(codexBox("one two 文字文", ["字字字字 three"]), "codex", "one two 文字文 字字字字 three")).toBe("ambiguous");
    // A sent text with no space where the box breaks its rows is ambiguous, never exact.
    expect(readInputBox(codexBox("check the queue now", ["here"]), "codex", "check the queue nowhere")).toBe("ambiguous");
    // A box that holds only part of the text, or more, is other text.
    expect(readInputBox(codexBox("check the queue now", ["here"]), "codex", "check the queue now here please")).toBe("other");
    expect(readInputBox(codexBox("check the queue now", ["here"]), "codex", "check the queue now")).toBe("other");
  });

  it("claude: the same rule on a two-row box (edit: the real wrapped frame's rows replaced)", () => {
    const twoRows = (first: string, second: string) => {
      const lines = claude("staged-wrapped.raw").split("\n");
      const at = lines.findIndex(claudeBoxRow);
      lines.splice(at, 3, `❯\u00a0${first}`, `  ${second}`);
      return lines.join("\n");
    };
    expect(readInputBox(twoRows("check the queue now", "here"), "claude-code", "check the queue now here")).toBe("exact");
    expect(readInputBox(twoRows("now", "here"), "claude-code", "now here")).toBe("ambiguous");
    expect(readInputBox(twoRows("check the queue now", "here"), "claude-code", "check the queue nowhere")).toBe("ambiguous");
    expect(readInputBox(twoRows("check the queue nowhere", "today"), "claude-code", "check the queue now here today")).toBe("other");
  });
});

describe("review round 1, change 2: a frame that names another client version never reads as a recorded layout", () => {
  const claudeVersion = (frame: string, version: string) => editLine(frame, (line) => line.includes("Claude Code v2.1.296"),
    ` ▐▛███▛█   Claude Code v${version}`);
  const codexHeader = (frame: string, version: string) => editLine(frame, (line) => line.includes(">_ OpenAI Codex"),
    `  >_ OpenAI Codex (v${version})`);
  const codexUpdate = (frame: string, from: string) => editLine(frame, (line) => line.includes("Update available!"),
    `│ ✨ Update available! ${from} -> 0.162.1         │`);

  it.each(["2.1.295", "2.1.297", "2.2.0", "3.0.0-beta"])("claude: a banner naming %s: the seat reads unknown and the box unrecognized", (version) => {
    // after-enter-15s.J reads idle by its completion row, and idle-fresh-suggestion by its banner; neither with this banner.
    expect(readSeatBeforePaste(claudeVersion(claude("after-enter-15s.J"), version), "claude-code")).toBe("unknown");
    expect(readSeatBeforePaste(claudeVersion(claude("idle-fresh-suggestion"), version), "claude-code")).toBe("unknown");
    expect(readInputBox(claudeVersion(claude("staged-short.raw"), version), "claude-code", texts.short)).toBe("unrecognized");
    expect(readInputBox(claudeVersion(claude("after-enter-0.4s.J"), version), "claude-code", texts.submit)).toBe("unrecognized");
  });

  it.each(["0.159.0", "0.161.0", "0.160.1"])("codex: a session header naming %s: the seat reads unknown and the box unrecognized", (version) => {
    expect(readSeatBeforePaste(codexHeader(codex("after-enter-15s.J"), version), "codex")).toBe("unknown");
    expect(readInputBox(codexHeader(codex("staged-short.J"), version), "codex", texts.short)).toBe("unrecognized");
    expect(readInputBox(codexHeader(codex("after-enter-0.4s.J"), version), "codex", texts.submit)).toBe("unrecognized");
  });

  it.each(["0.159.0", "0.161.0"])("codex: an update notice saying the running version is %s", (version) => {
    expect(readSeatBeforePaste(codexUpdate(codex("after-enter-15s.J"), version), "codex")).toBe("unknown");
    expect(readInputBox(codexUpdate(codex("staged-short.J"), version), "codex", texts.short)).toBe("unrecognized");
  });

  it("a later banner or header naming another version counts, though an earlier one names the recorded version", () => {
    // Edits: a second banner or header row under the first, as after the client was restarted in the same pane.
    const claudeTwice = editLine(claude("after-enter-15s.J"), (line) => line.includes("Claude Code v2.1.296"),
      [" ▐▛███▛█   Claude Code v2.1.296", " ▐▛███▛█   Claude Code v2.1.297"]);
    expect(readSeatBeforePaste(claudeTwice, "claude-code")).toBe("unknown");
    const codexTwice = editLine(codex("after-enter-15s.J"), (line) => line.includes(">_ OpenAI Codex"),
      ["  >_ OpenAI Codex (v0.160.0)", "  >_ OpenAI Codex (v0.161.0)"]);
    expect(readSeatBeforePaste(codexTwice, "codex")).toBe("unknown");
  });

  it("the recorded versions, and an update offered to a newer one, read as before", () => {
    expect(readSeatBeforePaste(claude("after-enter-15s.J"), "claude-code")).toBe("idle");
    expect(readSeatBeforePaste(claude("idle-fresh-suggestion"), "claude-code")).toBe("idle");
    // Every Codex frame here shows `Update available! 0.160.0 -> 0.162.1`: it runs 0.160.0.
    expect(codex("after-enter-15s.J")).toContain("Update available! 0.160.0 -> 0.162.1");
    expect(readSeatBeforePaste(codex("after-enter-15s.J"), "codex")).toBe("idle");
    expect(readInputBox(codex("staged-short.J"), "codex", texts.short)).toBe("exact");
  });

  it("no version on screen: the layout alone decides, which is evidence about the layout, not the version", () => {
    // Edit: the real OpenRig seat frame without its banner rows (they scroll away in a 30-row capture).
    const frame = claude("openrig-seat-bypass-idle").split("\n").filter((line) => !/[▐▝]/.test(line)).join("\n");
    expect(frame).not.toContain("Claude Code v");
    expect(readSeatBeforePaste(frame, "claude-code", "orch-advisor@sample-rig")).toBe("idle");
    // Edit: the Codex completion-row frame without its header.
    const codexFrame = editLine(codex("after-enter-15s.J"), (line) => line.includes(">_ OpenAI Codex"), "");
    expect(readSeatBeforePaste(editLine(codexFrame, (line) => line.includes("Update available!"), ""), "codex")).toBe("idle");
  });

  it("a version named in another client's form is not this client's version", () => {
    // Edit: a Claude transcript row quoting a Codex header, and a Codex frame quoting a Claude banner.
    expect(readSeatBeforePaste(editLine(claude("after-enter-15s.J"), (line) => line.startsWith("● OK"), "● OpenAI Codex (v0.161.0) is installed"), "claude-code")).toBe("idle");
    expect(readSeatBeforePaste(editLine(codex("after-enter-15s.J"), (line) => line.startsWith("• OK"), "• Claude Code v2.1.297 is installed"), "codex")).toBe("idle");
  });
});

describe("review round 1, change 3: a blank Claude status slot is idle only under a completion row or the fresh banner", () => {
  const BYPASS = "orch-advisor@sample-rig";
  const bypass = claude("openrig-seat-bypass-idle");
  // Edit: the completion row of the real OpenRig frame (the status slot) replaced by `rows`; the last one becomes the slot.
  const slotRows = (rows: string[]) => editLine(bypass, (line) => line.startsWith("✻ Crunched"), rows);

  it("streaming in the classic renderer, the last streamed row blank (the shape the 2.1.296 bundle does not rule out): unknown", () => {
    // Claude Code hides its spinner while streamed text is on screen and draws nothing in its place, so with
    // OpenRig's statusLine nothing on this screen says a turn runs.
    const frame = slotRows(["❯ Check the queue again.", "", "● I am checking the queue now; the first item is a", "  review request.", ""]);
    expect(frame).not.toMatch(/esc to interrupt|✶|paste again/);
    expect(readSeatBeforePaste(frame, "claude-code", BYPASS)).toBe("unknown");
  });

  it("the same with the message's `●` row scrolled out of the capture: unknown", () => {
    const frame = slotRows(["  review request, and then I will claim it.", ""]);
    expect(readSeatBeforePaste(frame, "claude-code", BYPASS)).toBe("unknown");
  });

  it("a blank slot with several blank rows under streamed text (as in the fullscreen layout): unknown", () => {
    const frame = editLine(claude("after-enter-15s.J"), (line) => line.startsWith("✻ Cooked"), "● I am checking the queue now.");
    expect(readSeatBeforePaste(frame, "claude-code")).toBe("unknown");
  });

  it("a fresh session whose first turn is streaming under the banner: unknown", () => {
    const frame = editLine(claude("idle-fresh-suggestion"), (line) => line.includes("◐ medium"), ["❯ Check the queue.", "", "● Checking.", "", ""]);
    expect(readSeatBeforePaste(frame, "claude-code")).toBe("unknown");
  });

  it("a blank slot with nothing above it: unknown", () => {
    const lines = claude("after-enter-15s.J").split("\n");
    const box = lines.map((line) => line.startsWith("❯")).lastIndexOf(true);
    const frame = [...lines.slice(0, box - 1).map(() => ""), ...lines.slice(box - 1)].join("\n");
    expect(readSeatBeforePaste(frame, "claude-code")).toBe("unknown");
  });

  it.each([
    ["the completion row in the slot itself (the real classic OpenRig frame)", bypass, BYPASS],
    ["blank rows between the completion row and the slot (after-enter-15s.J, fullscreen)", claude("after-enter-15s.J"), undefined],
    ["one blank row between the completion row and the slot (edit)", slotRows(["✻ Crunched for 9s · done 10:50 PM", ""]), BYPASS],
    ["blank under the welcome banner before any turn (idle-fresh-suggestion)", claude("idle-fresh-suggestion"), undefined],
    ["blank under the welcome banner, tmux notice above the rule (cleared-without-enter.J)", claude("cleared-without-enter.J"), undefined],
  ] as const)("idle: %s", (_name, frame, seat) => {
    expect(readSeatBeforePaste(frame, "claude-code", seat)).toBe("idle");
  });

  it("the completion row's own grammar still decides what sits above a blank slot", () => {
    expect(readSeatBeforePaste(slotRows(["✻ Crunched for 9s", ""]), "claude-code", BYPASS)).toBe("unknown");
    expect(readSeatBeforePaste(slotRows(["  ✻ Crunched for 9s · done 10:50 PM", ""]), "claude-code", BYPASS)).toBe("unknown");
  });

  it("a banner that is not the recorded one does not count as a fresh session", () => {
    const banner = (row: string) => editLine(claude("idle-fresh-suggestion"), (line) => line.includes("Claude Code v2.1.296"), row);
    expect(readSeatBeforePaste(banner(" ▐▛███▛█   Claude Code"), "claude-code")).toBe("unknown");
    expect(readSeatBeforePaste(banner("Claude Code v2.1.296"), "claude-code")).toBe("unknown");
    expect(readSeatBeforePaste(editLine(claude("idle-fresh-suggestion"), (line) => line.startsWith("▝▜"), "  some other row"), "claude-code")).toBe("unknown");
  });
});

// Edits: the box rows of a real staged frame replaced by `rows` (continuation rows drawn two cells in, as both TUIs
// draw them). Claude: staged-wrapped.raw's three rows; Codex: staged-short.J's one row.
const claudeRows = (rows: string[]) => {
  const lines = claude("staged-wrapped.raw").split("\n");
  const at = lines.findIndex(claudeBoxRow);
  lines.splice(at, 3, `❯ ${rows[0]}`, ...rows.slice(1).map((row) => `  ${row}`));
  return lines.join("\n");
};
const codexRows = (rows: string[]) => editLine(codex("staged-short.J"), codexBoxRow, [`› ${rows[0]}`, ...rows.slice(1).map((row) => `  ${row}`)]);
const both = [["claude-code", claudeRows], ["codex", codexRows]] as const;

describe("repair round 1 (review-safety-1): a row break counts as a space only where the box's text must have whitespace", () => {

  // S1. A 24-cell box: row 0 is 24 cells of NFD text (e + U+0301 is one cell and two code points, so 44 code
  // points), rows 1-2 one 28-letter word split at 24 cells. Counted in code points, row 0 made the box look 44 wide.
  const nfd = "é".repeat(10);
  it.each(both)("%s: combining marks do not widen the box, so a word split because it is wider than a row is not a space", (runtime, build) => {
    const frame = build([`${nfd} ${nfd} ok`, "abcdefghijklmnopqrstuvwx", "yz12"]);
    expect(readInputBox(frame, runtime, `${nfd} ${nfd} ok abcdefghijklmnopqrstuvwxyz12`)).toBe("ambiguous");
    expect(readInputBox(frame, runtime, `${nfd} ${nfd} ok abcdefghijklmnopqrstuvwx yz12`)).toBe("ambiguous");
    // Control: the same rows in plain ASCII.
    const plain = build([`${"e".repeat(10)} ${"e".repeat(10)} ok`, "abcdefghijklmnopqrstuvwx", "yz12"]);
    expect(readInputBox(plain, runtime, `${"e".repeat(10)} ${"e".repeat(10)} ok abcdefghijklmnopqrstuvwx yz12`)).toBe("ambiguous");
  });

  it.each(both)("%s: a ZWJ emoji sequence (7 code points, 2 cells) does not widen the box either", (runtime, build) => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const frame = build([`${family} ${family} ${family} ok`, "abcdefghijk", "lm"]);
    expect(readInputBox(frame, runtime, `${family} ${family} ${family} ok abcdefghijk lm`)).toBe("ambiguous");
  });

  // S2. Codex 0.160.0 also breaks rows with no space drawn: after a hyphen or a slash, between ideographs.
  it.each([
    ["after a hyphen", ["please run the self-", "review checklist"], "please run the self- review checklist"],
    ["after a slash", ["open the docs/", "guide today ok"], "open the docs/ guide today ok"],
    ["between ideographs", ["please review 日本語", "テキスト now"], "please review 日本語 テキスト now"],
  ])("codex: a break %s may be no space at all, so a space there is ambiguous", (_name, rows, sent) => {
    expect(readInputBox(codexRows(rows), "codex", sent)).toBe("ambiguous");
    // The box's own text (no space at the break) is ambiguous too, as before.
    expect(readInputBox(codexRows(rows), "codex", sent.replace(`${rows[0]} `, rows[0]!))).toBe("ambiguous");
  });

  it.each(both)("%s: a break no wrapper makes without a space reads exact when the two words joined fit in a row", (runtime, build) => {
    // Between two ASCII letters, and before a hyphen or a full stop: no UAX #14 break opportunity, and wrap-ansi
    // breaks only at spaces. The joined words (`queuenow`, `queue.---`) fit in the first row (29 and 30 cells), and
    // the next row's first word would not have fit after it.
    expect(readInputBox(build(["please check your rig's queue", "now and report"]), runtime, "please check your rig's queue now and report")).toBe("exact");
    expect(readInputBox(build(["please check your rig's queue.", "--- and report"]), runtime, "please check your rig's queue. --- and report")).toBe("exact");
    // Repair round 2: `sample-rig` has a break opportunity after its hyphen, so Codex may have started a word at `rig`
    // that its re-pass does not keep whole (see the repair round 2 block below): ambiguous since then.
    expect(readInputBox(build(["please check the sample-rig", "--- and report"]), runtime, "please check the sample-rig --- and report")).toBe("ambiguous");
  });

  it.each(both)("%s: a hard line break the next word would have fit before reads exact, whatever the characters", (runtime, build) => {
    // `self-` then `review`: a break a wrapper may make, but `review` would have fit after `self-` in a 34-cell row,
    // so both greedy wrappers would have kept it there: the box's text has a line break.
    expect(readInputBox(build(["the long first row of this message", "self-", "review now"]), runtime,
      "the long first row of this message self- review now")).toBe("exact");
    // The drawn row is measured with its indentation: 12 spaces of the text's own indentation leave no room.
    expect(readInputBox(build(["0123456789 abcdefgh", `${" ".repeat(12)}ab-`, "cd"]), runtime, "0123456789 abcdefgh ab- cd")).toBe("ambiguous");
  });

  it.each(both)("%s: the joined words must fit within the widest row's cells, the equality included", (runtime, build) => {
    // The widest row is 8 cells. `cdefg` + `hij` is 8 cells: exact. `cdefg` + `hijk` is 9: ambiguous. The drawn rows'
    // indentation (two cells on continuation rows) does not widen the box.
    expect(readInputBox(build(["ab cdefg", "hij"]), runtime, "ab cdefg hij")).toBe("exact");
    expect(readInputBox(build(["ab cdefg", "hijk"]), runtime, "ab cdefg hijk")).toBe("ambiguous");
  });

  it.each(both)("%s: a no-break space does not end a word, so it does not shorten the joined words", (runtime, build) => {
    // `aaaa\u00a0bbbbbcc` is one word to both wrappers (12 cells), split because it is wider than a row; the box is at
    // least 9 cells wide. Split at the no-break space, the joined words `bbbbbcc` would fit.
    expect(readInputBox(build(["aaaa\u00a0bbbbb", "cc"]), runtime, "aaaa bbbbb cc")).toBe("ambiguous");
  });

  it.each(both)("%s: a zero-width no-break space (U+FEFF), which compares as a space, does not widen the box", (runtime, build) => {
    // Row 0 draws 9 cells (`ab`, `cd`, `ef`, a space, `gh`); counted as compared (`ab cd ef gh`), it would be 11, and
    // `gh` + `ijklmnop` (10 cells) would fit.
    expect(readInputBox(build(["ab\ufeffcd\ufeffef gh", "ijklmnop"]), runtime, "ab cd ef gh ijklmnop")).toBe("ambiguous");
  });

  it.each(both)("%s: letters are compared as they are: a case difference is other text", (runtime, build) => {
    expect(readInputBox(build(["Now here"]), runtime, "now here")).toBe("other");
    expect(readInputBox(build(["now here"]), runtime, "now Here")).toBe("other");
  });
});

describe("repair round 1 (review-safety-1): versions are compared whole, and the fresh banner's last row exactly", () => {
  it.each(["2.1.296-rc1", "2.1.2960", "2.1.296.1"])("claude: a banner naming %s is another version", (version) => {
    const banner = (frame: string) => editLine(frame, (line) => line.includes("Claude Code v2.1.296"), ` ▐▛███▛█   Claude Code v${version}`);
    expect(readSeatBeforePaste(banner(claude("idle-fresh-suggestion")), "claude-code")).toBe("unknown");
    expect(readInputBox(banner(claude("staged-short.raw")), "claude-code", texts.short)).toBe("unrecognized");
  });

  it.each(["0.160.0-alpha.2", "0.160.00", "0.160.0+dev"])("codex: a session header naming %s is another version", (version) => {
    const header = (frame: string) => editLine(frame, (line) => line.includes(">_ OpenAI Codex"), `  >_ OpenAI Codex (v${version})`);
    expect(readSeatBeforePaste(header(codex("after-enter-15s.J")), "codex")).toBe("unknown");
    expect(readInputBox(header(codex("staged-short.J")), "codex", texts.short)).toBe("unrecognized");
  });

  it.each([
    ["no path after the logo foot", " ▝▝   ▝▝   workspace1"],
    ["the logo foot drawn narrower", " ▝▝ ▝▝ ~/workspace1/capture/composer-demo/work"],
    ["only the first half of the logo foot", " ▝▝   ~/workspace1/capture/composer-demo/work"],
  ])("claude: a fresh banner whose last row is edited (%s) is not the fresh session", (_name, row) => {
    const frame = editLine(claude("idle-fresh-suggestion"), (line) => line.startsWith(" ▝▝"), row);
    expect(readSeatBeforePaste(frame, "claude-code")).toBe("unknown");
  });
});

describe("repair round 2 (review-safety-2): Codex splits a word that fits after indentation or after a break inside a word", () => {
  // Codex 0.160.0's composer re-pass (tui/src/bottom_pane/textarea/wrapping.rs at rust-v0.160.0) keeps a word that
  // fits in a row whole only where the word starts on a row that already holds text: after whitespace, or at one of
  // textwrap's breaks. A row holding only indentation takes the next word with no check ("Partial whitespace rows
  // absorb the next word"), and the overflow check then splits it where the row fills, though textwrap had put the
  // word on a row of its own. Edit of the real wrapped frame (its box is 112 to 117 cells): `› ` + 8 spaces + a
  // 110-letter token's first 108 letters, then its last 2, then the frame's first real row as a continuation row.
  const TOKEN = "Zm9vYmFyYmF6cXV4".repeat(7).slice(0, 110);
  const indentedTokenFrame = editLine(codex("staged-wrapped.raw"), (line) => line.startsWith("› Background"),
    [`› ${" ".repeat(8)}${TOKEN.slice(0, 108)}`, `  ${TOKEN.slice(108)}`, `  ${codex("staged-wrapped.raw").split("\n").find((line) => line.startsWith("› Background"))!.slice(2)}`]);

  it("codex: the real wrapped frame with an indented token split where its row fills: a space sent at the split is not exact", () => {
    expect(TOKEN).toMatch(/^[A-Za-z0-9]{110}$/);
    expect(readInputBox(indentedTokenFrame, "codex", `${" ".repeat(8)}${TOKEN}\n${texts.wrapped.trim()}`)).toBe("ambiguous");
    expect(readInputBox(indentedTokenFrame, "codex", `${" ".repeat(8)}${TOKEN.slice(0, 108)} ${TOKEN.slice(108)}\n${texts.wrapped.trim()}`)).toBe("ambiguous");
  });

  it.each(both)("%s: an indented first or continuation row: only the first-fit rule reads its break", (runtime, build) => {
    // A 38-cell box. Row 0: 4 spaces + 34 of a 36-letter token, then its last 2 letters; the joined token (36 cells)
    // fits in the 38-cell row.
    const tok = "0123456789abcdefghijklmnopqrstuvwxyz";
    const tail = ["Please run this exact command from the", "repository root."];
    expect(readInputBox(build([`    ${tok.slice(0, 34)}`, tok.slice(34), ...tail]), runtime,
      `    ${tok.slice(0, 34)} ${tok.slice(34)}\n${tail.join(" ")}`)).toBe("ambiguous");
    expect(readInputBox(build([`    ${tok.slice(0, 34)}`, tok.slice(34), ...tail]), runtime, `    ${tok}\n${tail.join(" ")}`)).toBe("ambiguous");
    // The same on a continuation row, drawn two cells in by the box, then four of the text's own.
    expect(readInputBox(build([tail[0]!, `    ${tok.slice(0, 34)}`, tok.slice(34)]), runtime,
      `${tail[0]}\n    ${tok.slice(0, 34)} ${tok.slice(34)}`)).toBe("ambiguous");
    // One cell of the text's own indentation is enough, on a continuation row and on the first row.
    expect(readInputBox(build([tail[0]!, ` ${tok.slice(0, 34)}`, tok.slice(34)]), runtime,
      `${tail[0]}\n ${tok.slice(0, 34)} ${tok.slice(34)}`)).toBe("ambiguous");
    expect(readInputBox(build([` ${tok.slice(0, 34)}`, tok.slice(34), ...tail]), runtime,
      ` ${tok.slice(0, 34)} ${tok.slice(34)}\n${tail.join(" ")}`)).toBe("ambiguous");
    // Control: without the indentation the joined token is a word that fits, so the split is the text's space.
    expect(readInputBox(build([tail[0]!, tok.slice(0, 34), tok.slice(34)]), runtime,
      `${tail[0]}\n${tok.slice(0, 34)} ${tok.slice(34)}`)).toBe("exact");
    // Control: an indented row whose next word would have fit after it still reads its line break.
    expect(readInputBox(build([tail[0]!, "    first step", "second step"]), runtime, `${tail[0]}\n    first step\nsecond step`)).toBe("exact");
  });

  it.each(both)("%s: a break opportunity inside the row's last word: only the first-fit rule reads the break", (runtime, build) => {
    // Codex's re-pass checks a word that starts after a hyphen or a slash only at the start of a textwrap line, so in
    // a row that took the next textwrap line such a word is split where the row fills (`ddddd` below).
    expect(readInputBox(build(["aaaaaa c-ddddddddddd", "ddddd"]), runtime, "aaaaaa c-ddddddddddd ddddd")).toBe("ambiguous");
    expect(readInputBox(build(["open the x.com/pa", "th now"]), runtime, "open the x.com/pa th now")).toBe("ambiguous");
    expect(readInputBox(build(["please run the self-reviewer", "s now"]), runtime, "please run the self-reviewer s now")).toBe("ambiguous");
    // Controls: no break opportunity inside the last word (letters, digits, `'` and `.,:;`): the split is a space.
    expect(readInputBox(build(["please run the selfreviewer", "s now"]), runtime, "please run the selfreviewer s now")).toBe("exact");
    expect(readInputBox(build(["please check your rig's", "queue now"]), runtime, "please check your rig's queue now")).toBe("exact");
    expect(readInputBox(build(["please read v1.2.3", "now ok"]), runtime, "please read v1.2.3 now ok")).toBe("exact");
  });

  it.each(both)("%s: the row before the break must start with printable ASCII text at its first cell", (runtime, build) => {
    // Codex keeps the row's last word whole only on a row that already holds text. A non-ASCII first character may be
    // whitespace to Codex and not to this reader (U+0085 is whitespace to Rust's char::is_whitespace, not to `\s`).
    expect(readInputBox(build(["\u0085 please run the selfreviewer", "s now"]), runtime, "\u0085 please run the selfreviewer s now")).toBe("ambiguous");
    expect(readInputBox(build(["日本 please run the selfreviewer", "s now"]), runtime, "日本 please run the selfreviewer s now")).toBe("ambiguous");
    // The box's own cells are counted by the row's place in the box, a blank first row included: a text that starts
    // with a line break draws its first text on a continuation row, two cells in.
    expect(readInputBox(build(["", "please run the selfreviewer", "s now"]), runtime, "\nplease run the selfreviewer s now")).toBe("exact");
  });

  it("codex: a continuation row drawn one cell in (not the recorded layout) is not read by the joined-word rule", () => {
    const frame = editLine(codex("staged-short.J"), codexBoxRow, ["› please run the long checklist", " xplease run the selfreviewer", "  s now"]);
    expect(readInputBox(frame, "codex", "please run the long checklist xplease run the selfreviewer s now")).toBe("ambiguous");
  });

  it.each(both)("%s: wide characters on the row before a break count two cells in the first-fit rule (F2)", (runtime, build) => {
    // Codex may break between an ideograph and `a` with no space drawn. The 10 ideographs take 20 cells, so `abcdefgh`
    // would not have fit after them in the 20-cell box; counted one cell per character, the drawn row (the box's own
    // cell included) would leave room for it (11 + 1 + 8 <= 20).
    const ideographs = "日本語日本語日本語日";
    expect([...ideographs]).toHaveLength(10);
    expect(readInputBox(build([ideographs, "abcdefgh ijklmnopqrs"]), runtime, `${ideographs} abcdefgh ijklmnopqrs`)).toBe("ambiguous");
  });
});

describe("review round 1 polish (review-safety-3 F2): the no-break pair list is pinned at its edge", () => {
  // A break between a row's last word and the next row's first character counts as a space only for the pairs in
  // ASCII_NO_BREAK_BEFORE (or two letters or digits). Rows `check foo` | `<c>bar now`: the box is 9 cells, so the
  // first-fit rule fails (`<c>bar` would not have fit after `check foo`), and `foo<c>bar` (7 cells) fits in a row.
  const PUNCTUATION = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"];
  const LISTED = [..."-/.,:;!?)]}"];
  it("the punctuation characters split into the 11 listed and 21 others", () => {
    expect(PUNCTUATION).toHaveLength(32);
    expect(PUNCTUATION.filter((c) => LISTED.includes(c))).toHaveLength(11);
  });

  for (const [runtime, build] of both) {
    it.each(LISTED)(`${runtime}: a break before %s, a listed character, reads exact`, (c) => {
      expect(readInputBox(build(["check foo", `${c}bar now`]), runtime, `check foo ${c}bar now`)).toBe("exact");
    });

    it.each(PUNCTUATION.filter((c) => !LISTED.includes(c)))(`${runtime}: a break before %s, not listed, reads ambiguous`, (c) => {
      expect(readInputBox(build(["check foo", `${c}bar now`]), runtime, `check foo ${c}bar now`)).toBe("ambiguous");
    });

    it(`${runtime}: a break between \`;\` and \`(\` reads ambiguous: UAX #14 has a break opportunity there (LB30 forbids one before \`(\` only after AL, HL or NU; \`;\` is IS)`, () => {
      expect(readInputBox(build(["check foo;", "(bar) now"]), runtime, "check foo; (bar) now")).toBe("ambiguous");
      // The box's own text (no space at the break) reads ambiguous too.
      expect(readInputBox(build(["check foo;", "(bar) now"]), runtime, "check foo;(bar) now")).toBe("ambiguous");
    });
  }
});
