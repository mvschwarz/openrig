// Slice 28 Checkpoint C-3 — skill-library API tests.
//
// SC-29 EXCEPTION #11 cumulative (verbatim declaration at
// packages/daemon/src/routes/plugins.ts header).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLibraryDiscoveryService } from "../src/domain/skill-library-discovery.js";
import { skillsRoutes } from "../src/routes/skills.js";

interface TestEnv {
  root: string;
  sharedSkillsDir: string;
  workspaceRoot: string;
  service: SkillLibraryDiscoveryService;
}

function setup(opts: { withWorkspace?: boolean } = {}): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "skill-library-routes-"));
  const sharedSkillsDir = join(root, "openrig-shared-skills");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(sharedSkillsDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const allowlist = opts.withWorkspace
    ? [{ name: "workspace", canonicalPath: workspaceRoot }]
    : [];
  const service = new SkillLibraryDiscoveryService({
    sharedSkillsDir,
    filesAllowlist: allowlist,
  });
  return { root, sharedSkillsDir, workspaceRoot, service };
}

function createApp(service: SkillLibraryDiscoveryService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("skillLibraryDiscoveryService" as never, service);
    await next();
  });
  app.route("/api/skills", skillsRoutes());
  return app;
}

function makeSkill(baseDir: string, relativePath: string, files: Array<{ name: string; content: string }>): string {
  const skillDir = join(baseDir, relativePath);
  mkdirSync(skillDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(skillDir, f.name), f.content);
  }
  return skillDir;
}

describe("SkillLibraryDiscoveryService — discovery (slice 28 HG-5 fix)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("flat openrig-managed: discovers a skill at the shared-skills root", () => {
    makeSkill(env.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("openrig-managed:claude-compact-in-place");
    expect(skills[0]?.name).toBe("claude-compact-in-place");
    expect(skills[0]?.source).toBe("openrig-managed");
    expect(skills[0]?.files.map((f) => f.name)).toEqual(["SKILL.md"]);
  });

  it("HG-5 ROOT CAUSE FIX: nested openrig-managed skill (category/skill/SKILL.md) discovered", () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    makeSkill(env.sharedSkillsDir, "core/openrig-architect", [{ name: "SKILL.md", content: "# body" }]);
    makeSkill(env.sharedSkillsDir, "pm/requirements-writer", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    expect(skills.map((s) => s.id).sort()).toEqual([
      "openrig-managed:core/openrig-architect",
      "openrig-managed:core/openrig-user",
      "openrig-managed:pm/requirements-writer",
    ]);
  });

  it("MIXED layout: flat + nested skills discovered in the same shared root", () => {
    makeSkill(env.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toContain("openrig-managed:claude-compact-in-place");
    expect(ids).toContain("openrig-managed:core/openrig-user");
    // Category folder name itself should NOT appear.
    expect(ids).not.toContain("openrig-managed:core");
  });

  it("DEPTH-CAP: depth-3+ skills NOT discovered (MAX_NESTING_DEPTH=1)", () => {
    makeSkill(env.sharedSkillsDir, "outer/inner/deep-skill", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    expect(skills).toHaveLength(0);
  });

  it("workspace source: discovers .openrig/skills/<name> under allowlist roots", () => {
    const envWith = setup({ withWorkspace: true });
    try {
      makeSkill(envWith.workspaceRoot, ".openrig/skills/operator-skill", [{ name: "SKILL.md", content: "# body" }]);
      const skills = envWith.service.listLibrarySkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.id).toBe("workspace:workspace:operator-skill");
      expect(skills[0]?.source).toBe("workspace");
    } finally {
      rmSync(envWith.root, { recursive: true, force: true });
    }
  });

  it("CONSOLIDATION: workspace + openrig-managed both surface in one call", () => {
    const envWith = setup({ withWorkspace: true });
    try {
      makeSkill(envWith.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
      makeSkill(envWith.workspaceRoot, ".openrig/skills/operator-skill", [{ name: "SKILL.md", content: "# body" }]);
      const skills = envWith.service.listLibrarySkills();
      const sources = skills.map((s) => s.source).sort();
      expect(sources).toEqual(["openrig-managed", "workspace"]);
    } finally {
      rmSync(envWith.root, { recursive: true, force: true });
    }
  });

  it("absent shared-skills directory: returns workspace-only", () => {
    const envWith = setup({ withWorkspace: true });
    try {
      // Wipe the shared-skills directory; service must not throw.
      rmSync(envWith.sharedSkillsDir, { recursive: true, force: true });
      makeSkill(envWith.workspaceRoot, ".openrig/skills/operator-skill", [{ name: "SKILL.md", content: "# body" }]);
      const skills = envWith.service.listLibrarySkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.source).toBe("workspace");
    } finally {
      rmSync(envWith.root, { recursive: true, force: true });
    }
  });

  it("listLibrarySkillsPublic: omits absolutePath from response shape", () => {
    makeSkill(env.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
    const pub = env.service.listLibrarySkillsPublic();
    expect(pub).toHaveLength(1);
    expect("absolutePath" in (pub[0] ?? {})).toBe(false);
  });
});

