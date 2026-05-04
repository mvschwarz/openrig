// Operator Surface Reconciliation v0 — MarkdownViewer raw/rendered toggle tests.
//
// Item 4: header-bar toggle switches between rendered (default;
// MarkdownViewer's normal block render) and raw (monospace pre-rendered
// text + visible Markdown source). Frontmatter metadata header still
// renders in raw mode unless hideFrontmatter is set. hideRawToggle
// prop suppresses the toggle for callers (e.g. PriorityStackPanel)
// that don't want the chrome.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer.js";

afterEach(() => cleanup());

const SAMPLE_MD = `---\nslice: foo\n---\n# Heading\n- list item`;

describe("OSR v0 — MarkdownViewer raw/rendered toggle", () => {
  it("default mode is rendered; toggle buttons present", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    expect(screen.getByTestId("markdown-viewer").getAttribute("data-mode")).toBe("rendered");
    expect(screen.getByTestId("markdown-viewer-mode-rendered").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("markdown-viewer-mode-raw").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("markdown-viewer-rendered")).toBeDefined();
  });

  it("clicking raw toggle switches mode + renders source verbatim", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-raw"));
    expect(screen.getByTestId("markdown-viewer").getAttribute("data-mode")).toBe("raw");
    expect(screen.getByTestId("markdown-viewer-mode-raw").getAttribute("data-active")).toBe("true");
    const raw = screen.getByTestId("markdown-viewer-raw");
    expect(raw.textContent).toContain("# Heading");
    expect(raw.textContent).toContain("- list item");
    expect(screen.queryByTestId("markdown-viewer-rendered")).toBeNull();
  });

  it("frontmatter metadata header still renders in raw mode", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-raw"));
    expect(screen.getByTestId("markdown-frontmatter").textContent).toContain("foo");
  });

  it("hideRawToggle hides the toggle entirely (caller renders only one mode)", () => {
    render(<MarkdownViewer content={SAMPLE_MD} hideRawToggle />);
    expect(screen.queryByTestId("markdown-viewer-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("markdown-viewer-mode-raw")).toBeNull();
  });

  it("toggling back to rendered from raw restores block render", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-raw"));
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-rendered"));
    expect(screen.getByTestId("markdown-viewer").getAttribute("data-mode")).toBe("rendered");
    expect(screen.getByTestId("markdown-viewer-rendered")).toBeDefined();
    expect(screen.queryByTestId("markdown-viewer-raw")).toBeNull();
  });
});
