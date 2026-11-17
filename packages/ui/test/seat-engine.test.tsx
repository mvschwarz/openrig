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

  it("truncates a name too long for the 7px floor and keeps the full id in the title", () => {
    const model = `vendor/${"x".repeat(200)}`;
    render(<SeatEngine runtime="pi" model={model} fitWidthPx={144} />);
    const line = screen.getByTestId("seat-model");
    expect(line.style.fontSize).toBe("7px");
    expect(line.className).toContain("truncate");
    expect(line.getAttribute("title")).toBe(model);
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
    expect(screen.getByTestId("context-bar").getAttribute("data-state")).toBe("fresh");
    rerender(<ContextBar percent={null} availability="unknown" fresh={false} />);
    expect(screen.getByTestId("context-bar").firstElementChild).toBeNull();
  });

  it("draws unknown context as a dashed outline, not as an empty 0% track", () => {
    render(<ContextBar percent={null} availability="unknown" fresh={false} />);
    const bar = screen.getByTestId("context-bar");
    expect(bar.getAttribute("data-state")).toBe("unknown");
    expect(bar.className).toContain("border-dashed");
    expect(bar.getAttribute("title")).toBe("Context usage unknown");
  });

  it("dims a stale sample so it reads differently from a current one", () => {
    render(<ContextBar percent={40} availability="known" fresh={false} />);
    const bar = screen.getByTestId("context-bar");
    expect(bar.getAttribute("data-state")).toBe("stale");
    expect((bar.firstElementChild as HTMLElement).className).toContain("opacity-50");
  });

  it("names a community harness runtime instead of saying Unknown", () => {
    render(<SeatEngine runtime="opencode" model="zai/glm-5.3" />);
    expect(screen.getByText("opencode")).toBeTruthy();
    expect(screen.queryByText("Unknown")).toBeNull();
    expect(screen.getByRole("img", { name: "opencode" })).toBeTruthy();
  });
});
