// OPR.0.4.0.39 FR-1 - the shared static-terminal component. The preview internals
// are mocked; this asserts the plate/button structure, the smoke plate, and the
// testid passthrough that the two callers (grid thumbnail + ProgressiveTerminal
// static) depend on.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  StaticTerminalPlate,
  SMOKED_STATIC_PLATE_CLASS,
} from "../src/components/terminal/StaticTerminalPlate.js";

vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SessionPreviewPane: ({ sessionName, variant, testIdPrefix }: any) => (
    <div
      data-testid={testIdPrefix ? `${testIdPrefix}-pane` : "preview"}
      data-variant={variant}
      data-session={sessionName}
    />
  ),
}));

describe("StaticTerminalPlate (OPR.0.4.0.39 FR-1)", () => {
  it("renders a NON-interactive plate (div) carrying the smoke plate + compact preview", () => {
    render(
      <StaticTerminalPlate
        sessionName="dev@rig"
        plateTestId="x-thumb-plate"
        previewTestIdPrefix="x-thumb"
        className="min-w-0 flex-1 overflow-hidden"
      />,
    );
    const plate = screen.getByTestId("x-thumb-plate");
    expect(plate.tagName).toBe("DIV");
    expect(plate.className).toContain("bg-stone-950/85");
    expect(plate.className).toContain("backdrop-blur-sm");
    expect(plate.className).toContain("overflow-hidden"); // caller className composed in
    const pane = screen.getByTestId("x-thumb-pane");
    expect(pane.getAttribute("data-variant")).toBe("compact-terminal");
    expect(pane.getAttribute("data-session")).toBe("dev@rig");
  });

  it("renders an INTERACTIVE click-to-live button when onClick is provided", () => {
    const onClick = vi.fn();
    render(
      <StaticTerminalPlate
        sessionName="dev@rig"
        plateTestId="pt-static"
        previewTestIdPrefix="pt-preview"
        onClick={onClick}
        ariaLabel="go live"
        title="Click to go live"
      />,
    );
    const btn = screen.getByTestId("pt-static");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toContain("bg-stone-950/85");
    expect(btn.getAttribute("aria-label")).toBe("go live");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByTestId("pt-preview-pane")).toBeTruthy();
  });

  it("exports the shared smoke-plate class", () => {
    expect(SMOKED_STATIC_PLATE_CLASS).toBe("bg-stone-950/85 backdrop-blur-sm");
  });
});
