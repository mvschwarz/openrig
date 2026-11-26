import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sameProjectRoot, selectedProject } from "../src/domain/workspace/project-read.js";

it.runIf(process.platform === "win32")("recognizes one selected project through native case and junction spellings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-read-owned-"));
  const project = path.join(root, "MixedCaseProject"), alias = path.join(root, "alias"), other = path.join(root, "other");
  try {
    fs.mkdirSync(project); fs.mkdirSync(other);
    fs.symlinkSync(project, alias, "junction");
    expect(sameProjectRoot(project, project.toLowerCase())).toBe(true);
    expect(sameProjectRoot(project, alias.toLowerCase())).toBe(true);
    expect(sameProjectRoot(project, other)).toBe(false);
    expect(sameProjectRoot(project, path.join(root, "missing"))).toBe(false);
    fs.writeFileSync(path.join(project, "project.yaml"), "id: owned\n");
    fs.writeFileSync(path.join(project, "SPEC.md"), "# Owned project\n");
    fs.mkdirSync(path.join(project, "missions"));
    const query: Record<string, string> = { project: "owned", projectRoot: alias.toLowerCase() };
    const context = {
      get: () => ({ resolveOne: (key: string) => ({ value: key === "workspace.root" ? project : undefined }) }),
      req: { query: (key: string) => query[key] },
    };
    expect(selectedProject(context)?.id).toBe("owned");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
