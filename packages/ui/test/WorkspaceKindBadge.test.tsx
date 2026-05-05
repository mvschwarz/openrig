// PL-007 Workspace Primitive v0 — WorkspaceKindBadge component test.
//
// Pins:
//   - renders one of 5 typed kinds with label + correct testid
//   - compact mode renders single-character glyph
//   - resolveKindForPath returns longest-prefix match
//   - resolveKindForPath returns "knowledge" when path is under
//     knowledgeRoot only
//   - resolveKindForPath returns null when path is outside everything

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceKindBadge, resolveKindForPath } from "../src/components/WorkspaceKindBadge.js";

describe("WorkspaceKindBadge (PL-007)", () => {
  it("renders the label for each of the 5 kinds", () => {
    for (const k of ["user", "project", "knowledge", "lab", "delivery"] as const) {
      const { unmount } = render(<WorkspaceKindBadge kind={k} />);
      expect(screen.getByTestId(`workspace-kind-badge-${k}`)).toBeTruthy();
      unmount();
    }
  });

  it("compact prop strips to glyph", () => {
    render(<WorkspaceKindBadge kind="knowledge" compact />);
    const el = screen.getByTestId("workspace-kind-badge-knowledge");
    expect(el.textContent).toBe("K");
  });
});

describe("resolveKindForPath (PL-007)", () => {
  const workspace = {
    repos: [
      { name: "main", path: "/r/hub/main", kind: "project" as const },
      { name: "internal", path: "/r/hub/main/sub", kind: "project" as const },
      { name: "lab", path: "/r/hub/lab", kind: "lab" as const },
    ],
    knowledgeRoot: "/r/knowledge",
  };

  it("longest-prefix wins", () => {
    expect(resolveKindForPath("/r/hub/main/sub/file.ts", workspace)).toBe("project");
  });

  it("matches outer when not in nested", () => {
    expect(resolveKindForPath("/r/hub/main/other", workspace)).toBe("project");
  });

  it("kind=knowledge when under knowledgeRoot only", () => {
    expect(resolveKindForPath("/r/knowledge/canon", workspace)).toBe("knowledge");
  });

  it("returns null when outside everything", () => {
    expect(resolveKindForPath("/elsewhere", workspace)).toBeNull();
  });

  it("returns null when workspace is null", () => {
    expect(resolveKindForPath("/r/hub/main", null)).toBeNull();
  });

  it("returns null when path is empty/null", () => {
    expect(resolveKindForPath(null, workspace)).toBeNull();
    expect(resolveKindForPath(undefined, workspace)).toBeNull();
  });
});
