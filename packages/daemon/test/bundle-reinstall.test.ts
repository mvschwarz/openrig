import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { pack } from "../src/domain/bundle-archive.js";
import { computeIntegrity } from "../src/domain/bundle-integrity.js";
import { stringify } from "yaml";
import { materializePodBundle } from "../src/domain/bundle-source-resolver.js";

describe("bundle reinstall through both public routes", () => {
  let root: string;
  let setup: ReturnType<typeof createTestApp>;
  let db: ReturnType<typeof createFullTestDb>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reinstall-"));
    vi.stubEnv("OPENRIG_HOME", path.join(root, "home"));
    db = createFullTestDb();
    const tmux = mockTmuxAdapter();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const disk = { exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8") };
    setup = createTestApp(db, {
      tmux, podInstantiatorFsOps: disk,
      upRouterFsOps: { ...disk, readHead: (p, n) => fs.readFileSync(p).subarray(0, n) },
    });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  async function bundle(name: string, version = "1.0.0", profile = "none") {
    const stage = fs.mkdtempSync(path.join(root, "stage-"));
    fs.writeFileSync(path.join(stage, "rig.yaml"), stringify({
      version: "0.2", name,
      pods: [{ id: "crew", label: "Crew", members: [{ id: "a", agent_ref: "builtin:terminal", profile, runtime: "terminal", cwd: "." }], edges: [] }], edges: [],
    }));
    fs.writeFileSync(path.join(stage, "README.md"), "offered team documentation\n");
    const integrity = computeIntegrity(stage, {
      readFile: p => fs.readFileSync(p, "utf8"), readFileBuffer: p => fs.readFileSync(p),
      writeFile: (p, c) => fs.writeFileSync(p, c), exists: fs.existsSync, walkFiles: () => ["rig.yaml", "README.md"],
    });
    fs.writeFileSync(path.join(stage, "bundle.yaml"), stringify({ schema_version: 2, name, version, created_at: "2026-10-01T00:00:00Z", rig_spec: "rig.yaml", agents: [], integrity }));
    const archive = path.join(root, `${name}-${version}.rigbundle`);
    await pack(stage, archive);
    return archive;
  }

  function seed(name: string, running: boolean) {
    const rig = setup.rigRepo.createRig(name);
    const node = setup.rigRepo.addNode(rig.id, "crew.old", { runtime: "terminal", cwd: path.join(root, "target") });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-old@${name}`);
    setup.sessionRegistry.updateStatus(session.id, running ? "running" : "exited");
    const run = setup.bootstrapRepo.createRun("rig_bundle", "/retained/original.rigbundle");
    setup.bootstrapRepo.updateRunStatus(run.id, "completed", { rigId: rig.id });
    return rig;
  }

  function installedTarget(name: string, target: string) {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "bundle.yaml"), stringify({ schema_version: 2, name, version: "0.9.0", created_at: "2026-10-01T00:00:00Z", rig_spec: "rig.yaml", agents: [] }));
  }

  async function install(route: string, archive: string, target = path.join(root, "target"), plan = false, cwdOverride?: string) {
    const response = await setup.app.request(route, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: archive, sourceRef: archive, targetRoot: target, plan, cwdOverride }) });
    return { status: response.status, body: await response.json(), target };
  }

  it.each([
    ["GitHub install endpoint, running workshop", "/api/bundles/install", "workshop", "1.0.0"],
    ["local changed manifest version, running workshop", "/api/up", "workshop", "99.0.0"],
    ["local overlapping kernel name", "/api/up", "kernel", "1.0.0"],
  ])("%s gives facts and choices without writing or launching", async (_label, route, name, version) => {
    const previous = seed(name, true);
    const result = await install(route, await bundle(name, version));
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(fs.existsSync(result.target)).toBe(false);
    expect(result.body.bundleInstall).toBeDefined();
    expect(result.body.bundleInstall.existing).toContainEqual({ rigId: previous.id, name, state: "running", source: "/retained/original.rigbundle", version: null });
    expect(result.body.bundleInstall.offered.version).toBe(version);
    expect(result.body.bundleInstall.resolutions.join("\n")).toMatch(/existing team[\s\S]*rig down[\s\S]*archived[\s\S]*Cancel/);
    expect(JSON.stringify(result.body)).not.toMatch(/Checkpoint|--target <newname>/);
    expect(fs.existsSync(result.target)).toBe(false);
    expect(setup.rigRepo.findRigsByName(name)).toHaveLength(1);
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });

  it.each([["/api/bundles/install", "workshop"], ["/api/up", "kernel"]])("%s replaces stopped %s, preserves edited files and returns recovery", async (route, name) => {
    const previous = seed(name, false);
    const target = path.join(root, "target");
    installedTarget(name, target);
    fs.writeFileSync(path.join(target, "README.md"), "my local edits\n");
    fs.writeFileSync(path.join(target, "unrelated.txt"), "leave me here");
    const result = await install(route, await bundle(name, "99.0.0"), target);
    expect(result.status).toBe(201);
    expect(result.body.bundleInstall.existing[0].state).toBe("stopped");
    expect(result.body.warnings.join("\n")).toContain(`rig unarchive ${previous.id}`);
    expect(setup.rigRepo.findUnarchivedRigsByName(name).map(rig => rig.id)).not.toContain(previous.id);
    expect(setup.rigRepo.findRigsByName(name).map(rig => rig.id)).toContain(previous.id);
    expect(setup.rigRepo.listRigs().map(rig => rig.id)).toEqual([result.body.rigId]);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("offered team documentation\n");
    expect(fs.readFileSync(path.join(target, "unrelated.txt"), "utf8")).toBe("leave me here");
    const backups = fs.readdirSync(path.join(root, "home", "bundle-backups"));
    const backup = path.join(root, "home", "bundle-backups", backups[0]!);
    expect(fs.readFileSync(path.join(backup, "files", "README.md"), "utf8")).toBe("my local edits\n");
    expect(result.body.warnings.join("\n")).toContain(backup);
    expect(result.body.warnings.join("\n")).not.toMatch(/Cancel this install|Retry this install|Use the existing team/);
    expect(result.body.bundleInstall.resolutions).toEqual([]);
  });

  it.each(["present", "transport_unavailable"])("round 2: %s old session leaves stopped-team target untouched", async state => {
    const previous = seed("workshop", false);
    vi.mocked(setup.tmuxAdapter.probeSession).mockResolvedValue(state === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "fixture unavailable" });
    const target = path.join(root, "target"); installedTarget("workshop", target);
    fs.writeFileSync(path.join(target, "README.md"), "original edits");
    const result = await install("/api/up", await bundle("workshop"), target);
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("generation_unconfirmed");
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("original edits");
    expect(fs.existsSync(path.join(root, "home", "bundle-backups"))).toBe(false);
    expect(setup.rigRepo.findUnarchivedRigsByName("workshop").map(rig => rig.id)).toEqual([previous.id]);
  });

  it.each(["validation", "late-session"])("round 2: %s refusal after materialization names the backup", async failure => {
    const previous = seed("workshop", false);
    const target = path.join(root, "target"); installedTarget("workshop", target);
    fs.writeFileSync(path.join(target, "README.md"), "original edits");
    if (failure === "late-session") {
      const instantiate = setup.podInstantiator.instantiate.bind(setup.podInstantiator);
      vi.spyOn(setup.podInstantiator, "instantiate").mockImplementation(async (...args) => {
        vi.mocked(setup.tmuxAdapter.probeSession).mockResolvedValue({ state: "present" });
        return instantiate(...args);
      });
    }
    const result = await install("/api/up", await bundle("workshop", "1.0.0", failure === "validation" ? "missing-profile" : "none"), target);
    expect(result.status).toBeGreaterThanOrEqual(400);
    const backups = fs.readdirSync(path.join(root, "home", "bundle-backups"));
    const backup = path.join(root, "home", "bundle-backups", backups[0]!);
    expect(result.body.warnings.join("\n")).toContain(backup);
    expect(result.body.warnings.join("\n")).toContain("Bundle files are installed");
    expect(fs.readFileSync(path.join(backup, "files", "README.md"), "utf8")).toBe("original edits");
    expect(setup.rigRepo.findUnarchivedRigsByName("workshop").map(rig => rig.id)).toEqual([previous.id]);
  });

  it.each(["/api/bundles/install", "/api/up"])("round 2: %s leaves a different project's conflicting files in place", async route => {
    seed("workshop", false);
    const target = path.join(root, "unrelated-project"); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "README.md"), "my project");
    const result = await install(route, await bundle("workshop"), target);
    expect(result.status).toBeGreaterThanOrEqual(400);
    if (route === "/api/up") expect(result.status).toBe(400);
    expect(result.body.errors.join("\n")).toContain("Nothing was written");
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("my project");
    expect(fs.existsSync(path.join(root, "home", "bundle-backups"))).toBe(false);
  });

  it.each(["/api/bundles/install", "/api/up"])("round 3: %s replaces the install folder when --cwd points at a project", async route => {
    const target = path.join(root, "installed"), project = path.join(root, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "README.md"), "my project");
    const first = await install(route, await bundle("workshop"), target, false, project);
    expect(first.status).toBe(201);
    expect(setup.rigRepo.getRig(first.body.rigId)?.nodes[0]?.cwd).toBe(project);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id IN (SELECT id FROM nodes WHERE rig_id = ?)").run(first.body.rigId);
    fs.writeFileSync(path.join(target, "README.md"), "edited installed documentation");
    const result = await install(route, await bundle("workshop", "2.0.0"), target, false, project);
    expect(result.status).toBe(201);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("offered team documentation\n");
    const backup = path.join(root, "home", "bundle-backups", fs.readdirSync(path.join(root, "home", "bundle-backups"))[0]!);
    expect(fs.readFileSync(path.join(backup, "files", "README.md"), "utf8")).toBe("edited installed documentation");
    expect(result.body.warnings.join("\n")).toContain(backup);
    expect(fs.readFileSync(path.join(project, "README.md"), "utf8")).toBe("my project");
  });

  it.each(["/api/bundles/install", "/api/up"])("round 3: %s keeps the seats' project intact when it is selected as target", async route => {
    const target = path.join(root, "installed"), project = path.join(root, "project");
    fs.mkdirSync(project);
    for (const name of ["README.md", "CULTURE.md", "rig.yaml"]) fs.writeFileSync(path.join(project, name), `my project ${name}`);
    const first = await install(route, await bundle("workshop"), target, false, project);
    expect(first.status).toBe(201);
    expect(setup.rigRepo.getRig(first.body.rigId)?.nodes[0]?.cwd).toBe(project);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id IN (SELECT id FROM nodes WHERE rig_id = ?)").run(first.body.rigId);
    const result = await install(route, await bundle("workshop", "2.0.0"), project, false, project);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.errors.join("\n")).toContain("Nothing was written");
    for (const name of ["README.md", "CULTURE.md", "rig.yaml"]) expect(fs.readFileSync(path.join(project, name), "utf8")).toBe(`my project ${name}`);
    expect(fs.existsSync(path.join(root, "home", "bundle-backups"))).toBe(false);
    expect(setup.rigRepo.findUnarchivedRigsByName("workshop").map(rig => rig.id)).toEqual([first.body.rigId]);
  });

  it("round 2: first-install parent file conflicts before any target write", () => {
    const source = path.join(root, "source"), target = path.join(root, "target");
    fs.mkdirSync(path.join(source, "agents"), { recursive: true }); fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, "README.md"), "offered");
    fs.writeFileSync(path.join(source, "agents", "a"), "offered");
    fs.writeFileSync(path.join(target, "agents"), "local file");
    expect(materializePodBundle(source, target)).toEqual({ ok: false, conflicts: ["agents"] });
    expect(fs.existsSync(path.join(target, "README.md"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "agents"), "utf8")).toBe("local file");
  });

  it("copies all edited originals before removing any when preservation fails", () => {
    const source = path.join(root, "source"), target = path.join(root, "target");
    fs.mkdirSync(source); fs.mkdirSync(target);
    for (const name of ["a", "b"]) {
      fs.writeFileSync(path.join(source, name), "offered");
      fs.writeFileSync(path.join(target, name), "local");
    }
    const copy = fs.cpSync;
    vi.spyOn(fs, "cpSync").mockImplementation((from, to, options) => {
      if (String(from).endsWith("/b")) throw new Error("fixture backup unavailable");
      return copy(from, to, options);
    });
    expect(() => materializePodBundle(source, target, true)).toThrow(/Originals were kept; partial backup/);
    for (const name of ["a", "b"]) expect(fs.readFileSync(path.join(target, name), "utf8")).toBe("local");
  });

  it("keeps linked originals and external contents while replacing a stopped team's file", () => {
    const source = path.join(root, "source"), target = path.join(root, "target"), external = path.join(root, "external");
    fs.mkdirSync(source); fs.mkdirSync(target);
    fs.writeFileSync(external, "external edits");
    fs.writeFileSync(path.join(source, "file"), "offered");
    fs.symlinkSync(external, path.join(target, "file"));
    const result = materializePodBundle(source, target, true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected materialization");
    expect(fs.readlinkSync(path.join(result.backupPath!, "files", "file"))).toBe(external);
    expect(fs.readFileSync(external, "utf8")).toBe("external edits");
    expect(fs.readFileSync(path.join(target, "file"), "utf8")).toBe("offered");
  });

  it("keeps an instance nested in the target while preserving edited bundle files", () => {
    const source = path.join(root, "source"), target = path.join(root, "target");
    fs.mkdirSync(source); fs.mkdirSync(path.join(target, "home"), { recursive: true });
    vi.stubEnv("OPENRIG_HOME", path.join(target, "home"));
    fs.writeFileSync(path.join(target, "home", "state"), "instance state");
    fs.writeFileSync(path.join(target, "data"), "local edits");
    fs.writeFileSync(path.join(source, "data"), "offered");
    const result = materializePodBundle(source, target, true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected materialization");
    expect(fs.readFileSync(path.join(target, "home", "state"), "utf8")).toBe("instance state");
    expect(fs.readFileSync(path.join(result.backupPath!, "files", "data"), "utf8")).toBe("local edits");
    expect(fs.readFileSync(path.join(target, "data"), "utf8")).toBe("offered");
  });
});
