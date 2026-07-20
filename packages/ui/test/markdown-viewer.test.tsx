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

// ---------------------------------------------------------------------------
// qitem-render-driver D2 — authored ordered-list numbering + indented
// continuations. Roots (MarkdownViewer.tsx): the parser captures indent+text
// but DISCARDS the numeric value (:167-172), and the renderer emits
// <ol class="list-decimal"> with no start=/value= (:302-312), so CSS
// renumbers from 1. The list collector (:168) only continues on lines that
// themselves start with a marker, so a hanging-indent continuation exits the
// list and becomes a separate paragraph (:199-209).
//
// The ordinal fixture is deliberately NON-CONSECUTIVE (3. then 5.): an
// <ol start="3"> only fix renders 3,4 and MUST still fail here.
// ---------------------------------------------------------------------------

describe("qitem-render-driver D2 — authored ordinals + continuation containment", () => {
  it("RED: non-consecutive authored ordinals 3. and 5. both survive (start=3 alone renders 3,4 and must fail)", () => {
    const { container } = render(<MarkdownViewer content={"3. three\n5. five"} hideFrontmatter hideRawToggle />);
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(2);
    // Ordinal semantics, however the fix carries them (per-item value= or an
    // equivalent explicit number) — read back as the effective ordinals.
    const ordinals = items.map((li) => {
      const v = li.getAttribute("value");
      if (v) return Number(v);
      const ol = li.closest("ol");
      const start = ol?.getAttribute("start");
      const idx = ol ? Array.from(ol.children).indexOf(li) : 0;
      return start ? Number(start) + idx : idx + 1;
    });
    expect(ordinals, "authored 3. and 5. must both render as authored").toEqual([3, 5]);
  });

  it("RED: an indented continuation stays INSIDE its list item (no detached sibling paragraph)", () => {
    const { container } = render(<MarkdownViewer content={"1. item\n    continued here"} hideFrontmatter hideRawToggle />);
    const items = Array.from(container.querySelectorAll("li"));
    expect(items, "the continuation must not open a second item").toHaveLength(1);
    expect(items[0]!.textContent, "one li holds marker text AND its continuation").toContain("item");
    expect(items[0]!.textContent, "one li holds marker text AND its continuation").toContain("continued here");
    const strayParagraph = Array.from(container.querySelectorAll("p")).some((p) => (p.textContent ?? "").includes("continued here"));
    expect(strayParagraph, "no sibling <p> may carry the continuation").toBe(false);
  });

  // Preservation pins — must stay GREEN. Per guard: assert no throw / no
  // silent drop rather than freezing an incorrect DOM numbering model.
  it("GREEN pin: bullets, nesting, and mixed ordered+unordered render without throw or content loss", () => {
    const mixed = "- alpha\n  - nested-alpha\n1. one\n- beta";
    const { container } = render(<MarkdownViewer content={mixed} hideFrontmatter hideRawToggle />);
    const text = container.textContent ?? "";
    for (const token of ["alpha", "nested-alpha", "one", "beta"]) {
      expect(text, `mixed list content must not be dropped: ${token}`).toContain(token);
    }
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(4);
  });

  it("GREEN pin: malformed/ragged list input degrades without throwing and keeps its text", () => {
    // NOTE: a BARE marker line ("- " / "1. ") is deliberately EXCLUDED here —
    // it triggers a parser infinite loop (MarkdownViewer.tsx:164-176 breaks
    // without advancing i), which OOMs the runner. That hang is reported as a
    // separate tracked defect with its own bounded RED, so this pin stays
    // focused on ragged-but-terminating input.
    const ragged = "1.\n   \n2. real item\nplain trailing prose";
    const { container } = render(<MarkdownViewer content={ragged} hideFrontmatter hideRawToggle />);
    const text = container.textContent ?? "";
    expect(text).toContain("real item");
    expect(text).toContain("plain trailing prose");
  });
});

// ---------------------------------------------------------------------------
// qitem-markdown-bare-marker-loop (CRITICAL) — the parser must TERMINATE on a
// bare list marker.
//
// Root (MarkdownViewer.tsx:164-176): the outer guard recognizes a list line by
// `/^\s*([-*]|\d+\.)\s+/` (marker + whitespace) while the inner capture
// additionally demands text via `/^(\s*)([-*]|\d+\.)\s+(.+)$/`. A line that is
// marker+whitespace with NO text — a trailing "- " or "1. ", plausible in any
// authored README/PRD — satisfies the outer guard, fails the inner match, and
// hits `if (!m) break;` WITHOUT advancing `i`. The outer loop re-reads the
// same line forever: a pinned CPU and heap exhaustion (browser-tab hang).
//
// SAFETY: the render runs in an ISOLATED child (its own low heap cap + hard
// timeout/kill), never in this Vitest worker — a direct render here would hang
// or OOM CI instead of failing. Pre-fix the child times out or exits nonzero;
// post-fix it must exit 0 within the bound AND show visible degradation.
// ---------------------------------------------------------------------------

describe("qitem-markdown-bare-marker-loop — parser terminates on a bare list marker", () => {
  it("RED: an isolated render of a bare-marker document terminates within the bound and degrades visibly", async () => {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const childScript = path.resolve(import.meta.dirname, "fixtures/markdown-bare-marker-child.tsx");
    const runner = path.resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");

    const outcome = await new Promise<{ code: number | null; signal: string | null; killed: boolean; out: string; err: string }>((resolve) => {
      const child = spawn(runner, [childScript], {
        cwd: path.resolve(import.meta.dirname, ".."),
        // Low heap so a runaway parser dies fast instead of eating the box.
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let killed = false;
      // Bounded stdout/stderr so an OOM backtrace cannot balloon memory here.
      const CAP = 8_000;
      child.stdout.on("data", (c: Buffer) => { if (out.length < CAP) out += c.toString("utf8"); });
      child.stderr.on("data", (c: Buffer) => { if (err.length < CAP) err += c.toString("utf8"); });
      const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 5_000);
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed, out, err }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, signal: null, killed, out, err: err + String(e) }); });
    });

    expect(
      outcome.killed,
      `parser must TERMINATE on a bare list marker — child hit the 5s bound (infinite loop). stderr: ${outcome.err.slice(0, 300)}`,
    ).toBe(false);
    // exit 134 / SIGABRT here is V8's OOM abort: the runaway parser exhausted
    // the child's 256MB cap. Surfaced explicitly so the RED reads as the
    // infinite loop it is, not as an opaque nonzero exit.
    expect(
      outcome.code,
      `child must exit 0 (terminated + visible degradation); got code=${outcome.code} signal=${outcome.signal}` +
        `${outcome.code === 134 ? " — V8 OOM abort, i.e. the bare-marker infinite loop" : ""}. stderr: ${outcome.err.slice(0, 300)}`,
    ).toBe(0);
    expect(outcome.out).toContain("TERMINATED_OK");
  }, 20_000);
});
