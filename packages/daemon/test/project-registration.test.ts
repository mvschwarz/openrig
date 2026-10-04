// A bundle's project is registered in the workspace catalog, with its rig
// associated, without disturbing the user's own projects.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { registerBundleProject } from "../src/domain/workspace/project-registration.js";
import { vendorProjectDir } from "../src/domain/bundle-carried-project.js";
import { readProjectCatalog } from "../src/domain/workspace/project-catalog.js";

const USER_CATALOG = `schema: openrig.workspace/v0alpha1
# My own projects. Keep this comment.
projects:
  - id: myapp
    root: ../code/myapp # the app I work on
`;

describe("registerBundleProject", () => {
  let work: string;
  let workspace: string;
  let catalogPath: string;
  let projectsRoot: string;
  let bundleProject: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "project-registration-"));
    workspace = path.join(work, "workspace");
    catalogPath = path.join(workspace, "workspace.yaml");
    projectsRoot = path.join(workspace, "projects");
    bundleProject = path.join(work, "bundle", "project");
    fs.mkdirSync(bundleProject, { recursive: true });
    fs.writeFileSync(path.join(bundleProject, "project.yaml"), "schema: openrig.project/v0alpha1\nid: openrig\n");
    fs.writeFileSync(path.join(bundleProject, "SPEC.md"), "# Contributing to OpenRig\n");
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function register(rigName = "openrig-dev") {
    return registerBundleProject({ bundleProjectDir: bundleProject, projectId: "openrig", rigName, projectsRoot, catalogPath, workspaceRoot: workspace });
  }

  function entries() {
    return (parseYaml(fs.readFileSync(catalogPath, "utf-8")) as { projects: Array<Record<string, unknown>> }).projects;
  }

  it("beside a user's project: adds the bundle's entry and leaves the user's entry and comments as they were", () => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(catalogPath, USER_CATALOG);

    const result = register();

    expect(result).toMatchObject({ status: "registered", projectId: "openrig", rigName: "openrig-dev" });
    const text = fs.readFileSync(catalogPath, "utf-8");
    expect(text.startsWith(USER_CATALOG.trimEnd())).toBe(true);
    expect(entries()).toEqual([
      { id: "myapp", root: "../code/myapp" },
      { id: "openrig", root: "projects/openrig", rigs: ["openrig-dev"] },
    ]);
    expect(fs.readFileSync(path.join(projectsRoot, "openrig", "SPEC.md"), "utf-8")).toBe("# Contributing to OpenRig\n");
  });

  it("replaces the catalog in one step, leaving no temporary file beside it", () => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(catalogPath, USER_CATALOG);
    register();
    register("openrig-dev-pi");
    expect(fs.readdirSync(workspace).filter((name) => name.startsWith("workspace.yaml"))).toEqual(["workspace.yaml"]);
  });

  it("the existing catalog reader still reads the catalog, ignoring the rigs list", () => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(catalogPath, USER_CATALOG);
    register();
    expect(readProjectCatalog(catalogPath)).toEqual([
      { id: "myapp", root: "../code/myapp" },
      { id: "openrig", root: "projects/openrig" },
    ]);
  });

  it("reinstalling the same bundle changes nothing", () => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(catalogPath, USER_CATALOG);
    register();
    const after = fs.readFileSync(catalogPath, "utf-8");

    expect(register().status).toBe("already_registered");
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(after);
  });

  it("a second rig joins the existing entry by a one-line edit", () => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(catalogPath, USER_CATALOG);
    register();
    const before = fs.readFileSync(catalogPath, "utf-8");

    expect(register("openrig-dev-pi").status).toBe("associated");
    expect(entries()[1]).toEqual({ id: "openrig", root: "projects/openrig", rigs: ["openrig-dev", "openrig-dev-pi"] });
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(before.replace("rigs: [openrig-dev]", "rigs: [openrig-dev, openrig-dev-pi]"));
  });

  it("keeps a CRLF catalog's bytes and appends in its line endings", () => {
    fs.mkdirSync(workspace, { recursive: true });
    const crlf = USER_CATALOG.replace(/\n/g, "\r\n");
    fs.writeFileSync(catalogPath, crlf);

    expect(register().status).toBe("registered");
    const text = fs.readFileSync(catalogPath, "utf-8");
    expect(text.startsWith(crlf)).toBe(true);
    expect(text.slice(crlf.length)).toBe("  - id: openrig\r\n    root: projects/openrig\r\n    rigs: [openrig-dev]\r\n");
  });

  it("keeps a 4-space catalog's bytes and appends in its indentation", () => {
    fs.mkdirSync(workspace, { recursive: true });
    const wide = "schema: openrig.workspace/v0alpha1\nprojects:\n    -   id: myapp\n        root: ../code/myapp   # mine\n";
    fs.writeFileSync(catalogPath, wide);

    expect(register().status).toBe("registered");
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(`${wide}    -   id: openrig\n        root: projects/openrig\n        rigs: [openrig-dev]\n`);
  });

  it("does not rewrite a flow-style catalog: nothing is written, and the entry to add is given", () => {
    fs.mkdirSync(workspace, { recursive: true });
    const flow = "schema: openrig.workspace/v0alpha1\nprojects: [{id: myapp, root: ../code/myapp}]\n";
    fs.writeFileSync(catalogPath, flow);

    const result = register();

    expect(result.status).toBe("conflict");
    expect(result.detail).toMatch(/by hand: \{ id: openrig, root: projects\/openrig, rigs: \[openrig-dev\] \}/);
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(flow);
  });

  it("the same folder registered under another id is a conflict, and the catalog is untouched", () => {
    fs.mkdirSync(path.join(projectsRoot, "openrig"), { recursive: true });
    const catalog = `${USER_CATALOG}  - id: oss\n    root: projects/openrig\n`;
    fs.writeFileSync(catalogPath, catalog);

    const result = register();

    expect(result.status).toBe("conflict");
    expect(result.detail).toMatch(/already registered .* as project 'oss', but its project.yaml says 'openrig'/);
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(catalog);
  });

  it("with no catalog outside the workspace root, the default entry still points at the workspace root", () => {
    const outside = path.join(work, "config", "workspace.yaml");
    const result = registerBundleProject({ bundleProjectDir: bundleProject, projectId: "openrig", rigName: "openrig-dev", projectsRoot, catalogPath: outside, workspaceRoot: workspace });

    expect(result.status).toBe("registered");
    const catalog = parseYaml(fs.readFileSync(outside, "utf-8")) as { projects: Array<{ id: string; root: string }> };
    expect(path.resolve(path.dirname(outside), catalog.projects[0]!.root)).toBe(workspace);
    expect(path.resolve(path.dirname(outside), catalog.projects[1]!.root)).toBe(path.join(projectsRoot, "openrig"));
  });

  it("the id taken by a different root is a conflict, and the catalog is untouched", () => {
    fs.mkdirSync(workspace, { recursive: true });
    const catalog = `${USER_CATALOG}  - id: openrig\n    root: ../code/openrig-fork\n`;
    fs.writeFileSync(catalogPath, catalog);

    const result = register();

    expect(result.status).toBe("conflict");
    expect(result.detail).toMatch(/already registered .* different root/);
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(catalog);
  });

  it("a rig already associated with another project is a conflict, and the catalog is untouched", () => {
    fs.mkdirSync(workspace, { recursive: true });
    const catalog = `schema: openrig.workspace/v0alpha1\nprojects:\n  - id: myapp\n    root: ../code/myapp\n    rigs: [openrig-dev]\n`;
    fs.writeFileSync(catalogPath, catalog);

    const result = register();

    expect(result.status).toBe("conflict");
    expect(result.detail).toMatch(/already associated with project 'myapp'/);
    expect(fs.readFileSync(catalogPath, "utf-8")).toBe(catalog);
  });

  it("with no catalog, writes one that keeps the workspace's own default project beside the bundle's", () => {
    const result = register();

    expect(result.status).toBe("registered");
    expect(entries()).toEqual([
      { id: "default", root: "." },
      { id: "openrig", root: "projects/openrig", rigs: ["openrig-dev"] },
    ]);
  });

  it("keeps an existing, different project folder and says so", () => {
    fs.mkdirSync(path.join(projectsRoot, "openrig"), { recursive: true });
    fs.writeFileSync(path.join(projectsRoot, "openrig", "SPEC.md"), "# My edited intent\n");

    const result = register();

    expect(result).toMatchObject({ status: "registered", projectFolderKept: true });
    expect(fs.readFileSync(path.join(projectsRoot, "openrig", "SPEC.md"), "utf-8")).toBe("# My edited intent\n");
  });
});

