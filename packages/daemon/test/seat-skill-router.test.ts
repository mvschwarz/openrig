// OPR.0.7.0.13 (router, R1.1): one generated router skill per seat in its own storage, the opt-in one-line bootstrap,
// and the seat report. Filesystem and settings only; no seat is launched.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEAT_SKILL_ROUTER_ID, SEAT_SKILLS_BOOTSTRAP_LINE, describeSkillRouterFootprint, cleanSeatSkills, ensureSeatSkillPlugin, resolveSeatSkillRouter, seatSkillPaths, writeSeatSkillCatalog, writeSeatSkillRouter,
} from "../src/domain/seat-skill-storage.js";
import { bootstrapLineChoice, inspectSeatSkills } from "../src/domain/seat-skill-apply.js";
import { readFootprintAnswer, routerLineSkipReason } from "../src/domain/footprint-choice.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { isSeatSkillsBootstrapLine } from "../src/domain/startup-orchestrator.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function seat(runtime: "claude-code" | "codex") {
  const home = mkdtempSync(join(tmpdir(), "seat-router-")); roots.push(home);
  const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
  if (runtime === "claude-code") ensureSeatSkillPlugin(paths);
  const skill = (id: string, description: string) => {
    mkdirSync(join(paths.skillsRoot, id), { recursive: true });
    writeFileSync(join(paths.skillsRoot, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\nBody\n`);
  };
  return { home, paths, skill };
}

describe("the seat's one generated router skill", () => {
  it.each(["claude-code", "codex"] as const)("%s: lists every other skill's trigger and exact file, and is a skill itself", (runtime) => {
    const { paths, skill } = seat(runtime);
    skill("queue-handoff", "Use when handing work to another seat.");
    skill("release-notes", "Use when writing release notes.");
    const router = writeSeatSkillRouter(paths);
    expect(router).toEqual({ id: SEAT_SKILL_ROUTER_ID, path: join(paths.skillsRoot, SEAT_SKILL_ROUTER_ID, "SKILL.md"), written: true });
    const text = readFileSync(router.path, "utf8");
    expect(text).toMatch(/^---\nname: openrig-seat-router\ndescription: Use first whenever/);
    expect(text).toContain("- **queue-handoff**: Use when handing work to another seat.");
    expect(text).toContain(`Read before you use it: \`${join(paths.skillsRoot, "queue-handoff", "SKILL.md")}\``);
    expect(text).toContain("- **release-notes**: Use when writing release notes.");
    // A second write over itself doesn't list itself.
    expect(readFileSync(writeSeatSkillRouter(paths).path, "utf8")).not.toContain("**openrig-seat-router**");
    expect(resolveSeatSkillRouter(paths)).toMatchObject({ written: true });
  });

  it("is never listed in a Codex seat's catalog, which stays as it was", () => {
    const { paths, skill } = seat("codex");
    skill("queue-handoff", "Use when handing work to another seat.");
    const before = writeSeatSkillCatalog(paths);
    writeSeatSkillRouter(paths);
    const after = writeSeatSkillCatalog(paths);
    expect(after.digest).toBe(before.digest);
    expect(readFileSync(paths.catalogPath, "utf8")).not.toContain(SEAT_SKILL_ROUTER_ID);
  });

  it("an edited router is kept and named, never overwritten", () => {
    const { paths, skill } = seat("claude-code");
    skill("queue-handoff", "Use when handing work to another seat.");
    const router = writeSeatSkillRouter(paths);
    writeFileSync(router.path, "---\nname: openrig-seat-router\ndescription: mine\n---\nEdited by the person\n");
    skill("release-notes", "Use when writing release notes.");
    expect(writeSeatSkillRouter(paths)).toMatchObject({ written: false, kept: "edited" });
    expect(readFileSync(router.path, "utf8")).toContain("Edited by the person");
    expect(resolveSeatSkillRouter(paths)).toMatchObject({ written: false, kept: "edited" });
  });

  it("a link on the way into the seat's storage: the router returns before reading any skill, and writes nothing", () => {
    const { home, paths } = seat("codex");
    const elsewhere = mkdtempSync(join(tmpdir(), "seat-router-elsewhere-")); roots.push(elsewhere);
    mkdirSync(join(paths.root), { recursive: true });
    symlinkSync(elsewhere, paths.skillsRoot);
    expect(writeSeatSkillRouter(paths)).toMatchObject({ written: false, kept: "linked" });
    expect(existsSync(join(elsewhere, SEAT_SKILL_ROUTER_ID))).toBe(false);
    expect(home).toBeTruthy();
  });

  it("the reserved name hides only OpenRig's own router: a team skill named openrig-seat-router is listed, and the router says it was kept", () => {
    const { paths, skill } = seat("codex");
    skill("queue-handoff", "Use when handing work to another seat.");
    skill(SEAT_SKILL_ROUTER_ID, "A team skill that happens to use the reserved name.");
    expect(writeSeatSkillRouter(paths)).toMatchObject({ written: false, kept: "edited" });
    writeSeatSkillCatalog(paths);
    expect(readFileSync(paths.catalogPath, "utf8")).toContain(`**${SEAT_SKILL_ROUTER_ID}**: A team skill that happens to use the reserved name.`);
    expect(readFileSync(join(paths.skillsRoot, SEAT_SKILL_ROUTER_ID, "SKILL.md"), "utf8")).toContain("happens to use the reserved name");
  });

  it("cleanup removes the router only while it is exactly what OpenRig wrote", () => {
    const ours = seat("codex");
    ours.skill("queue-handoff", "Use when handing work to another seat.");
    const written = writeSeatSkillRouter(ours.paths);
    cleanSeatSkills(ours.paths);
    expect(existsSync(written.path)).toBe(false);

    const edited = seat("codex");
    const router = writeSeatSkillRouter(edited.paths);
    writeFileSync(router.path, "Edited by the person\n");
    const cleanup = cleanSeatSkills(edited.paths);
    expect(existsSync(router.path)).toBe(true);
    expect(cleanup.kept).toContain(router.path);
  });
});

