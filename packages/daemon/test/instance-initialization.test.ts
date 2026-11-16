import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ensureOpenRigInstance,
  openRigContextLibraryRoots,
} from "../src/domain/instance-initialization.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openrig-instance-init-"));
  roots.push(root);
  return root;
}

function tree(root: string): Array<{ path: string; kind: "directory" | "file"; content?: string }> {
  const out: Array<{ path: string; kind: "directory" | "file"; content?: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (statSync(abs).isDirectory()) {
        out.push({ path: rel, kind: "directory" });
        walk(abs);
      } else {
        out.push({ path: rel, kind: "file", content: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical OpenRig instance initialization", () => {
  it("declares the canonical addressable and System World library roots together", () => {
    expect(openRigContextLibraryRoots("/instance/context")).toEqual([
      "/instance/context",
      "/instance/context/system",
    ]);
  });

  it("creates the canonical roots plus the S01 workspace through one idempotent owner", () => {
    const parent = freshRoot();
    const home = join(parent, "home");

    const first = ensureOpenRigInstance({ home });
    const firstTree = tree(home);
    const second = ensureOpenRigInstance({ home });

    expect(first.ok).toBe(true);
    expect(first.createdPaths.length).toBeGreaterThan(0);
    expect(second).toMatchObject({ ok: true, createdPaths: [], conflicts: [] });
    expect(tree(home)).toEqual(firstTree);
    expect(firstTree).toEqual(expect.arrayContaining([
      { path: "config.json", kind: "file", content: "{}\n" },
      { path: "state", kind: "directory" },
      { path: "context", kind: "directory" },
      { path: "context/system", kind: "directory" },
      { path: "context/system/system-world.yaml", kind: "file", content: expect.stringContaining("schema: openrig.system-world/v0alpha1") },
      { path: "skills", kind: "directory" },
      { path: "workspace", kind: "directory" },
      { path: "workspace/missions", kind: "directory" },
      { path: "workspace/exhaust", kind: "directory" },
      { path: "specs", kind: "directory" },
      { path: "topology", kind: "directory" },
      { path: "plugins", kind: "directory" },
      { path: "run", kind: "directory" },
      { path: "logs", kind: "directory" },
      { path: "transcripts", kind: "directory" },
      { path: "backups", kind: "directory" },
      { path: "secrets", kind: "directory" },
    ]));
  });

  it("preserves user-owned files byte-for-byte", () => {
    const home = join(freshRoot(), "home");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "config.json"), "{\"operator\":true}\n");
    writeFileSync(join(home, "workspace", "SPEC.md"), "# Mine\n");

    const result = ensureOpenRigInstance({ home });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{\"operator\":true}\n");
    expect(readFileSync(join(home, "workspace", "SPEC.md"), "utf8")).toBe("# Mine\n");
  });

  // The lost-host exercise: a restored config sets workspace.root to the person's own project folder. A catalog written
  // there would name it `default` against its project.yaml id (work-install then refuses project_identity_conflict).
  it("leaves a workspace.root that already holds a project of its own as it is, and says so", () => {
    const home = join(freshRoot(), "home");
    const project = join(freshRoot(), "customer-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "project.yaml"), "id: losthost-check\n");
    writeFileSync(join(project, "exhaust"), "a file of the project's own, where the scaffold would put a folder\n");
    const before = readdirSync(project).sort();

    const result = ensureOpenRigInstance({ home, workspaceRoot: project });

    expect(result.ok).toBe(true);
    expect(result.workspaceExistingProject).toBe(join(project, "project.yaml"));
    expect(readdirSync(project).sort()).toEqual(before);
    expect(readFileSync(join(project, "project.yaml"), "utf8")).toBe("id: losthost-check\n");
    expect(result.createdPaths.filter((path) => path.startsWith(project))).toEqual([]);
  });

  it("still completes its own workspace, which has a workspace.yaml beside its project.yaml", () => {
    const home = join(freshRoot(), "home");
    expect(ensureOpenRigInstance({ home }).ok).toBe(true);
    rmSync(join(home, "workspace", "exhaust"), { recursive: true });

    const again = ensureOpenRigInstance({ home });

    expect(again.workspaceExistingProject).toBeUndefined();
    expect(statSync(join(home, "workspace", "exhaust")).isDirectory()).toBe(true);
  });

  // 0.5.7 and 0.5.8 wrote SPEC.md and a project.yaml with no id, and no catalog (it came in 0.5.9); a first scaffold
  // stopped between its writes leaves the same shape. Neither declares an id of its own, so it's completed as `default`.
  it("completes a workspace whose project.yaml declares no id, as 0.5.8 left it, with the default catalog", () => {
    const home = join(freshRoot(), "home");
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "project.yaml"), "schema: openrig.project/v0alpha1\nkind: project\nmissions:\n  root: missions\n");
    writeFileSync(join(workspace, "SPEC.md"), "# Project\n");

    const result = ensureOpenRigInstance({ home });

    expect(result.ok).toBe(true);
    expect(result.workspaceExistingProject).toBeUndefined();
    expect(readFileSync(join(workspace, "workspace.yaml"), "utf8")).toContain("- id: default");
    expect(statSync(join(workspace, "exhaust")).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, "SPEC.md"), "utf8")).toBe("# Project\n");
  });

  it("reports exact type conflicts and performs no partial writes", () => {
    const home = join(freshRoot(), "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "context"), "owned file\n");

    const result = ensureOpenRigInstance({ home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([
      { path: join(home, "context"), expected: "directory", actual: "file" },
    ]);
    expect(existsSync(join(home, "state"))).toBe(false);
    expect(readFileSync(join(home, "context"), "utf8")).toBe("owned file\n");
  });

  it("treats a user-owned symlink as a conflict instead of writing through it", () => {
    const parent = freshRoot();
    const home = join(parent, "home");
    const outside = join(parent, "outside");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(home, "context"));

    const result = ensureOpenRigInstance({ home });

    expect(result.conflicts).toContainEqual({
      path: join(home, "context"),
      expected: "directory",
      actual: "other",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(home, "state"))).toBe(false);
  });
});
