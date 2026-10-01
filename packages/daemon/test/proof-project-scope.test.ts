// #132 — proof show/judge resolve a project-qualified scope through the workspace catalog, applying
// containment per project root; unqualified scopes keep the selected `workspace.slices_root` behavior.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { Hono } from "hono";
import { proofRoutes } from "../src/routes/proof.js";
import { scopesRoutes } from "../src/routes/scopes.js";
import { readSliceReadiness } from "../src/domain/proof/judgments.js";

const fixtures: string[] = [];
afterEach(() => { for (const p of fixtures.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const write = (p: string, data: string | object) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, typeof data === "string" ? data : YAML.stringify(data)); };

function project(root: string, id: string, judge: string, missionsDir = "missions") {
  write(join(root, "project.yaml"), { kind: "project", metadata: { id }, proofPolicy: { judges: [judge] }, missions: { root: missionsDir } });
  write(join(root, "README.md"), `# ${id}\n`);
  const mission = join(root, missionsDir, "m0"), slice = join(mission, "slices", "01-t001");
  write(join(mission, "mission.yaml"), { kind: "mission", metadata: { name: "m0", status: "active" }, composition: { slices: [{ ref: "slices/01-t001/slice.yaml", order: 1, active: true }] } });
  write(join(slice, "slice.yaml"), { kind: "slice", metadata: { id: "01-t001", status: "draft" } });
  write(join(slice, "SPEC.md"), `---\nid: 01-t001\n---\n# ${id}\n\n## Proof contract\n- [ ] Prove ${id}.\n`);
  write(join(slice, "proof", "evidence.md"), `Observed ${id}.\n`);
  return { missions: join(root, missionsDir), slice };
}

function fixture(alphaMissions = "missions") {
  const workspace = fs.mkdtempSync(join(tmpdir(), "proof-catalog-")); fixtures.push(workspace);
  write(join(workspace, "workspace.yaml"), { projects: [{ id: "alpha", root: "alpha" }, { id: "beta", root: "beta" }] });
  const alpha = project(join(workspace, "alpha"), "alpha", "judge@rig", alphaMissions);
  const beta = project(join(workspace, "beta"), "beta", "judge@rig");
  // The daemon's single selected slices root is a different (legacy) project.
  const legacy = project(join(workspace, "legacy"), "legacy", "judge@rig");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: legacy.missions, invalidate: () => {} } as never);
    c.set("proofSourceWatch" as never, { observation: () => ({ state: "watching", revision: "workspace-1" }) } as never); // the selected workspace's watcher
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? workspace : join(workspace, "workspace.yaml") }) } as never);
    await next();
  });
  app.route("/api/proof", proofRoutes());
  const get = (query: string) => app.request(`/api/proof?${query}`);
  const judge = async (scope: string, extra: Record<string, unknown> = {}, readDir = alpha.slice) => {
    const item = readSliceReadiness(readDir).items[0]!;
    return app.request("/api/proof/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "judge@rig" },
      body: JSON.stringify({ scope, item: item.id, verdict: "accept", reason: "Observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null, ...extra }),
    });
  };
  return { workspace, alpha, beta, legacy, get, judge };
}

