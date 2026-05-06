// V1 Shell Redesign — Phase 1 — VellumInput primitive.

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VellumInput } from "../src/components/ui/vellum-input";
import * as React from "react";

describe("VellumInput (Phase 1 primitive)", () => {
  it("renders an <input>", () => {
    const { container } = render(<VellumInput testId="vi" />);
    const el = container.querySelector("input[data-testid='vi']");
    expect(el).toBeTruthy();
  });

  it("applies vellum form classes", () => {
    const { container } = render(<VellumInput testId="vi-c" />);
    const el = container.querySelector("input[data-testid='vi-c']") as HTMLInputElement;
    expect(el.className).toContain("border-stone-300");
    expect(el.className).toContain("bg-white");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("text-xs");
  });

  it("forwards ref to underlying input", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<VellumInput ref={ref} testId="vi-r" />);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("INPUT");
  });

  it("forwards native props (value, onChange)", () => {
    let captured = "";
    const { container } = render(
      <VellumInput
        defaultValue="abc"
        onChange={(e) => {
          captured = (e.target as HTMLInputElement).value;
        }}
        testId="vi-n"
      />,
    );
    const el = container.querySelector("input[data-testid='vi-n']") as HTMLInputElement;
    expect(el.value).toBe("abc");
    fireEvent.change(el, { target: { value: "xyz" } });
    expect(captured).toBe("xyz");
  });

  it("merges custom className", () => {
    const { container } = render(<VellumInput className="border-red-500" testId="vi-m" />);
    const el = container.querySelector("input[data-testid='vi-m']") as HTMLInputElement;
    expect(el.className).toContain("border-red-500");
  });
});
