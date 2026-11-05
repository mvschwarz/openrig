import { describe, expect, it } from "vitest";
import { createStyle } from "../src/theme.js";

// #2498: light ink on the terminal's own background vanishes on a light theme. Body text (`bright`) and the codex
// mark's `_` (`markInk`) use the terminal's default foreground instead, which reads on either background. On a
// background the TUI paints itself (the selected-row wash, the terminal mark's dark cell), the light ink stays.
describe("light ink reads on light and dark terminals", () => {
  it.each(["truecolor", "256", "16"] as const)("bright and markInk use the terminal's default foreground in %s mode", (mode) => {
    const style = createStyle(mode);
    expect(style.paint("bright", "intent")).toBe("\x1b[39mintent\x1b[0m");
    expect(style.paint("bright", "INTENT", { bold: true })).toBe("\x1b[1;39mINTENT\x1b[0m");
    expect(style.paint("markInk", "_", { bold: true })).toBe("\x1b[1;39m_\x1b[0m");
  });

  it("keeps the light ink on a background the TUI paints itself", () => {
    expect(createStyle("truecolor").paint("bright", "row", { bg: "selection" })).toBe("\x1b[38;2;232;234;240;48;2;34;52;82mrow\x1b[0m");
    expect(createStyle("256").paint("bright", ">", { bg: "markBg", bold: true })).toBe("\x1b[1;38;5;254;48;5;233m>\x1b[0m");
    expect(createStyle("16").paint("bright", "_", { bg: "markBg" })).toBe("\x1b[97;40m_\x1b[0m");
  });

  it("leaves text plain with colour off", () => {
    expect(createStyle("none").paint("bright", "intent")).toBe("intent");
  });
});

// Found in #2499's review: a 16-colour background is the token's colour code plus 10, so each token used as a
// background must store a colour code (30-37, 90-97) for the band to show at all.
describe("16-colour backgrounds", () => {
  it.each(["selection", "markBg", "clawd", "accent"] as const)("paints a real background code for %s", (bg) => {
    const code = Number(/^\x1b\[([0-9;]+)m/.exec(createStyle("16").paint("bright", "x", { bg }))![1]!.split(";").at(-1));
    expect((code >= 40 && code <= 47) || (code >= 100 && code <= 107), `background SGR ${code}`).toBe(true);
  });
});
