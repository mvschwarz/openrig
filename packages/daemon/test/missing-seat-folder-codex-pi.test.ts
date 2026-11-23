// A seat folder that isn't on this machine (a home that moved) isn't recreated by the Codex or Pi adapter in order to
// write inside it, as for Claude: guidance and in-folder skills meant for it are skipped and named. Writes outside it
// still go: Codex's own home, and Pi's agent folder. Through the real filesystem, in a temporary root.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { replaceFile } from "../src/adapters/replace-file.js";
import { folderPresent } from "../src/domain/cwd-resolution.js";
import { createDaemon } from "../src/startup.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "../src/domain/projection-planner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missing-seat-folder-"));
  roots.push(root);
  const cwd = path.join(root, "old-home", "project");
  const src = path.join(root, "spec");
  fs.mkdirSync(path.join(src, "helper"), { recursive: true });
  fs.writeFileSync(path.join(src, "role.md"), "You lead this team.");
  fs.writeFileSync(path.join(src, "SOP.md"), "How work flows here.");
  fs.writeFileSync(path.join(src, "helper", "SKILL.md"), "# helper\n");
  const fsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: replaceFile,
    // As startup's: every file under a folder, relative to it (a skill is copied as a folder).
    listFiles: (dir: string) => (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
      .filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name))),
    homedir: root,
    folderPresent,
  };
  const guidance: ProjectionEntry = { category: "guidance", effectiveId: "role.md", sourceSpec: "agent", sourcePath: src,
    resourcePath: "role.md", absolutePath: path.join(src, "role.md"), mergeStrategy: "managed_block", classification: "safe_projection" };
  const skill: ProjectionEntry = { category: "skill", effectiveId: "helper", sourceSpec: "agent", sourcePath: src,
    resourcePath: "helper", absolutePath: path.join(src, "helper"), classification: "safe_projection" };
  const sop: ResolvedStartupFile = { path: "SOP.md", absolutePath: path.join(src, "SOP.md"), ownerRoot: src,
    deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] };
  const plan = (runtime: string, entries: ProjectionEntry[]) => ({ runtime, cwd, entries,
    startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }) as unknown as ProjectionPlan;
  const binding = { id: "b1", nodeId: "n1", tmuxSession: "dev-lead@moved", tmuxWindow: null, tmuxPane: "%1", cmuxWorkspace: null,
    cmuxSurface: null, updatedAt: "", cwd } as unknown as NodeBinding;
  return { root, cwd, fsOps, guidance, skill, sop, plan, binding };
}

describe("a seat folder missing on this machine isn't recreated by the Codex or Pi adapter", () => {
  it("Codex: guidance and an in-folder skill are skipped and named; its own home is still written", async () => {
    const s = setup();
    const codexHome = path.join(s.root, "codex-home");
    const adapter = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: s.fsOps, codexHome });
    const projected = await adapter.project(s.plan("codex", [s.guidance, s.skill]), s.binding);
    const delivered = await adapter.deliverStartup([s.sop], s.binding);
    expect(fs.existsSync(s.cwd), "the missing seat folder").toBe(false);
    const reason = `not written, because ${s.cwd} doesn't exist on this machine`;
    expect(projected.warnings).toEqual(expect.arrayContaining([`role.md: ${reason}`, `helper: ${reason}`]));
    expect(projected.projected).toEqual([]);
    expect(delivered.warnings).toEqual(expect.arrayContaining([`SOP.md: ${reason}`]));
    expect(delivered.delivered).toBe(0);
    expect(fs.existsSync(path.join(codexHome, "config.toml")), "Codex's own home still gets its trust entry").toBe(true);
  });

  it("Pi: guidance meant for the missing folder is skipped and named; its agent folder's skill still goes", async () => {
    const s = setup();
    const stateRoot = path.join(s.root, "pi-state");
    const adapter = new PiRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: s.fsOps, stateRoot });
    const projected = await adapter.project(s.plan("pi", [s.guidance, s.skill]), s.binding);
    const delivered = await adapter.deliverStartup([s.sop], s.binding);
    expect(fs.existsSync(s.cwd), "the missing seat folder").toBe(false);
    const reason = `not written, because ${s.cwd} doesn't exist on this machine`;
    expect(projected.warnings).toEqual(expect.arrayContaining([`role.md: ${reason}`]));
    expect(projected.projected).toEqual(["helper"]);
    expect(delivered.warnings).toEqual(expect.arrayContaining([`SOP.md: ${reason}`]));
    expect(delivered.delivered).toBe(0);
  });
});

// The daemon's own wiring: each Pi-family adapter it builds gets the check. OMP builds its own filesystem operations, so a
// missing folderPresent there reads every folder as present and the shared merge recreates the missing one.
describe("the daemon gives the Pi and OMP adapters it builds the missing-folder check", () => {
  it.each(["pi", "omp"])("%s: guidance meant for a missing seat folder is skipped and named", async (runtime) => {
    const s = setup();
    const { db, deps } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "",
      cmuxFactory: async () => { throw Object.assign(new Error("fixture: no cmux"), { code: "ENOENT" }); } });
    try {
      const projected = await deps.runtimeAdapters[runtime]!.project(s.plan(runtime, [s.guidance]), s.binding);
      expect(fs.existsSync(s.cwd), "the missing seat folder").toBe(false);
      expect(projected.warnings).toEqual(expect.arrayContaining([`role.md: not written, because ${s.cwd} doesn't exist on this machine`]));
    } finally { db.close(); }
  });
});
