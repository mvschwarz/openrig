// A value handed to the copy action is printed to the operator's terminal, so it must not carry
// terminal control. The control-socket row cleaned its display text but stored the raw path as the
// copy value, and printForCopyText only removed newlines — an OSC or CSI sequence in a socket path or
// a daemon-served link therefore reached the terminal while the operator was selecting the line.

import { describe, expect, it } from "vitest";
import { renderScreen } from "../src/render.js";
import { printForCopyText } from "../src/print-for-copy.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { terminalSafeText } from "../src/terminal-safe-text.js";
import { sanitizeHostDisplayName } from "../src/topology/host-label.js";

const snap = demoSnapshot();
const ESC = "\u001b";
const OSC52 = `${ESC}]52;c;${Buffer.from("pwned").toString("base64")}\u0007`;
const CSI_CLEAR = `${ESC}[2J`;

describe("terminalSafeText", () => {
  it("removes an OSC payload whole, including one Node's stripper leaves behind", () => {
    expect(terminalSafeText(`/tmp/${OSC52}sock`)).toBe("/tmp/sock");
    // An OSC whose payload contains spaces is the case the VT stripper does not consume whole.
    expect(terminalSafeText(`${ESC}]0;a window title\u0007/tmp/x`)).toBe("/tmp/x");
  });

  it("removes CSI and the remaining escape sequences, and spaces out control bytes", () => {
    expect(terminalSafeText(`a${CSI_CLEAR}b${ESC}[1;31mc`)).toBe("abc");
    expect(terminalSafeText("a\u0000b\u007fc")).toBe("a b c");
    expect(terminalSafeText("a\rb")).toBe("a b");
  });

  it("keeps bidi marks by default, because they are text the caller meant to have", () => {
    expect(terminalSafeText("a\u202eb")).toBe("a\u202eb");
    expect(terminalSafeText("a\u202eb", { keepBidi: true })).toBe("a\u202eb");
    expect(terminalSafeText("a\u202eb", { keepBidi: false })).toBe("a b");
  });

  it("trims only when asked", () => {
    expect(terminalSafeText("  x  ")).toBe("  x  ");
    expect(terminalSafeText("  x  ", { trim: true })).toBe("x");
  });
});

describe("the copy action prints safe bytes", () => {
  it("never prints an escape sequence from the value it was given", () => {
    const printed = printForCopyText("Control socket", `/tmp/${OSC52}${CSI_CLEAR}sock`);
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain("\u0007");
    expect(printed).toContain("/tmp/sock");
  });

  it("keeps the value on one line, with control bytes spaced rather than glued", () => {
    // A control byte becomes a space, not nothing: two fields it separated must not run together.
    expect(printForCopyText("x", "a\nb\rc")).toBe(`\r\nx\r\n\r\na b c\r\n\r\nSelect the line above to copy it. Press Enter to return to OpenRig.\r\n`);
  });
});

describe("the control-socket row cleans its display and keeps the bound path as the copy value", () => {
  it("shows no control bytes and hands the copy action the path main.ts recognises", () => {
    const hostile = `/tmp/o${ESC}]0;pwned\u0007${CSI_CLEAR}x.sock`;
    const screen = renderScreen(
      createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
      snap,
      { cols: 120, rows: 32, controlSocketPath: hostile },
    );
    const action = screen.hitMap.find((h) => h.action?.type === "print-for-copy")?.action as { value: string } | undefined;
    // The action keeps the bound path byte for byte: main.ts recognises this copy by comparing the
    // value with `socket.path`, so cleaning it here would hand the click to the screen underneath.
    expect(action?.value).toBe(hostile);
    // What the row shows, and what the sink prints, carry no terminal control.
    expect(screen.lines.at(-1)).not.toContain(ESC);
    expect(printForCopyText("Control socket", action!.value)).not.toContain(ESC);
  });

  it("leaves a bidi mark in a copied path alone", () => {
    const path = "/tmp/\u202esock";
    const screen = renderScreen(
      createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
      snap,
      { cols: 120, rows: 32, controlSocketPath: path },
    );
    const action = screen.hitMap.find((h) => h.action?.type === "print-for-copy")?.action as { value: string } | undefined;
    expect(action?.value).toBe(path);
    expect(printForCopyText("Control socket", action!.value)).toContain(path);
  });
});

describe("detail text is cleaned and redacted in the order that keeps the redaction working", () => {
  it("redacts a credential that cleaning would otherwise split", () => {
    // A C1 byte inside the credential: cleaning turns it into a space, and the credential pattern
    // excludes whitespace, so redacting only after cleaning would leave the fragments on screen.
    const detail = "startup failed for https://user:pa\u0085ss@example.com";
    const screen = renderScreen(
      createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
      snap,
      { cols: 200, rows: 40, unavailable: detail, unavailableExpanded: true },
    );
    const shown = screen.lines.join("\n");
    expect(shown).toContain("[redacted]@example.com");
    expect(shown).not.toContain("pa ss");
    expect(shown).not.toContain("pass@");
  });

  it("redacts a credential whose URL prefix an escape sequence interrupted", () => {
    // The escape sequence hides the `//` from the redactor, and the C1 byte then becomes a space, which
    // the credential pattern cannot match across. Redaction therefore runs between taking the escapes
    // out and replacing the control bytes. The assertions use tokens that survive line wrapping, so a
    // leak cannot pass by being split across two rows.
    const detail = "startup failed for https:\x1b[31m//user:pa\u0085ss@example.com";
    const screen = renderScreen(
      createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
      snap,
      { cols: 200, rows: 40, unavailable: detail, unavailableExpanded: true },
    );
    const shown = screen.lines.join("\n");
    expect(shown).toContain("[redacted]@example.com");
    expect(shown).not.toContain("ss@example.com");
    expect(shown).not.toContain("pa ss");
    expect(shown).not.toContain("\x1b");
  });

  it("removes an OSC payload whole, credential and all, rather than redacting inside it first", () => {
    // Redacting a URL inside an OSC payload can delete the sequence's own introducer, and then the
    // stripper no longer recognises the sequence: its tail would be shown as literal text. Taking the
    // sequence out first is what makes the payload leave with it.
    for (const detail of [
      "loaded \x1b]user:secret@hostsuffixSECRET@example.com",
      "loaded https://\u009duser:secret@host suffixPUBLIC@example.com",
    ]) {
      const screen = renderScreen(
        createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
        snap,
        { cols: 200, rows: 40, unavailable: detail, unavailableExpanded: true },
      );
      const shown = screen.lines.join("\n");
      expect(shown, detail).not.toContain("SECRET");
      expect(shown, detail).not.toContain("PUBLIC");
      expect(shown, detail).not.toContain("secret");
      expect(shown, detail).not.toContain("\x1b");
      expect(shown, detail).not.toContain("\u009d");
    }
  });

  it("still prints no terminal control alongside the redaction", () => {
    const screen = renderScreen(
      createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
      snap,
      { cols: 200, rows: 40, unavailable: `https://user:secret@example.com ${ESC}[2J`, unavailableExpanded: true },
    );
    const shown = screen.lines.join("\n");
    expect(shown).toContain("[redacted]@example.com");
    expect(shown).not.toContain(ESC);
  });
});

describe("sanitizeHostDisplayName still trims and drops bidi marks", () => {
  it("returns a plain label", () => {
    // A label closes the gap a removed control byte leaves, so `host` + bidi mark + `name` reads as
    // the name it was, and the surrounding whitespace is trimmed.
    expect(sanitizeHostDisplayName(`  ${ESC}[31mhost\u202ename  `)).toBe("hostname");
  });
});
