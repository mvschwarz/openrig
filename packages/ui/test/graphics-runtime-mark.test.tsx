import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActorMark, RuntimeBadge, ToolMark } from "../src/components/graphics/RuntimeMark.js";
import { normalizeRuntimeBrandId, runtimeBrand } from "../src/lib/runtime-brand.js";
import { normalizeToolBrandId, toolBrand } from "../src/lib/tool-brand.js";

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
    expect(toolBrand("cmux").actionLabel).toBe("Open in CMUX");
  });

  it("renders compact runtime badges with graphics and short labels", () => {
    render(<RuntimeBadge runtime="claude-code" model="claude-sonnet" compact />);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Claude" })).toBeTruthy();
  });

  it("renders tool marks as named glyphs", () => {
    render(<ToolMark tool="cmux" title="Open in CMUX" />);
    expect(screen.getByRole("img", { name: "Open in CMUX" })).toBeTruthy();
  });

  it("renders the human actor mark through the raster mask asset", () => {
    render(<ActorMark actor="human@host" title="human@host" />);
    const mark = screen.getByRole("img", { name: "human@host" });
    expect(mark.getAttribute("style")).toContain("/graphics/operator-climber-monochrome.png");
  });

  it("ships the operator mask asset in public graphics", () => {
    const asset = readFileSync(join(process.cwd(), "public/graphics/operator-climber-monochrome.png"));
    expect(asset.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
