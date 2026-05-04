// PL-007 Workspace Primitive v0 — workspace-resolver tests.
//
// Pins:
//   - resolveWorkspaceContext returns null when no spec
//   - activeRepo from default_repo when present in repos[]
//   - env override wins over default_repo when set
//   - knowledgeKind = "knowledge" when knowledge_root declared
//   - resolveNodeWorkspace longest-prefix wins for cwd containing
//     multiple repo paths
//   - knowledge fallback when cwd is under knowledge_root
//   - falls back to default_repo when cwd is outside repos and knowledge

import { describe, it, expect } from "vitest";
import { resolveWorkspaceContext, resolveNodeWorkspace } from "../src/domain/workspace/workspace-resolver.js";
import type { WorkspaceSpec } from "../src/domain/types.js";

const spec: WorkspaceSpec = {
  workspaceRoot: "/Users/op/hub",
  repos: [
    { name: "main", path: "/Users/op/hub/main", kind: "project" },
    { name: "internal", path: "/Users/op/hub/main/sub", kind: "project" },
    { name: "lab", path: "/Users/op/hub/lab", kind: "lab" },
  ],
  defaultRepo: "main",
  knowledgeRoot: "/Users/op/knowledge",
};

describe("resolveWorkspaceContext (PL-007)", () => {
  it("returns null when spec is null", () => {
    expect(resolveWorkspaceContext({ spec: null, cwd: "/x", envOverride: null })).toBeNull();
  });

  it("returns workspace block with activeRepo from default_repo", () => {
    const r = resolveWorkspaceContext({ spec, cwd: "/Users/op/hub/main", envOverride: null });
    expect(r).not.toBeNull();
    expect(r?.activeRepo).toBe("main");
    expect(r?.workspaceRoot).toBe("/Users/op/hub");
    expect(r?.repos).toHaveLength(3);
    expect(r?.knowledgeRoot).toBe("/Users/op/knowledge");
    expect(r?.knowledgeKind).toBe("knowledge");
  });

  it("env override wins over default_repo", () => {
    const r = resolveWorkspaceContext({ spec, cwd: "/x", envOverride: "internal" });
    expect(r?.activeRepo).toBe("internal");
  });

  it("env override is honored verbatim even when not in repos[]", () => {
    const r = resolveWorkspaceContext({ spec, cwd: "/x", envOverride: "rare-repo" });
    expect(r?.activeRepo).toBe("rare-repo");
  });

  it("knowledgeKind null when knowledge_root absent", () => {
    const noKnowledge: WorkspaceSpec = { ...spec, knowledgeRoot: undefined };
    const r = resolveWorkspaceContext({ spec: noKnowledge, cwd: "/x", envOverride: null });
    expect(r?.knowledgeKind).toBeNull();
    expect(r?.knowledgeRoot).toBeNull();
  });
});

describe("resolveNodeWorkspace (PL-007)", () => {
  it("longest-prefix wins when cwd is under nested repo paths", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/Users/op/hub/main/sub/file.ts" });
    expect(r?.activeRepo).toBe("internal");
    expect(r?.kind).toBe("project");
  });

  it("matches outer repo when cwd is under it but not a nested one", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/Users/op/hub/main/other" });
    expect(r?.activeRepo).toBe("main");
    expect(r?.kind).toBe("project");
  });

  it("returns kind=knowledge when cwd is under knowledge_root", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/Users/op/knowledge/canon" });
    expect(r?.kind).toBe("knowledge");
    // activeRepo falls through to default_repo when cwd doesn't resolve to a repo
    expect(r?.activeRepo).toBe("main");
  });

  it("falls back to default_repo when cwd is outside everything", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/elsewhere" });
    expect(r?.activeRepo).toBe("main");
    expect(r?.kind).toBe("project");
  });

  it("returns null when spec is null", () => {
    expect(resolveNodeWorkspace({ spec: null, cwd: "/x" })).toBeNull();
  });

  it("returns workspaceRoot even when cwd is null", () => {
    const r = resolveNodeWorkspace({ spec, cwd: null });
    expect(r?.workspaceRoot).toBe("/Users/op/hub");
    expect(r?.activeRepo).toBe("main");
  });
});
