// V1 Shell Redesign — Phase 1 — RigStamp primitive.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RigStamp } from "../src/components/ui/rig-stamp";

describe("RigStamp (Phase 1 primitive)", () => {
  it("renders the text", () => {
    render(<RigStamp text="VELOCITY" />);
    expect(screen.getByText("VELOCITY")).toBeTruthy();
  });

  it("applies stamp-watermark class", () => {
    const { container } = render(<RigStamp text="X" testId="rs" />);
    const el = container.querySelector("[data-testid='rs']") as HTMLElement;
    expect(el.className).toContain("stamp-watermark");
  });

  it("size=md is default and applies text-sm", () => {
    const { container } = render(<RigStamp text="X" testId="rs-md" />);
    const el = container.querySelector("[data-testid='rs-md']") as HTMLElement;
    expect(el.className).toContain("text-sm");
  });

  it("size=xl applies text-4xl", () => {
    const { container } = render(<RigStamp text="X" size="xl" testId="rs-xl" />);
    const el = container.querySelector("[data-testid='rs-xl']") as HTMLElement;
    expect(el.className).toContain("text-4xl");
  });

  it("size=sm applies the small class", () => {
    const { container } = render(<RigStamp text="X" size="sm" testId="rs-sm" />);
    const el = container.querySelector("[data-testid='rs-sm']") as HTMLElement;
    expect(el.className).toContain("text-[10px]");
  });

  it("position numeric values become px", () => {
    const { container } = render(
      <RigStamp text="X" position={{ top: 12, right: 8 }} testId="rs-p" />,
    );
    const el = container.querySelector("[data-testid='rs-p']") as HTMLElement;
    expect(el.style.top).toBe("12px");
    expect(el.style.right).toBe("8px");
  });

  it("position string values pass through", () => {
    const { container } = render(
      <RigStamp text="X" position={{ left: "1rem", bottom: "auto" }} testId="rs-ps" />,
    );
    const el = container.querySelector("[data-testid='rs-ps']") as HTMLElement;
    expect(el.style.left).toBe("1rem");
    expect(el.style.bottom).toBe("auto");
  });

  it("merges className", () => {
    const { container } = render(
      <RigStamp text="X" className="opacity-25" testId="rs-c" />,
    );
    const el = container.querySelector("[data-testid='rs-c']") as HTMLElement;
    expect(el.className).toContain("opacity-25");
  });

  it("aria-hidden true (decorative)", () => {
    const { container } = render(<RigStamp text="X" testId="rs-a" />);
    const el = container.querySelector("[data-testid='rs-a']") as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });
});
