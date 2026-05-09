import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ActorMark, RuntimeBadge, RuntimeMark, ToolMark, isHumanActor } from "../src/components/graphics/RuntimeMark.js";
import { normalizeRuntimeBrandId, runtimeBrand } from "../src/lib/runtime-brand.js";
import { normalizeToolBrandId, toolBrand } from "../src/lib/tool-brand.js";

afterEach(() => cleanup());

describe("graphics runtime package", () => {
  it("normalizes runtime brands to human-facing labels", () => {
    expect(normalizeRuntimeBrandId("claude-code")).toBe("claude-code");
    expect(runtimeBrand("claude-code").label).toBe("Claude");
    expect(normalizeRuntimeBrandId("codex")).toBe("codex");
    expect(runtimeBrand("codex").label).toBe("Codex");
  });

  it("normalizes tool brands for CMUX, tmux, VS Code, and screenshots", () => {
    expect(normalizeToolBrandId("cmux")).toBe("cmux");
    expect(normalizeToolBrandId("tmux attach")).toBe("tmux");
    expect(normalizeToolBrandId("Visual Studio Code")).toBe("vscode");
    expect(normalizeToolBrandId("proof-image.png")).toBe("screenshot");
    expect(normalizeToolBrandId("SKILL.md")).toBe("skill");
    expect(normalizeToolBrandId("README.md")).toBe("markdown");
    expect(normalizeToolBrandId("config.yaml")).toBe("config");
    expect(normalizeToolBrandId("src/App.tsx")).toBe("code");
    expect(normalizeToolBrandId("capture.log")).toBe("transcript");
    expect(normalizeToolBrandId("trace.zip")).toBe("trace");
    expect(toolBrand("cmux").actionLabel).toBe("Open in CMUX");
    expect(toolBrand("proof").label).toBe("Proof");
  });

  it("renders compact runtime badges with graphics and short labels", () => {
    render(<RuntimeBadge runtime="claude-code" model="claude-sonnet" compact />);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Claude" })).toBeTruthy();
  });

  it("keeps standalone runtime marks named for icon-only use", () => {
    render(<RuntimeMark runtime="claude-code" />);
    expect(screen.getByRole("img", { name: "Claude" })).toBeTruthy();
  });

  it("renders inline runtime labels without badge chrome", () => {
    const { container } = render(<RuntimeBadge runtime="codex" compact variant="inline" />);
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(container.firstElementChild?.className).not.toContain("border");
    expect(container.firstElementChild?.className).not.toContain("bg-");
  });

  it("renders tool marks as named glyphs", () => {
    render(<ToolMark tool="cmux" title="Open in CMUX" />);
    expect(screen.getByRole("img", { name: "Open in CMUX" })).toBeTruthy();
  });

  it("allows decorative tool marks when visible text already labels the row", () => {
    const { container } = render(<ToolMark tool="SKILL.md" title="SKILL.md" decorative />);
    expect(container.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "SKILL.md" })).toBeNull();
  });

  it("renders artifact marks for proof, markdown, config, code, and traces", () => {
    const { container } = render(
      <div>
        <ToolMark tool="proof" title="Proof packet" />
        <ToolMark tool="README.md" title="README.md" />
        <ToolMark tool="config.yaml" title="config.yaml" />
        <ToolMark tool="App.tsx" title="App.tsx" />
        <ToolMark tool="trace.zip" title="trace.zip" />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Proof packet" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "README.md" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "config.yaml" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "App.tsx" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "trace.zip" })).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBe(5);
  });

  it("renders the human actor mark through the raster mask asset", () => {
    render(<ActorMark actor="human@host" title="human@host" />);
    const mark = screen.getByRole("img", { name: "human@host" });
    expect(mark.getAttribute("style")).toContain("/graphics/operator-climber-monochrome.png");
  });

  it("centralizes human actor detection for author and project chips", () => {
    expect(isHumanActor("human@host")).toBe(true);
    expect(isHumanActor("operator@local")).toBe(true);
    expect(isHumanActor("dev.driver@openrig-build")).toBe(false);
  });

  it("uses a neutral terminal-like mark for non-human session actors without runtime identity", () => {
    render(<ActorMark actor="dev.driver@openrig-build" />);
    expect(screen.getByRole("img", { name: "dev.driver@openrig-build" })).toBeTruthy();
  });

  it("ships the operator mask asset in public graphics", () => {
    const asset = readFileSync(join(process.cwd(), "public/graphics/operator-climber-monochrome.png"));
    expect(asset.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