describe("vendorProjectDir", () => {
  let work: string;
  let projectDir: string;
  let staging: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "carried-project-"));
    projectDir = path.join(work, "project");
    staging = path.join(work, "staging");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(projectDir, "project.yaml"), "schema: openrig.project/v0alpha1\nid: openrig\n");
    fs.writeFileSync(path.join(projectDir, "SPEC.md"), "# Contributing\n");
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("carries project.yaml and its files under project/ and returns the id", () => {
    expect(vendorProjectDir(projectDir, staging)).toEqual({ id: "openrig", path: "project" });
    expect(fs.readdirSync(path.join(staging, "project")).sort()).toEqual(["SPEC.md", "project.yaml"]);
  });

  it("needs an id in project.yaml", () => {
    fs.writeFileSync(path.join(projectDir, "project.yaml"), "schema: openrig.project/v0alpha1\n");
    expect(() => vendorProjectDir(projectDir, staging)).toThrow(/declares no id/);
  });

  it("refuses a file that resolves outside the project folder", () => {
    fs.writeFileSync(path.join(work, "secret.md"), "outside\n");
    fs.symlinkSync(path.join(work, "secret.md"), path.join(projectDir, "notes.md"));
    expect(() => vendorProjectDir(projectDir, staging)).toThrow(/resolves outside the project directory/);
  });
});
