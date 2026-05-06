// V1 Shell Redesign — Phase 1 — VellumSheet primitive.
//
// API surface tests: edge, width, onClose, testId, registration marks.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VellumSheet } from "../src/components/ui/vellum-sheet";

describe("VellumSheet (Phase 1 primitive)", () => {
  it("renders children", () => {
    render(<VellumSheet>BODY</VellumSheet>);
    expect(screen.getByText("BODY")).toBeTruthy();
  });

  it("default carries vellum-heavy class", () => {
    const { container } = render(<VellumSheet testId="vs">x</VellumSheet>);
    const el = container.querySelector("[data-testid='vs']") as HTMLElement;
    expect(el.className).toContain("vellum-heavy");
  });

  it("default width=wide applies the wide width class (38rem ~608px iPad-portrait)", () => {
    const { container } = render(<VellumSheet testId="vs-w">x</VellumSheet>);
    const el = container.querySelector("[data-testid='vs-w']") as HTMLElement;
    expect(el.className).toContain("lg:w-[38rem]");
    expect(el.className).toContain("lg:max-w-[80vw]");
  });

  it("width=narrow applies the narrow width class", () => {
    const { container } = render(
      <VellumSheet width="narrow" testId="vs-n">x</VellumSheet>,
    );
    const el = container.querySelector("[data-testid='vs-n']") as HTMLElement;
    expect(el.className).toContain("lg:w-[22rem]");
  });

  it("edge=right (default) places left border (1px outline-variant per border weight doctrine)", () => {
    const { container } = render(<VellumSheet testId="vs-r">x</VellumSheet>);
    const el = container.querySelector("[data-testid='vs-r']") as HTMLElement;
    expect(el.className).toContain("border-l");
    expect(el.className).toContain("border-outline-variant");
  });

  it("edge=left places right border (1px outline-variant per border weight doctrine)", () => {
    const { container } = render(
      <VellumSheet edge="left" testId="vs-l">x</VellumSheet>,
    );
    const el = container.querySelector("[data-testid='vs-l']") as HTMLElement;
    expect(el.className).toContain("border-r");
    expect(el.className).toContain("border-outline-variant");
  });

  it("renders close button when onClose provided; clicking calls handler", () => {
    const onClose = vi.fn();
    render(
      <VellumSheet onClose={onClose} testId="vs-c">x</VellumSheet>,
    );
    const closeBtn = screen.getByLabelText("Close sheet");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("omits close button when onClose not provided", () => {
    const { container } = render(<VellumSheet>x</VellumSheet>);
    expect(container.querySelector("button[aria-label='Close sheet']")).toBeNull();
  });

  it("renders 4 registration marks", () => {
    const { container } = render(<VellumSheet>x</VellumSheet>);
    expect(container.querySelectorAll(".reg-tl, .reg-tr, .reg-bl, .reg-br").length).toBe(4);
  });

  it("dialog role + aria-modal=false (non-modal drawer per content-drawer.md)", () => {
    const { container } = render(<VellumSheet testId="vs-aria">x</VellumSheet>);
    const el = container.querySelector("[data-testid='vs-aria']") as HTMLElement;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("false");
  });
});