describe("the one-line bootstrap: the recorded choice and the delivery filter", () => {
  const settings = (read: { value: unknown; source: string }) => ({ resolveOne: () => read }) as never;
  it.each([
    [{ value: true, source: "file" }, { state: "yes", by: "saved" }],
    [{ value: false, source: "file" }, { state: "no", by: "saved" }],
    [{ value: true, source: "env" }, { state: "yes", by: "environment" }],
    [{ value: false, source: "env" }, { state: "no", by: "environment" }],
    [{ value: false, source: "default" }, { state: "unasked" }],
  ])("a setting read of %j is the answer %j (readFootprintAnswer)", (read, answer) => {
    expect(readFootprintAnswer(settings(read))).toEqual(answer);
    expect(bootstrapLineChoice(settings(read))).toEqual(answer);
  });

  it("an unreadable setting is unknown in the report, never a no", () => {
    expect(bootstrapLineChoice({ resolveOne: () => { throw new Error("config unreadable"); } } as never)).toEqual({ state: "unknown" });
  });

  it("the guidance asset is exactly the constant line", () => {
    expect(readFileSync(join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md"), "utf8")).toBe(`${SEAT_SKILLS_BOOTSTRAP_LINE}\n`);
  });

  it("the footprint preview names the line and each real file, one entry per shared file, before any write", () => {
    const preview = describeSkillRouterFootprint([
      { seat: "dev-impl@team", runtime: "codex", cwd: "/p" },
      { seat: "dev-qa@team", runtime: "codex", cwd: "/p" },
      { seat: "dev-lead@team", runtime: "claude-code", cwd: "/p", claudeManagedBlockFile: "CLAUDE.local.md" },
      { seat: "dev-doc@team", runtime: "claude-code", cwd: "/q" },
      { seat: "dev-pi@team", runtime: "pi", cwd: "/p" },
    ]);
    expect(preview.line).toBe(SEAT_SKILLS_BOOTSTRAP_LINE);
    expect(preview.files).toEqual([
      { path: join("/p", "AGENTS.md"), runtime: "codex", seats: ["dev-impl@team", "dev-qa@team"] },
      { path: join("/p", "CLAUDE.local.md"), runtime: "claude-code", seats: ["dev-lead@team"] },
      { path: join("/q", "CLAUDE.md"), runtime: "claude-code", seats: ["dev-doc@team"] },
    ]);
    expect(preview.notCovered).toEqual([{ seat: "dev-pi@team", runtime: "pi", reason: expect.any(String) }]);
    expect(preview.ifNo).toMatch(/Nothing is written into these files/);
  });

  it("the filter picks out the bootstrap line, never the Codex catalog that shares its logical name", () => {
    expect(isSeatSkillsBootstrapLine({ path: "openrig-seat-skills.md", deliveryHint: "guidance_merge" })).toBe(true);
    expect(isSeatSkillsBootstrapLine({ path: "openrig-seat-skills.md", deliveryHint: "send_text" })).toBe(false);
    expect(isSeatSkillsBootstrapLine({ path: "CULTURE.md", deliveryHint: "guidance_merge" })).toBe(false);
  });
});

describe("the seat report (rig skill loadout --seat)", () => {
  it("reports the router apart from the skills, and the bootstrap line's recorded choice apart from the router", () => {
    const home = mkdtempSync(join(tmpdir(), "seat-router-report-")); roots.push(home);
    const prior = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
    try {
      const ref = { nodeId: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" as const, sessionName: "dev-impl@team", cwd: "/p" };
      const paths = seatSkillPaths({ rigId: ref.rigId, logicalId: ref.logicalId, runtime: ref.runtime }, home);
      mkdirSync(join(paths.skillsRoot, "queue-handoff"), { recursive: true });
      writeFileSync(join(paths.skillsRoot, "queue-handoff", "SKILL.md"), "---\nname: queue-handoff\ndescription: Use when handing work.\n---\nBody\n");
      writeSeatSkillRouter(paths);
      const report = inspectSeatSkills(ref, null, undefined, { state: "unasked" });
      expect(report.skills.map((s) => s.id)).toEqual(["queue-handoff"]);
      expect(report.router).toEqual({ id: SEAT_SKILL_ROUTER_ID, path: join(paths.skillsRoot, SEAT_SKILL_ROUTER_ID, "SKILL.md"), written: true });
      expect(report.bootstrapLine).toEqual({ state: "unasked" });
    } finally {
      if (prior === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = prior;
    }
  });
});

// Root 265a7f8e: an explicit OPENRIG_SKILLS_ROUTER_LINE_ENABLED=true is a supported opt-in, attributed to the
// environment; unset is not a yes; an explicit false skips. Real settings store, real config file, real env.
describe("the saved answer through the real settings store: unset, false, true and precedence, with the source", () => {
  const ENV = "OPENRIG_SKILLS_ROUTER_LINE_ENABLED";
  let prior: string | undefined;
  const store = (file?: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "router-line-settings-")); roots.push(dir);
    const path = join(dir, "config.json");
    if (file) writeFileSync(path, JSON.stringify(file));
    return new SettingsStore(path);
  };
  const withEnv = (value: string | undefined, run: () => void) => {
    prior = process.env[ENV];
    if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
    try { run(); } finally { if (prior === undefined) delete process.env[ENV]; else process.env[ENV] = prior; }
  };

  it.each([
    ["unset everywhere", undefined, undefined, { state: "unasked" }, "answer_unasked"],
    ["the person's saved true", { skills: { routerLine: { enabled: true } } }, undefined, { state: "yes", by: "saved" }, null],
    ["the person's saved false", { skills: { routerLine: { enabled: false } } }, undefined, { state: "no", by: "saved" }, "answer_no"],
    ["the environment's true", undefined, "true", { state: "yes", by: "environment" }, null],
    ["the environment's false", undefined, "false", { state: "no", by: "environment" }, "answer_environment_no"],
    ["the environment's true over a saved false", { skills: { routerLine: { enabled: false } } }, "true", { state: "yes", by: "environment" }, null],
    ["the environment's false over a saved true", { skills: { routerLine: { enabled: true } } }, "false", { state: "no", by: "environment" }, "answer_environment_no"],
  ] as const)("%s", (_label, file, env, answer, skip) => {
    withEnv(env, () => {
      const read = readFootprintAnswer(store(file as Record<string, unknown> | undefined));
      expect(read).toEqual(answer);
      expect(routerLineSkipReason(read)).toBe(skip);
    });
  });

  it("an explicit false saved with set() stays a saved no, not unasked; reset() returns to unasked", () => {
    withEnv(undefined, () => {
      const s = store();
      s.set("skills.router_line.enabled", "false");
      expect(readFootprintAnswer(s)).toEqual({ state: "no", by: "saved" });
      s.reset("skills.router_line.enabled");
      expect(readFootprintAnswer(s)).toEqual({ state: "unasked" });
    });
  });
});
