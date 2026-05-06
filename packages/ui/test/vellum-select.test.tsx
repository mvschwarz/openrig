// V1 Shell Redesign — Phase 1 — VellumSelect primitive.

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VellumSelect } from "../src/components/ui/vellum-select";
import * as React from "react";

describe("VellumSelect (Phase 1 primitive)", () => {
  it("renders a <select>", () => {
    const { container } = render(
      <VellumSelect testId="vs">
        <option value="a">A</option>
      </VellumSelect>,
    );
    expect(container.querySelector("select[data-testid='vs']")).toBeTruthy();
  });

  it("renders option children", () => {
    const { container } = render(
      <VellumSelect testId="vs-opts">
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </VellumSelect>,
    );
    const opts = container.querySelectorAll("option");
    expect(opts.length).toBe(2);
    expect(opts[0].textContent).toBe("Alpha");
  });

  it("applies vellum form classes", () => {
    const { container } = render(
      <VellumSelect testId="vs-c">
        <option>x</option>
      </VellumSelect>,
    );
    const el = container.querySelector("select[data-testid='vs-c']") as HTMLSelectElement;
    expect(el.className).toContain("border-stone-300");
    expect(el.className).toContain("bg-white");
    expect(el.className).toContain("font-mono");
  });

  it("forwards ref", () => {
    const ref = React.createRef<HTMLSelectElement>();
    render(
      <VellumSelect ref={ref} testId="vs-r">
        <option>x</option>
      </VellumSelect>,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("SELECT");
  });

  it("fires onChange", () => {
    let captured = "";
    const { container } = render(
      <VellumSelect
        defaultValue="a"
        onChange={(e) => {
          captured = (e.target as HTMLSelectElement).value;
        }}
        testId="vs-n"
      >
        <option value="a">A</option>
        <option value="b">B</option>
      </VellumSelect>,
    );
    const el = container.querySelector("select[data-testid='vs-n']") as HTMLSelectElement;
    fireEvent.change(el, { target: { value: "b" } });
    expect(captured).toBe("b");
  });
});
