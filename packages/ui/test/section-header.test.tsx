// V1 Shell Redesign — Phase 1 — SectionHeader primitive.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionHeader } from "../src/components/ui/section-header";

describe("SectionHeader (Phase 1 primitive)", () => {
  it("renders children", () => {
    render(<SectionHeader>OVERVIEW</SectionHeader>);
    expect(screen.getByText("OVERVIEW")).toBeTruthy();
  });

  it("applies canonical eyebrow classes", () => {
    const { container } = render(<SectionHeader>X</SectionHeader>);
    const el = container.querySelector("header") as HTMLElement;
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("text-[10px]");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("tracking-[0.18em]");
  });

  it("renders right slot when provided", () => {
    render(
      <SectionHeader right={<span data-testid="rt">EXTRA</span>}>X</SectionHeader>,
    );
    expect(screen.getByTestId("rt")).toBeTruthy();
  });

  it("tone=muted applies on-surface-variant color", () => {
    const { container } = render(<SectionHeader tone="muted">X</SectionHeader>);
    expect((container.firstChild as HTMLElement).className).toContain(
      "text-on-surface-variant",
    );
  });

  it("tone=alert applies tertiary color", () => {
    const { container } = render(<SectionHeader tone="alert">X</SectionHeader>);
    expect((container.firstChild as HTMLElement).className).toContain("text-tertiary");
  });

  it("tone=strong applies stone-900 + font-bold", () => {
    const { container } = render(<SectionHeader tone="strong">X</SectionHeader>);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain("text-stone-900");
    expect(cls).toContain("font-bold");
  });

  it("default as=header element", () => {
    const { container } = render(<SectionHeader>X</SectionHeader>);
    expect(container.querySelector("header")).toBeTruthy();
  });

  it("polymorphic as=div renders <div>", () => {
    const { container } = render(<SectionHeader as="div">X</SectionHeader>);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("polymorphic as=section renders <section>", () => {
    const { container } = render(<SectionHeader as="section">X</SectionHeader>);
    expect(container.querySelector("section")).toBeTruthy();
  });
});
