// Project-root depth measurement in inferCatalogProject's working-directory step.
//
// Defect class: a project root's depth was measured as `root.split(path.sep).length`,
// which counts the trailing empty segment that only the filesystem root produces.
// `"/"` and `"/a"` both measured 2, so a catalog declaring `/` beside `/a` reported a
// tie from a working folder inside `/a` and stopped with project_required, contradicting
// the documented "deepest declared root that contains the working directory" rule.
//
// These are POSIX paths on purpose: the repo targets macOS and Linux only, and the
// case under test (`/` as a declared root) cannot be built from a real temp directory.
// The filesystem is mocked rather than created, so the test never depends on the
// machine's real top-level layout.

import { describe, it, expect, vi } from "vitest";

// The established hoisted node:fs importOriginal passthrough (same shape as
// slice-indexer.test.ts): every export stays real, and only the three calls this
// code path makes are answered for the fake paths below.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fake = (p: unknown) => {
    const s = String(p);
    return s === "/" || s === "/ws" || s.startsWith("/ws/") || s === "/a" || s.startsWith("/a/");
  };
  return {
    ...actual,
    existsSync: (p: fs.PathLike) => (fake(p) ? true : actual.existsSync(p)),
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      String(p) === CATALOG ? catalogYaml : (actual.readFileSync as any)(p, ...rest)) as typeof actual.readFileSync,
    realpathSync: Object.assign(
      (p: unknown, ...rest: unknown[]) => (fake(p) ? String(p) : (actual.realpathSync as any)(p, ...rest)),
      { native: actual.realpathSync.native },
    ) as typeof actual.realpathSync,
  };
});
import type * as fs from "node:fs";
import { inferCatalogProject, ProjectReadError } from "../src/domain/workspace/project-catalog.js";

const CATALOG = "/ws/workspace.yaml";
let catalogYaml = "";

/** Roots are absolute, so path.resolve against the catalog's directory returns them untouched. */
function catalog(...projects: Array<{ id: string; root: string }>): void {
  catalogYaml = `projects:\n${projects.map((p) => `  - id: ${p.id}\n    root: ${p.root}\n`).join("")}`;
}
function infer(cwd: string, warnings: string[] = []) {
  const required = new ProjectReadError("project_required", "multiple projects are declared; select one with --project");
  return inferCatalogProject(CATALOG, required, { cwd }, warnings);
}

describe("inferCatalogProject working-directory depth", () => {
  it("prefers a nested root over the filesystem root", () => {
    catalog({ id: "root", root: "/" }, { id: "alpha", root: "/a" });
    expect(infer("/a/b")).toEqual({ id: "alpha", root: "/a", selectedBy: "cwd" });
  });

  it("still reports a tie when two projects share the deepest root", () => {
    catalog({ id: "alpha", root: "/a" }, { id: "alpha-again", root: "/a" });
    try {
      infer("/a/b");
      expect.unreachable("expected project_required");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectReadError);
      expect((err as ProjectReadError).code).toBe("project_required");
      expect((err as ProjectReadError).candidates).toEqual(["alpha", "alpha-again"]);
    }
  });

  it("keeps ordering among nested roots, deepest first", () => {
    catalog({ id: "alpha", root: "/a" }, { id: "beta", root: "/a/b" });
    expect(infer("/a/b/c")).toEqual({ id: "beta", root: "/a/b", selectedBy: "cwd" });
  });
});
