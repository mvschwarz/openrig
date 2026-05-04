// UI Enhancement Pack v0 — MarkdownViewer focused tests.
//
// Pins the load-bearing rendering primitives so future refactors of
// the inline parser (e.g., swapping in a marked / react-markdown lib
// later) preserve operator-visible behavior.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer.js";

afterEach(() => cleanup());

describe("UI Enhancement Pack v0 — MarkdownViewer", () => {
  it("renders YAML frontmatter as a metadata header above the body", () => {
    const md = `---\nslice: my-slice\nstatus: active\n---\n# Title\nbody text`;
    render(<MarkdownViewer content={md} />);
    const fm = screen.getByTestId("markdown-frontmatter");
    expect(fm.textContent).toContain("slice");
    expect(fm.textContent).toContain("my-slice");
    expect(fm.textContent).toContain("status");
    expect(fm.textContent).toContain("active");
  });

  it("hides frontmatter when hideFrontmatter prop is true", () => {
    const md = `---\nslice: x\n---\n# Title`;
    render(<MarkdownViewer content={md} hideFrontmatter />);
    expect(screen.queryByTestId("markdown-frontmatter")).toBeNull();
  });

  it("renders headings with proper levels (# / ## / ### / ####)", () => {
    const md = `# H1\n\n## H2\n\n### H3\n\n#### H4`;
    render(<MarkdownViewer content={md} />);
    expect(screen.getByTestId("md-heading-1").textContent).toBe("H1");
    expect(screen.getByTestId("md-heading-2").textContent).toBe("H2");
    expect(screen.getByTestId("md-heading-3").textContent).toBe("H3");
    expect(screen.getByTestId("md-heading-4").textContent).toBe("H4");
  });

  it("renders bullet lists with depth from indentation", () => {
    const md = `- top-level\n  - nested-1\n    - nested-2`;
    render(<MarkdownViewer content={md} />);
    const list = screen.getByTestId("md-list-ul");
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(3);
  });

  it("renders ordered lists", () => {
    const md = `1. first\n2. second`;
    render(<MarkdownViewer content={md} />);
    expect(screen.getByTestId("md-list-ol").querySelectorAll("li")).toHaveLength(2);
  });

  it("renders fenced code blocks with the SyntaxHighlight component (per language)", () => {
    const md = "```ts\nconst x = 1;\n```";
    render(<MarkdownViewer content={md} />);
    const block = screen.getByTestId("syntax-highlight-block");
    expect(block.getAttribute("data-language")).toBe("ts");
    expect(block.textContent).toContain("const");
    expect(block.textContent).toContain("x");
  });

  it("renders mermaid code blocks as a placeholder per item 2 carve-out (no library bundled at v0)", () => {
    const md = "```mermaid\ngraph TD\n  A-->B\n```";
    render(<MarkdownViewer content={md} />);
    const placeholder = screen.getByTestId("md-mermaid-placeholder");
    expect(placeholder.textContent).toContain("mermaid");
    const btn = screen.getByTestId("md-mermaid-render-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("renders inline code with `...` syntax", () => {
    const md = `paragraph with \`inline code\` here`;
    render(<MarkdownViewer content={md} />);
    expect(screen.getByTestId("md-inline-code").textContent).toBe("inline code");
  });

  it("renders inline links with [text](url)", () => {
    const md = `see [the docs](https://example.com/docs)`;
    render(<MarkdownViewer content={md} />);
    const link = screen.getByTestId("md-inline-link") as HTMLAnchorElement;
    expect(link.textContent).toBe("the docs");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("renders inline images with relative src resolved against assetBasePath", () => {
    const md = `![diagram](shots/foo.png)`;
    render(<MarkdownViewer content={md} assetBasePath="/api/files/asset?root=ws&path=docs" />);
    const img = screen.getByTestId("md-inline-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/files/asset?root=ws&path=docs/shots/foo.png");
  });

  it("absolute URLs in image src pass through unchanged", () => {
    const md = `![remote](https://example.com/img.png)`;
    render(<MarkdownViewer content={md} assetBasePath="/api/files/asset?root=ws" />);
    const img = screen.getByTestId("md-inline-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://example.com/img.png");
  });

  it("renders tables with header + body rows", () => {
    const md = `| col-a | col-b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |`;
    render(<MarkdownViewer content={md} />);
    const wrapper = screen.getByTestId("md-table-wrapper");
    const headers = wrapper.querySelectorAll("thead th");
    expect(headers).toHaveLength(2);
    const bodyRows = wrapper.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(2);
  });

  it("renders bold (**) and italic (*) inline emphasis", () => {
    const md = `paragraph with **bold** and *italic* text`;
    render(<MarkdownViewer content={md} />);
    const para = screen.getByTestId("md-paragraph");
    expect(para.querySelector("strong")?.textContent).toBe("bold");
    expect(para.querySelector("em")?.textContent).toBe("italic");
  });
});
