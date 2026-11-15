import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContextBar, SeatEngine, fitModelFontSize, splitModelId } from "../src/components/SeatEngine.js";

afterEach(() => cleanup());

describe("seat card engine block", () => {
  it("splits a provider model id into provider and last segment", () => {
    expect(splitModelId("zai/glm-5.3")).toEqual({ provider: "zai", name: "glm-5.3" });
    expect(splitModelId("nvidia/google/gemma-4-31b-it")).toEqual({ provider: "nvidia", name: "gemma-4-31b-it" });
    expect(splitModelId("claude-opus-5-5")).toEqual({ provider: null, name: "claude-opus-5-5" });
    expect(splitModelId(null)).toEqual({ provider: null, name: null });
  });

  it("keeps short model names at 10px and shrinks long ones to fit, never below 7px", () => {
    expect(fitModelFontSize("glm-5.3", 144)).toBe(10);
    const size = fitModelFontSize("nemotron-3.5-super-vl-120b-a12b", 144);
    expect(size).toBeLessThan(10);
    expect(size * 0.6 * "nemotron-3.5-super-vl-120b-a12b".length).toBeLessThanOrEqual(144);
    expect(fitModelFontSize("x".repeat(200), 144)).toBe(7);
  });

  it("shows the runtime, the provider and the model on separate elements", () => {
    render(<SeatEngine runtime="pi" model="nvidia/nemotron-3-ultra-550b-a55b" />);
    expect(screen.getByText("Pi")).toBeTruthy();
    expect(screen.getByTestId("seat-provider").textContent).toBe("nvidia");
    expect(screen.getByTestId("seat-model").textContent).toBe("nemotron-3-ultra-550b-a55b");
    expect(screen.getByTestId("seat-model").getAttribute("title")).toBe("nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("shows no provider for a bare model id", () => {
    render(<SeatEngine runtime="claude-code" model="claude-opus-5-5" />);
    expect(screen.queryByTestId("seat-provider")).toBeNull();
    expect(screen.getByTestId("seat-model").textContent).toBe("claude-opus-5-5");
  });

  it("says a terminal node has no agent instead of leaving the model line empty", () => {
    render(<SeatEngine runtime="terminal" model={null} />);
    expect(screen.getByTestId("seat-model").textContent).toBe("shell · no agent");
  });

  it("fills the context bar only when the context usage is known", () => {
    const { rerender } = render(<ContextBar percent={64} availability="known" fresh />);
    const fill = screen.getByTestId("context-bar").firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("64%");
    expect(fill.className).toContain("bg-amber-600");
    rerender(<ContextBar percent={null} availability="unknown" fresh={false} />);
    expect(screen.getByTestId("context-bar").firstElementChild).toBeNull();
  });
});
