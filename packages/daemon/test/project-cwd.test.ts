import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { projectCwdReference, resolveAuthoredCwd, resolveLaunchCwd } from "../src/domain/cwd-resolution.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";

describe("registered project cwd", () => {
  let root: string, catalog: string, project: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "project-cwd-"));
    catalog = path.join(root, "workspace.yaml"); project = path.join(root, "$HOME project");
    fs.mkdirSync(project);
    vi.stubEnv("OPENRIG_WORKSPACE_CATALOG_PATH", catalog);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (text: string) => fs.writeFileSync(catalog, text);
  const select = () => write(`projects:\n  - id: demo\n    root: '$HOME project'\n`);
  it("resolves registered roots and distinct relative member paths, preserving dollars and spaces", () => {
    select();
    expect(resolveAuthoredCwd("${project:demo}/api", "/spec")).toBe(path.join(project, "api"));
    expect(resolveLaunchCwd("${project:demo}/ui", "/another-spec")).toBe(path.join(project, "ui"));
    expect(resolveLaunchCwd("${project:demo}", "/spec")).toBe(project);
  });
  it("does not choose among duplicate identities, even with a preview", () => {
    write("projects:\n  - {id: demo, root: .}\n  - {id: demo, root: elsewhere}\n");
    expect(() => resolveLaunchCwd("${project:demo}/api", root, undefined, { demo: project })).toThrow(/multiple roots/);
  });
  it("does not fall back to literal placeholder folders or hide unavailable roots", () => {
    fs.mkdirSync(path.join(root, "${project:demo}"));
    expect(() => resolveAuthoredCwd("${project:demo}", root)).toThrow(/no registered project/);
    write("projects:\n  - {id: demo, root: missing}\n");
    expect(() => resolveLaunchCwd("${project:demo}", root)).toThrow(/root does not exist/);
  });
  it("--cwd wins before missing or malformed project syntax is inspected", () => {
    for (const cwd of ["${project:missing}/api", "prefix/${project:demo}", "${project:}"]) {
      expect(resolveLaunchCwd(cwd, root, root)).toBe(root);
    }
    expect(() => projectCwdReference("prefix/${project:demo}")).toThrow(/Project cwd must/);
    expect(projectCwdReference("$PROJECT/api")).toBeUndefined();
  });
  it("previews a not-yet-materialized destination without changing the filesystem", async () => {
    const planned = path.join(root, "future", "demo");
    const spec = `version: "0.2"\nname: demo-team\npods:\n  - id: dev\n    label: Dev\n    members:\n      - {id: api, agent_ref: "builtin:terminal", profile: none, runtime: terminal, cwd: "\${project:demo}/api"}\n    edges: []\nedges: []\n`;
    const result = await rigPreflight({ rigSpecYaml: spec, rigRoot: root, plannedProjectRoots: { demo: planned }, fsOps: { readFile: p => fs.readFileSync(p, "utf8"), exists: fs.existsSync, listFiles: () => [] }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
    expect(result.errors.join("\n")).toBe("");
    expect(fs.existsSync(planned)).toBe(false); expect(fs.existsSync(catalog)).toBe(false);
    const missing = await rigPreflight({ rigSpecYaml: spec, rigRoot: root, fsOps: { readFile: p => fs.readFileSync(p, "utf8"), exists: fs.existsSync, listFiles: () => [] }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
    expect(missing.ready).toBe(false); expect(missing.errors.join(" ")).toContain("no registered project");
  });
  it("profile resolution uses the catalog and returns a structured missing-project error", () => {
    const member = { id: "impl", agentRef: "local:agent", profile: "default", runtime: "stub", cwd: "${project:demo}/api" };
    const pod = { id: "dev", label: "Dev", members: [member], edges: [] };
    const ctx = { baseSpec: { spec: { version: "1.0.0", name: "agent", imports: [], startup: { files: [], actions: [] }, resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] }, profiles: { default: { uses: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } } }, sourcePath: root, hash: "h" }, importedSpecs: [], collisions: [], profileName: "default", member, pod, rig: { version: "0.2", name: "team", pods: [pod], edges: [] }, specRoot: root, homedir: root } as ResolutionContext;
    expect(resolveNodeConfig(ctx)).toMatchObject({ ok: false, errors: [expect.stringContaining("no registered project")] });
    select();
    expect(resolveNodeConfig(ctx)).toMatchObject({ ok: true, config: { cwd: path.join(project, "api") } });
    expect(resolveNodeConfig({ ...ctx, cwdOverride: root })).toMatchObject({ ok: true, config: { cwd: root } });
  });
});