describe("GET /api/skills/library (slice 28)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("returns the consolidated skill list", async () => {
    makeSkill(env.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# top" }]);
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# nested" }]);
    const res = await createApp(env.service).request("/api/skills/library");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; source: string }>;
    const ids = body.map((s) => s.id).sort();
    expect(ids).toEqual([
      "openrig-managed:claude-compact-in-place",
      "openrig-managed:core/openrig-user",
    ]);
    // Public shape: absolutePath stripped.
    expect("absolutePath" in (body[0] ?? {})).toBe(false);
  });

  it("returns 503 when service is not provisioned in context", async () => {
    const app = new Hono();
    app.use("*", async (_c, next) => { await next(); });
    app.route("/api/skills", skillsRoutes());
    const res = await app.request("/api/skills/library");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("skill_library_unavailable");
  });
});

describe("GET /api/skills/:id/files/list (slice 28)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("lists files + dirs at the skill root (path='')", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [
      { name: "SKILL.md", content: "# body" },
      { name: "config.json", content: "{}" },
      { name: "fixture.yaml", content: "k: v" },
    ]);
    // Add a subfolder to verify the listing surfaces it.
    mkdirSync(join(env.sharedSkillsDir, "core/openrig-user/examples"), { recursive: true });
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/basic.md"), "# basic");
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skillId: string; entries: Array<{ name: string; type: string }> };
    expect(body.skillId).toBe(id);
    const names = body.entries.map((e) => e.name);
    // ALL files surfaced (HG-7 spec: not markdown-only).
    expect(names).toContain("SKILL.md");
    expect(names).toContain("config.json");
    expect(names).toContain("fixture.yaml");
    expect(names).toContain("examples");
    // Dirs sorted before files.
    expect(names.indexOf("examples")).toBeLessThan(names.indexOf("SKILL.md"));
  });

  it("HG-8 lists nested directory contents (path='examples')", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    mkdirSync(join(env.sharedSkillsDir, "core/openrig-user/examples"), { recursive: true });
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/basic.md"), "# basic");
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/advanced.md"), "# advanced");
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=examples`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("basic.md");
    expect(names).toContain("advanced.md");
  });

  it("returns 404 when skill id unknown", async () => {
    const res = await createApp(env.service).request("/api/skills/missing-skill/files/list?path=");
    expect(res.status).toBe(404);
  });

  it("rejects '..' escape attempt with 400 path_escape", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=..%2Fsomewhere`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });

  it("rejects symlink escape (realpath outside skill folder)", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const escapeTarget = join(env.root, "outside-target");
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, "secret.txt"), "out-of-bounds");
    symlinkSync(escapeTarget, join(env.sharedSkillsDir, "core/openrig-user/escape-link"));
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=escape-link`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});

describe("GET /api/skills/:id/files/read (slice 28)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("reads SKILL.md content from a nested skill", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# OpenRig User skill body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=SKILL.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skillId: string; path: string; content: string; contentHash: string };
    expect(body.skillId).toBe(id);
    expect(body.path).toBe("SKILL.md");
    expect(body.content).toContain("OpenRig User skill body");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("HG-8 reads a nested-subfolder file (examples/basic.md)", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# root" }]);
    mkdirSync(join(env.sharedSkillsDir, "core/openrig-user/examples"), { recursive: true });
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/basic.md"), "# basic example");
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=examples%2Fbasic.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("basic example");
  });

  it("returns 400 path_required when path query missing", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_required");
  });

  it("returns 404 stat_failed when file does not exist", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=nonexistent.md`);
    expect(res.status).toBe(404);
  });

  it("rejects '..' escape attempt with 400 path_escape", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=..%2Fsomewhere.md`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});
