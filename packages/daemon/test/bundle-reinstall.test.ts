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

  async function bundle(name: string, version = "1.0.0") {
    const stage = fs.mkdtempSync(path.join(root, "stage-"));
    fs.writeFileSync(path.join(stage, "rig.yaml"), stringify({
      version: "0.2", name,
      pods: [{ id: "crew", label: "Crew", members: [{ id: "a", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: root }], edges: [] }], edges: [],
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
    const node = setup.rigRepo.addNode(rig.id, "crew.old", { runtime: "terminal", cwd: root });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-old@${name}`);
    setup.sessionRegistry.updateStatus(session.id, running ? "running" : "exited");
    const run = setup.bootstrapRepo.createRun("rig_bundle", "/retained/original.rigbundle");
    setup.bootstrapRepo.updateRunStatus(run.id, "completed", { rigId: rig.id });
    return rig;
  }

  async function install(route: string, archive: string, target = path.join(root, "target"), plan = false) {
    const response = await setup.app.request(route, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: archive, sourceRef: archive, targetRoot: target, plan }) });
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
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "README.md"), "my local edits\n");
    fs.writeFileSync(path.join(target, "unrelated.txt"), "leave me here");
    const result = await install(route, await bundle(name, "99.0.0"), target);
    expect(result.status).toBe(201);
    expect(result.body.bundleInstall.existing[0].state).toBe("stopped");
    expect(result.body.warnings.join("\n")).toContain(`rig unarchive ${previous.id}`);
    expect(setup.rigRepo.getRig(previous.id)!.rig.archivedAt).toBeTruthy();
    expect(setup.rigRepo.listRigs().map(rig => rig.id)).toEqual([result.body.rigId]);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("offered team documentation\n");
    expect(fs.readFileSync(path.join(target, "unrelated.txt"), "utf8")).toBe("leave me here");
    const backups = fs.readdirSync(path.join(root, "home", "bundle-backups"));
    const backup = path.join(root, "home", "bundle-backups", backups[0]!);
    expect(fs.readFileSync(path.join(backup, "files", "README.md"), "utf8")).toBe("my local edits\n");
    expect(result.body.warnings.join("\n")).toContain(backup);
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
