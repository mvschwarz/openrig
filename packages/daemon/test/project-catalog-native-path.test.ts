import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { inferCatalogProject, ProjectReadError, selectCatalogProject } from "../src/domain/workspace/project-catalog.js";

it.runIf(process.platform === "win32")("infers a catalog project from its expanded native working directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-native-"));
  try {
    const alpha = path.join(root, "alpha"), beta = path.join(root, "beta");
    fs.mkdirSync(path.join(alpha, "nested"), { recursive: true }); fs.mkdirSync(beta);
    const catalog = path.join(root, "workspace.yaml");
    fs.writeFileSync(catalog, "projects:\n  - id: alpha\n    root: alpha\n  - id: beta\n    root: beta\n");
    const required = new ProjectReadError("project_required", "choose a project");
    const result = inferCatalogProject(catalog, required, { cwd: fs.realpathSync.native(path.join(alpha, "nested")) }, []);
    expect(result.id).toBe("alpha"); expect(result.selectedBy).toBe("cwd");
    expect(fs.realpathSync.native(result.root)).toBe(fs.realpathSync.native(alpha));
    expect(fs.realpathSync.native(selectCatalogProject(catalog, "beta")!.root)).toBe(fs.realpathSync.native(beta));
    fs.writeFileSync(catalog, "projects:\n  - id: alpha\n    root: alpha\n  - id: same-root\n    root: alpha\n");
    try {
      inferCatalogProject(catalog, required, { cwd: fs.realpathSync.native(alpha) }, []);
      expect.unreachable("same-root projects must remain ambiguous");
    } catch (error) { expect(error).toMatchObject({ code: "project_required", candidates: ["alpha", "same-root"] }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
