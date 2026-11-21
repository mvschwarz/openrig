import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { scopesRoutes } from "../src/routes/scopes.js";
import { viewsRoutes } from "../src/routes/views.js";
import { slicesRoutes } from "../src/routes/slices.js";
import { belongsToProject, readCatalogAliases, selectCatalogProject } from "../src/domain/workspace/project-catalog.js";
import { workSource, projectMission } from "../src/domain/workspace/project-read.js";
let root: string, app: Hono, db: ReturnType<typeof createDb>;
function file(name: string, text: string) { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, text); }
function source(text: string) { return `---\nid: same-id\nstatus: active\n---\n# Same name\n\n## Intent\n\n${text}\n`; }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s03-projects-")));
  file(path.join(root, "workspace.yaml"), "projects:\n  - id: a\n    root: a\n  - id: b\n    root: b\n");
  for (const id of ["a", "b"]) {
    file(path.join(root, id, "project.yaml"), `metadata:\n  id: ${id}\n  name: Same project\n`);
    file(path.join(root, id, "SPEC.md"), source(`${id} project only`));
    file(path.join(root, id, "missions/release-x/SPEC.md"), source(`${id} mission only`));
    file(path.join(root, id, "missions/release-x/slices/01-story/SPEC.md"), source(`${id} slice only`));
  }
  db = createDb(); migrate(db, ALL_MIGRATIONS);
  for (const id of ["a", "b", "unscoped"]) db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,tier,tags,body) VALUES(?,?,?,?,?,'in-progress','normal','light',?,?)")
    .run(`qitem-${id}`, "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z", "root@test", `${id}@test`, JSON.stringify(["mission:release-x", "slice:same-id", ...(id === "unscoped" ? [] : [`project:${id}`])]), `${id} work`);
  const projector = new ViewProjector(db, new EventBus(db));
  projector.setExecutionDeps({ db, slicesRoot: () => path.join(root, "b/missions") });
  const indexer = new SliceIndexer({ db, slicesRoot: path.join(root, "b/missions"), dogfoodEvidenceRoot: null });
  const detail = new SliceDetailProjector({ db, indexer });
  app = new Hono();
  app.use("*", async(c, next) => {
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? root : path.join(root, "workspace.yaml") }) });
    c.set("viewProjector" as never, projector); c.set("sliceIndexer" as never, indexer); c.set("sliceDetailProjector" as never, detail);
    await next();
  });
  app.route("/api/scopes", scopesRoutes()); app.route("/api/views", viewsRoutes()); app.route("/api/slices", slicesRoutes());
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
async function get(url: string) { const response = await app.request(url); return { status: response.status, body: await response.json() as any }; }
describe("catalog project identity across work reads", () => {
  it("keeps healthy missions and children reachable beside malformed source, then recovers", async () => {
    const bad = path.join(root, "a/missions/release-x/slices/02-bad/SPEC.md");
    file(bad, "---\nstatus: retired by another slice\n  kept for REASONING: preserve the original decision.\n---\n# Bad source\n");
    file(path.join(root, "a/missions/bad-mission/SPEC.md"), "---\nid: [broken\n---\n");
    file(path.join(root, "a/missions/healthy/SPEC.md"), source("healthy mission"));
    let scopes = await get("/api/scopes?detail=1&project=a");
    expect(scopes.status).toBe(200);
    expect(scopes.body.readErrors).toEqual([]);
    expect(scopes.body.missions.map((m: any) => m.mission).sort()).toEqual(["bad-mission", "healthy", "release-x"]);
    const mission = scopes.body.missions.find((m: any) => m.mission === "release-x");
    expect(mission.slices.find((s: any) => s.dirName === "01-story").intent).toBe("a slice only");
    const failed = mission.slices.find((s: any) => s.dirName === "02-bad");
    expect(failed.error).toContain("Invalid frontmatter");
    expect(failed.error).toContain(bad);
    expect(failed.error).not.toContain("status: retired");
    expect(scopes.body.missions.find((m: any) => m.mission === "bad-mission").error).toContain("Invalid frontmatter");
    expect((await get("/api/scopes?mission=release-x&detail=1&project=a")).status).toBe(200);
    expect((await get("/api/views/execution?mission=release-x&project=a")).status).toBe(200);
    expect((await get("/api/slices/01-story?mission=release-x&project=a")).status).toBe(200);
    expect((await get("/api/scopes/slice?mission=release-x&slice=02-bad&project=a")).body.error).toBe("source_invalid");
    file(bad, source("repaired slice"));
    scopes = await get("/api/scopes?detail=1&project=a");
    const repaired = scopes.body.missions.find((m: any) => m.mission === "release-x").slices.find((s: any) => s.dirName === "02-bad");
    expect(repaired.error).toBeUndefined(); expect(repaired.intent).toBe("repaired slice");
  });
  it("shares CLI catalog selection, preserves equal work IDs and filters execution/queue membership", async () => {
    const catalog = await get("/api/scopes/projects"); expect(catalog.body.projects.map((p: any) => p.id)).toEqual(["a", "b"]);
    for (const id of ["a", "b"]) {
      expect(selectCatalogProject(path.join(root, "workspace.yaml"), id)?.root).toBe(path.join(root, id));
      const scopes = await get(`/api/scopes?detail=1&project=${id}`);
      expect(scopes.body.missions[0].slices[0].intent).toBe(`${id} slice only`);
      const execution = await get(`/api/views/execution?mission=release-x&project=${id}`);
      expect(execution.status).toBe(200);
      expect(JSON.stringify(execution.body)).toContain(`qitem-${id}`);
      expect(JSON.stringify(execution.body)).not.toContain(`qitem-${id === "a" ? "b" : "a"}`);
      expect(JSON.stringify(execution.body)).not.toContain("qitem-unscoped");
      const detail = await get(`/api/slices/01-story?mission=release-x&project=${id}`);
      expect(detail.status).toBe(200); expect(detail.body.qitemIds).toEqual([`qitem-${id}`]);
    }
  });
  it("shows a renamed project's earlier rows once its project.yaml declares the former id, and counts rows no project claims", async () => {
    // Project a was renamed from oc-beacon; its earlier row keeps the old tag. Another row's tag names no project at all.
    for (const [id, tag] of [["qitem-renamed", "project:oc-beacon"], ["qitem-stray", "project:retired-name"]]) db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,tier,tags,body) VALUES(?,?,?,?,?,'in-progress','normal','light',?,?)")
      .run(id, "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z", "root@test", "a@test", JSON.stringify(["mission:release-x", "slice:same-id", tag]), `${id} work`);
    let execution = await get("/api/views/execution?mission=release-x&project=a");
    expect(JSON.stringify(execution.body)).not.toContain("qitem-renamed");
    expect(execution.body.rows[0].uncatalogued_project_tags).toEqual({ rows: 2, ids: ["oc-beacon", "retired-name"] });
    file(path.join(root, "a", "project.yaml"), "metadata:\n  id: a\n  name: Same project\naliases: [oc-beacon]\n");
    execution = await get("/api/views/execution?mission=release-x&project=a");
    expect(JSON.stringify(execution.body)).toContain("qitem-renamed");
    expect(execution.body.rows[0].uncatalogued_project_tags).toEqual({ rows: 1, ids: ["retired-name"] });
    expect((await get("/api/slices/01-story?mission=release-x&project=a")).body.qitemIds).toEqual(expect.arrayContaining(["qitem-a", "qitem-renamed"]));
    // The former id is a's alone.
    expect(JSON.stringify((await get("/api/views/execution?mission=release-x&project=b")).body)).not.toContain("qitem-renamed");
  });
  it("ignores a former id that's another project's current id or that two projects declare, and says which and why", async () => {
    file(path.join(root, "a", "project.yaml"), "metadata:\n  id: a\naliases: [old, shared, b]\n");
    file(path.join(root, "b", "project.yaml"), "metadata:\n  id: b\naliases: [shared]\n");
    for (const [id, tag] of [["qitem-old", "project:old"], ["qitem-shared", "project:shared"]]) db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,tier,tags,body) VALUES(?,?,?,?,?,'in-progress','normal','light',?,?)")
      .run(id, "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z", "root@test", "a@test", JSON.stringify(["mission:release-x", "slice:same-id", tag]), `${id} work`);
    expect([...readCatalogAliases(path.join(root, "workspace.yaml"))]).toEqual([["old", "a"]]);
    const projects = (await get("/api/scopes/projects")).body.projects;
    expect(projects.find((p: any) => p.id === "a").aliasWarnings).toEqual([
      "aliases: 'shared' is ignored: b also declares it, so rows tagged project:shared belong to no project",
      "aliases: 'b' is ignored: it's project b's current id, so rows tagged project:b stay b's",
    ]);
    expect(projects.find((p: any) => p.id === "b").aliasWarnings).toEqual(["aliases: 'shared' is ignored: a also declares it, so rows tagged project:shared belong to no project"]);
    const a = await get("/api/views/execution?mission=release-x&project=a");
    expect(a.status).toBe(200);
    expect(a.body.rows[0].alias_warnings).toEqual(projects.find((p: any) => p.id === "a").aliasWarnings);
    // The current id keeps precedence and access: b's rows stay b's. The valid former id applies; the shared one is unclaimed.
    expect(JSON.stringify(a.body)).toContain("qitem-old");
    expect(JSON.stringify(a.body)).not.toContain("qitem-b");
    expect(a.body.rows[0].uncatalogued_project_tags).toEqual({ rows: 1, ids: ["shared"] });
    expect(JSON.stringify((await get("/api/views/execution?mission=release-x&project=b")).body)).toContain("qitem-b");
    expect(belongsToProject(JSON.stringify(["mission:release-x,project:old"]), ["a", "old"])).toBe(true);
  });
  it("accepts a symlink spelling of the selected root and still refuses a different project", async () => {
    const alias = path.join(root, "a-link");
    fs.symlinkSync(path.join(root, "a"), alias, "dir");
    const selected = await get(`/api/scopes?project=a&projectRoot=${encodeURIComponent(`${alias}/.`)}`);
    expect(selected.status).toBe(200);
    fs.unlinkSync(alias);
    fs.symlinkSync(path.join(root, "b"), alias, "dir");
    const changed = await get(`/api/scopes?project=a&projectRoot=${encodeURIComponent(alias)}`);
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("project_changed");
  });
  it("reports a removed pinned uncatalogued workspace as unavailable, with its filesystem reason", async () => {
    const pinned = root;
    fs.rmSync(pinned, { recursive: true });
    const result = await get(`/api/scopes?project=workspace&projectRoot=${encodeURIComponent(pinned)}`);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("project_unavailable");
    expect(result.body.message).toContain("ENOENT");
  });
  it("reports removed, changed, malformed and escaping sources without substituting another project", async () => {
    fs.renameSync(path.join(root, "a/SPEC.md"), path.join(root, "a/SPEC.retained.md"));
    let scopes = await get("/api/scopes?detail=1&project=a"); expect(scopes.status).toBe(409); expect(scopes.body.error).toBe("project_unavailable");
    expect(JSON.stringify(scopes.body)).not.toContain("b slice only");
    expect((await get("/api/scopes?detail=1&project=b")).status).toBe(200);
    file(path.join(root, "a/SPEC.md"), source("a restored"));
    expect((await get("/api/scopes?project=a&projectRoot=wrong-root")).body.error).toBe("project_changed");
    file(path.join(root, "a/missions/release-x/slices/01-story/SPEC.md"), "---\nid: [broken\n---\n");
    scopes = await get("/api/scopes?detail=1&project=a"); expect(scopes.body.missions[0].slices[0].error).toContain("Invalid frontmatter"); expect(scopes.body.readErrors).toEqual([]);
    expect((await get("/api/views/execution?project=a&mission=../b")).status).toBe(409);
    fs.renameSync(path.join(root, "a/missions"), path.join(root, "a/missions-retained"));
    fs.symlinkSync(path.join(root, "b/missions"), path.join(root, "a/missions"));
    expect((await get("/api/scopes?project=a")).status).toBe(409);
    file(path.join(root, "workspace.yaml"), "projects: [broken");
    expect((await get("/api/scopes/projects")).status).toBe(409);
  });
  it("keeps missing and permission errors local while retaining containment refusal", async () => {
    const project = (await get("/api/scopes/projects")).body.projects[0];
    const missing = path.join(root, "a/missions/release-x/slices/02-missing"); fs.mkdirSync(missing);
    expect(() => workSource(project.root, missing)).toThrow("No work source");
    expect(() => projectMission(project, "release-x")).not.toThrow();
    const denied = path.join(root, "a/missions/release-x/slices/03-denied/SPEC.md"); file(denied, source("private")); fs.chmodSync(denied, 0);
    try {
      expect(() => workSource(project.root, path.dirname(denied))).toThrow(/EACCES/);
      const result = (await get("/api/scopes?detail=1&project=a")).body;
      expect(result.readErrors).toEqual([]);
      expect(result.missions[0].slices.find((s: any) => s.dirName === "02-missing").error).toContain("No work source");
      expect(result.missions[0].slices.find((s: any) => s.dirName === "03-denied").error).toContain("EACCES");
      expect(result.missions[0].slices.find((s: any) => s.dirName === "01-story").intent).toBe("a slice only");
    } finally { fs.chmodSync(denied, 0o600); }
    fs.symlinkSync(path.join(root, "b/missions/release-x/slices/01-story"), path.join(root, "a/missions/release-x/slices/escape"));
    expect(() => projectMission(project, "release-x")).toThrow("outside selected project");
    expect((await get("/api/views/execution?project=a&mission=release-x")).status).toBe(409);
  });
});
