// Slice 20 mobile regression tests.
//
// Three surfaces fixed:
//   (a) FilesWorkspace two-pane shape stacks vertically on narrow
//       viewports (< sm breakpoint) so the document panel claims full
//       width on a phone.
//   (b) AppShell mobile slide-over Rail renders vertical (already
//       covered by app-shell.test.tsx slice-20 cases).
//   (c) Slice Artifacts Docs Browser uses the same responsive two-pane
//       shape; this is the actual rendered path under /project/slice/:id.
//
// (a) is asserted here via source-level scan (the component fetches
// data via hooks; full DOM render would require deep mocking). Source
// scan is sufficient because the responsive shape is a static class
// string — no runtime branch to discriminate. Anchored regex catches
// the pattern. fileURLToPath resolves cwd-independent per banked
// convention so the test runs from repo root + packages/ui cwds.

import { describe, it, expect } from "vitest";

async function readSource(packageRelPath: string): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const nodePath = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const testFile = fileURLToPath(import.meta.url);
  const packageRoot = nodePath.resolve(nodePath.dirname(testFile), "..");
  return readFileSync(nodePath.join(packageRoot, packageRelPath), "utf-8");
}

describe("slice 20: FilesWorkspace responsive two-pane shape", () => {
  it("/files route mounts FilesWorkspace instead of falling through to Not Found", async () => {
    const source = await readSource("src/routes.tsx");
    expect(source).toMatch(/import \{ FilesWorkspace \} from "\.\/components\/files\/FilesWorkspace\.js";/);
    expect(source).toMatch(/path: "\/files",\n\s+component: FilesWorkspace/);
  });

  it("outer container uses flex-col on mobile + sm:flex-row on desktop", async () => {
    const source = await readSource("src/components/files/FilesWorkspace.tsx");
    // The outer flex parent that owns the two-pane shape now stacks
    // vertically by default and swaps to horizontal at sm: width.
    expect(source).toMatch(/flex flex-1 min-h-0 flex-col sm:flex-row/);
  });

  it("file tree pane is full-width on mobile + capped + scrollable; restores w-72 at sm:", async () => {
    const source = await readSource("src/components/files/FilesWorkspace.tsx");
    // Tree pane mobile: w-full + max-h-48 + scrollable; desktop:
    // restores the w-72 fixed-width column + removes the bottom border.
    expect(source).toMatch(/w-full max-h-48 shrink-0 overflow-y-auto/);
    expect(source).toMatch(/sm:w-72/);
    expect(source).toMatch(/sm:max-h-none/);
    // Desktop keeps a right border between tree + content; mobile uses
    // a bottom border instead. Both shapes documented in className.
    expect(source).toMatch(/border-b border-stone-200/);
    expect(source).toMatch(/sm:border-b-0 sm:border-r/);
  });
});

describe("slice 20: DocsTab responsive two-pane shape", () => {
  it("slice Artifacts Docs Browser stacks vertically on mobile + restores row at sm:", async () => {
    const source = await readSource("src/components/slices/tabs/DocsTab.tsx");
    expect(source).toMatch(/className="flex h-full flex-col sm:flex-row"/);
  });

  it("docs tree pane is full-width on mobile + capped + scrollable; restores w-56 at sm:", async () => {
    const source = await readSource("src/components/slices/tabs/DocsTab.tsx");
    expect(source).toMatch(/w-full max-h-48 shrink-0 overflow-y-auto/);
    expect(source).toMatch(/sm:w-56/);
    expect(source).toMatch(/sm:max-h-none/);
    expect(source).toMatch(/border-b border-stone-200/);
    expect(source).toMatch(/sm:border-b-0 sm:border-r/);
  });
});

describe("slice 20: AppShell mobile slide-over hamburger orientation", () => {
  it("Rail invocation inside mobile slide-over uses `vertical` (not vertical={false})", async () => {
    const source = await readSource("src/components/AppShell.tsx");
    // The slide-over rail invocation gates on Rail being passed vertical=true.
    // The prior shape was `vertical={false}`; the new shape is `vertical`
    // (or `vertical={true}`). Match the new shape; absence of the old.
    expect(source).toMatch(/<Rail pathname=\{pathname\} vertical onMobileClose/);
    expect(source).not.toMatch(/<Rail pathname=\{pathname\} vertical=\{false\} onMobileClose/);
  });

  it("Rail icon tap targets are h-11 w-11 on mobile + lg:h-10 lg:w-10 on desktop", async () => {
    const source = await readSource("src/components/AppShell.tsx");
    // Mobile default 44px + desktop lg: override back to 40px. Both
    // tokens must appear on the same className line; the prior global-
    // bump shape (`h-11 w-11 items-center justify-center` with no
    // lg: override) is gone.
    expect(source).toMatch(/h-11 w-11 items-center justify-center transition-colors lg:h-10 lg:w-10/);
    expect(source).not.toMatch(/h-10 w-10 items-center justify-center transition-colors[^l]/);
  });
});