describe("project-qualified proof scope (#132)", () => {
  it("show resolves `<project>:<scope>` and `project=` through the catalog, not the selected slices root", async () => {
    const f = fixture();
    const qualified = await f.get(`scope=${encodeURIComponent("alpha:m0/slices/01-t001")}`);
    expect(qualified.status).toBe(200);
    expect((await qualified.json()).items[0].text).toContain("Prove alpha.");
    const byFlag = await f.get("project=beta&scope=m0/slices/01-t001");
    expect(byFlag.status).toBe(200);
    expect((await byFlag.json()).items[0].text).toContain("Prove beta.");
    const readiness = await f.get("project=beta");
    expect(readiness.status).toBe(200);
    expect((await readiness.json()).missions.map((m: { name: string }) => m.name)).toEqual(["m0"]);
  });

  it("an unqualified scope keeps today's selected-workspace behavior", async () => {
    const f = fixture();
    const res = await f.get("scope=m0/slices/01-t001");
    expect(res.status).toBe(200);
    expect((await res.json()).items[0].text).toContain("Prove legacy.");
  });

  it("judge records the receipt inside the named project only", async () => {
    const f = fixture();
    const res = await f.judge("alpha:m0/slices/01-t001");
    expect(res.status).toBe(201);
    expect((await res.json()).judgment).toMatchObject({ scope: "missions/m0/slices/01-t001", actor: "judge@rig" });
    expect(fs.existsSync(join(f.alpha.slice, "proof/judgments/00000001.md"))).toBe(true);
    for (const other of [f.beta.slice, f.legacy.slice]) expect(fs.existsSync(join(other, "proof/judgments"))).toBe(false);
    const flagged = await f.judge("m0/slices/01-t001", { project: "beta" }, f.beta.slice);
    expect(flagged.status).toBe(201);
    expect(fs.existsSync(join(f.beta.slice, "proof/judgments/00000001.md"))).toBe(true);
  });

  it("prepares evidence against the project root, so prepare+judge agree under a nested missions.root", async () => {
    const f = fixture("work/missions");
    const scope = "alpha:m0/slices/01-t001";
    const view = await (await f.get(`scope=${encodeURIComponent(scope)}&evidence=proof%2Fevidence.md`)).json();
    expect(view.preparedEvidence).toEqual([expect.objectContaining({ ref: "work/missions/m0/slices/01-t001/proof/evidence.md" })]);
    const res = await f.judge(scope, { expectedEvidence: view.preparedEvidence });
    expect(res.status).toBe(201);
    expect((await res.json()).judgment.evidence).toEqual(view.preparedEvidence);
  });

  it("applies path_escape per project root — a sibling project or the workspace is outside", async () => {
    const f = fixture();
    const sibling = await f.get(`scope=${encodeURIComponent("alpha:../../beta/missions/m0/slices/01-t001")}`);
    expect(sibling.status).toBe(400);
    expect((await sibling.json()).error).toBe("path_escape");
    const judged = await f.judge("alpha:../../legacy/missions/m0/slices/01-t001", {}, f.legacy.slice);
    expect((await judged.json()).error).toBe("path_escape");
    const outside = fs.mkdtempSync(join(tmpdir(), "proof-outside-")); fixtures.push(outside);
    fs.writeFileSync(join(outside, "evidence.md"), "outside");
    fs.symlinkSync(outside, join(f.alpha.slice, "proof/outside"));
    const evidence = await f.judge("alpha:m0/slices/01-t001", { evidence: ["proof/outside/evidence.md"] });
    expect((await evidence.json()).error).toBe("path_escape");
    expect(fs.existsSync(join(f.alpha.slice, "proof/judgments"))).toBe(false);
  });

  it("refuses an unknown project, an invalid id, and a scope/flag project conflict", async () => {
    const f = fixture();
    // an uncatalogued prefix is an ordinary path (review: colon paths keep working), missing here
    const uncatalogued = await f.get(`scope=${encodeURIComponent("nope:m0/slices/01-t001")}`);
    expect(uncatalogued.status).toBe(404);
    expect((await uncatalogued.json()).error).toBe("scope_missing");
    const unknown = await f.get("project=nope&scope=m0/slices/01-t001");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("project_not_found");
    const invalid = await f.get("project=..%2Fescape&scope=m0");
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_project");
    const conflict = await f.judge("alpha:m0/slices/01-t001", { project: "beta" });
    expect(conflict.status).toBe(400);
    expect((await conflict.json()).error).toBe("project_conflict");
    expect(fs.existsSync(join(f.alpha.slice, "proof/judgments"))).toBe(false);
  });

  it("a Windows absolute scope is never read as a project-qualified scope (review)", async () => {
    const f = fixture();
    for (const scope of ["C:\\Users\\x\\missions\\m0\\slices\\01-t001", "C:/Users/x/missions/m0/slices/01-t001"]) {
      const res = await f.get(`scope=${encodeURIComponent(scope)}`);
      // resolved against the selected workspace like any unqualified scope (there it doesn't exist), never as project "C"
      expect(await res.json(), scope).toMatchObject({ error: "scope_missing" });
    }
    // a one-letter prefix with a relative scope is a project only when the catalog has it; here it hasn't
    expect(await (await f.get(`scope=${encodeURIComponent("C:m0")}`)).json()).toMatchObject({ error: "scope_missing" });
  });

  it("catalog-project reads report the source watcher as unavailable/unverified and name the project; workspace reads don't", async () => {
    const f = fixture();
    const qualified = await (await f.get(`scope=${encodeURIComponent("alpha:m0/slices/01-t001")}`)).json();
    expect(qualified.sourceObservation).toEqual({ state: "unavailable", revision: "unverified" });
    expect(qualified.project).toEqual({ id: "alpha", root: join(f.workspace, "alpha") });
    const whole = await (await f.get("project=beta")).json();
    expect(whole.sourceObservation).toEqual({ state: "unavailable", revision: "unverified" });
    expect(whole.project).toEqual({ id: "beta", root: join(f.workspace, "beta") });
    const workspace = await (await f.get("scope=m0/slices/01-t001")).json();
    expect(workspace.project).toBeUndefined();
    expect(workspace.sourceObservation).toEqual({ state: "watching", revision: "workspace-1" });
  });

  it("a judgment pinned to the prepared projectRoot records; a moved root is refused with 409 project_changed", async () => {
    const f = fixture();
    const root = join(f.workspace, "alpha");
    const moved = await f.judge("alpha:m0/slices/01-t001", { projectRoot: join(f.workspace, "elsewhere") });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: "project_changed" });
    expect(fs.existsSync(join(f.alpha.slice, "proof", "judgments"))).toBe(false);
    const pinned = await f.judge("alpha:m0/slices/01-t001", { projectRoot: root });
    expect(pinned.status).toBe(201);
    const read = await f.get(`scope=${encodeURIComponent("alpha:m0/slices/01-t001")}&projectRoot=${encodeURIComponent(join(f.workspace, "other"))}`);
    expect(read.status).toBe(409);
  });

  it("a README-only catalog project under an ancestor project.yaml can't reach evidence outside its own root (CodeRabbit, CWE-22)", async () => {
    const ws = fs.mkdtempSync(join(tmpdir(), "proof-ancestor-")); fixtures.push(ws);
    // the workspace itself has a project.yaml whose policy would authorise the judge; the catalog project has none
    write(join(ws, "project.yaml"), { kind: "project", metadata: { id: "outer" }, proofPolicy: { judges: ["judge@rig"] } });
    write(join(ws, "workspace.yaml"), { projects: [{ id: "readme-only", root: "readme-only" }] });
    const root = join(ws, "readme-only");
    write(join(root, "README.md"), "# readme-only\n");
    const slice = join(root, "missions", "m0", "slices", "01-t001");
    write(join(root, "missions", "m0", "mission.yaml"), { kind: "mission", metadata: { name: "m0", status: "active" }, composition: { slices: [{ ref: "slices/01-t001/slice.yaml", order: 1, active: true }] } });
    write(join(slice, "slice.yaml"), { kind: "slice", metadata: { id: "01-t001", status: "draft" }, proofPolicy: { judges: ["judge@rig"] } });
    write(join(slice, "SPEC.md"), "---\nid: 01-t001\n---\n# x\n\n## Proof contract\n- [ ] Prove it.\n");
    write(join(slice, "proof", "evidence.md"), "Observed.\n");
    const sibling = join(ws, "other-project", "secret.md"); write(sibling, "not this project's evidence\n");
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: join(root, "missions"), invalidate: () => {} } as never);
      c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? ws : join(ws, "workspace.yaml") }) } as never);
      await next();
    });
    app.route("/api/proof", proofRoutes());
    const read = await (await app.request(`/api/proof?scope=${encodeURIComponent("readme-only:m0/slices/01-t001")}`)).json();
    const item = read.items[0];
    const judge = (evidence: string[]) => app.request("/api/proof/judge", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "judge@rig" },
      body: JSON.stringify({ scope: "readme-only:m0/slices/01-t001", item: item.id, verdict: "accept", reason: "Observed", evidence, expectedRevision: item.revision, expectedPrevious: null }) });
    for (const ref of [sibling, "../../../../../other-project/secret.md"]) {
      const res = await judge([ref]);
      expect(res.status, ref).toBeGreaterThanOrEqual(400);
      expect((await res.json()).error, ref).toBe("path_escape");
    }
    expect(fs.existsSync(join(slice, "proof", "judgments"))).toBe(false);
    // the project's own evidence still records, against the project's root
    const ok = await judge(["proof/evidence.md"]);
    expect(ok.status).toBe(201);
    const receipt = (await ok.json()).judgment;
    expect(receipt.scope).toBe("missions/m0/slices/01-t001");
  });

  // Review (2026-10-01): scope readiness agrees with proof. A catalogued project that keeps its contract in README
  // (no SPEC, no project.yaml of its own) sits under a workspace whose own project.yaml has a different judge.
  function readmeProject() {
    const ws = fs.mkdtempSync(join(tmpdir(), "proof-scopes-")); fixtures.push(ws);
    write(join(ws, "project.yaml"), { kind: "project", metadata: { id: "outer" }, proofPolicy: { judges: ["outer@rig"] } });
    write(join(ws, "workspace.yaml"), { projects: [{ id: "readme-only", root: "readme-only" }, { id: "bare", root: "bare" }] });
    const mission = (root: string, policy: object) => {
      write(join(root, "README.md"), "# project\n");
      write(join(root, "missions", "m0", "mission.yaml"), { kind: "mission", metadata: { name: "m0", status: "active" }, ...policy, composition: { slices: [{ ref: "slices/01-t001/slice.yaml", order: 1, active: true }] } });
      write(join(root, "missions", "m0", "README.md"), "# m0\n");
      const slice = join(root, "missions", "m0", "slices", "01-t001");
      write(join(slice, "slice.yaml"), { kind: "slice", metadata: { id: "01-t001", status: "draft" } });
      write(join(slice, "README.md"), "---\nid: 01-t001\n---\n# The slice\n\n## Proof contract\n- [ ] Prove it.\n");
      write(join(slice, "proof", "evidence.md"), "Observed.\n");
      return slice;
    };
    const slice = mission(join(ws, "readme-only"), { proofPolicy: { judges: ["judge@rig"] } });
    mission(join(ws, "bare"), {});   // no policy anywhere under its own root
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: join(ws, "missions"), invalidate: () => {} } as never);
      c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? ws : join(ws, "workspace.yaml") }) } as never);
      await next();
    });
    app.route("/api/proof", proofRoutes());
    app.route("/api/scopes", scopesRoutes());
    return { ws, slice, app };
  }

  it("judged through proof, then read through scopes (list, detail, mission) as accepted: one project root for both", async () => {
    const { app } = readmeProject();
    const scope = "readme-only:m0/slices/01-t001";
    const read = await (await app.request(`/api/proof?scope=${encodeURIComponent(scope)}`)).json();
    const item = read.items[0];
    const judged = await app.request("/api/proof/judge", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "judge@rig" },
      body: JSON.stringify({ scope, item: item.id, verdict: "accept", reason: "Observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null }) });
    expect(judged.status).toBe(201);
    const shown = await (await app.request(`/api/proof?scope=${encodeURIComponent(scope)}`)).json();
    expect(shown.items[0].state).toBe("accepted");
    expect(shown.state).toBe("ready");

    const list = await (await app.request("/api/scopes?project=readme-only&mission=m0&detail=1")).json();
    const listed = list.slices[0].readiness;
    expect(listed.items.map((i: { state: string }) => i.state)).toEqual(["accepted"]);
    expect(listed.state).toBe("ready");
    expect(listed.items[0].revision).toBe(shown.items[0].revision);
    expect(list.readiness.slices[0].readiness.state).toBe("ready");
    const tree = await (await app.request("/api/scopes?project=readme-only")).json();
    expect(tree.missions[0].slices[0].readiness.state).toBe("ready");
    const detail = await (await app.request("/api/scopes/slice?project=readme-only&mission=m0&slice=01-t001")).json();
    expect(detail.readiness.items[0].state).toBe("accepted");
    expect(detail.readiness.policy.judges).toEqual(["judge@rig"]);
  });

  it("a catalogued project never inherits the workspace's policy, in scopes or in proof", async () => {
    const { app } = readmeProject();
    const viaScopes = await (await app.request("/api/scopes/slice?project=bare&mission=m0&slice=01-t001")).json();
    expect(viaScopes.readiness.policy).toBeNull();
    const viaProof = await (await app.request(`/api/proof?scope=${encodeURIComponent("bare:m0/slices/01-t001")}`)).json();
    expect(viaProof.policy).toBeNull();
    expect(viaScopes.readiness.items[0].revision).toBe(viaProof.items[0].revision);
  });

  it("an unqualified scope whose mission folder has a colon still resolves as written, even when the prefix is a catalogued project", async () => {
    const f = fixture();
    // the selected workspace has a mission folder "alpha:trial"; "alpha" is also a catalogued project
    const trial = join(f.legacy.missions, "alpha:trial"), slice = join(trial, "slices", "01-t001");
    write(join(trial, "mission.yaml"), { kind: "mission", metadata: { name: "alpha:trial", status: "active" }, composition: { slices: [{ ref: "slices/01-t001/slice.yaml", order: 1, active: true }] } });
    write(join(slice, "slice.yaml"), { kind: "slice", metadata: { id: "01-t001", status: "draft" } });
    write(join(slice, "SPEC.md"), "---\nid: 01-t001\n---\n# trial\n\n## Proof contract\n- [ ] Prove the trial.\n");
    write(join(slice, "proof", "evidence.md"), "Observed the trial.\n");
    const res = await f.get(`scope=${encodeURIComponent("alpha:trial/slices/01-t001")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].text).toContain("Prove the trial.");
    expect(body.project).toBeUndefined();
    const judged = await f.judge("alpha:trial/slices/01-t001", {}, slice);
    expect(judged.status).toBe(201);
    expect(fs.existsSync(join(slice, "proof/judgments/00000001.md"))).toBe(true);
    expect(fs.existsSync(join(f.alpha.slice, "proof/judgments"))).toBe(false);
    // a scope that doesn't exist as written still names the catalogued project
    const qualified = await (await f.get(`scope=${encodeURIComponent("alpha:m0/slices/01-t001")}`)).json();
    expect(qualified.items[0].text).toContain("Prove alpha.");
    // and with --project, a colon path inside that project resolves as written
    const inside = join(f.alpha.missions, "beta:trial", "slices", "01-t001");
    write(join(f.alpha.missions, "beta:trial", "mission.yaml"), { kind: "mission", metadata: { name: "beta:trial", status: "active" }, composition: { slices: [{ ref: "slices/01-t001/slice.yaml", order: 1, active: true }] } });
    write(join(inside, "slice.yaml"), { kind: "slice", metadata: { id: "01-t001", status: "draft" } });
    write(join(inside, "SPEC.md"), "---\nid: 01-t001\n---\n# x\n\n## Proof contract\n- [ ] Prove the inside trial.\n");
    const flagged = await (await f.get(`project=alpha&scope=${encodeURIComponent("beta:trial/slices/01-t001")}`)).json();
    expect(flagged.items[0].text).toContain("Prove the inside trial.");
  });
});
