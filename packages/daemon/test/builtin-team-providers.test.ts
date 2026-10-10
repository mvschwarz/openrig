import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { selectVariant } from "../src/domain/kernel-boot.js";
import { planProjection } from "../src/domain/projection-planner.js";

const specs = resolve(import.meta.dirname, "../specs");
const fsOps = { readFile: (p: string) => readFileSync(p, "utf8"), exists: existsSync };
const choices = [
  ["starter", [["dev.build", "claude-code"], ["dev.review", "codex"]]],
  ["factory", [["orch.lead", "codex"], ["orch.advisor", "claude-code"], ["dev.build", "claude-code"], ["dev.qa", "codex"], ["dev.design", "claude-code"], ["review.r1", "claude-code"], ["review.r2", "codex"]]],
  ["code-review", [["orch.lead", "claude-code"], ["review.r1", "claude-code"], ["review.r2", "codex"]]],
  ["research", [["orch.lead", "claude-code"], ["research.analyst", "claude-code"], ["research.synthesizer", "codex"]]],
  ["pm", [["pm.lead", "claude-code"], ["pm.researcher", "codex"], ["dev.build", "claude-code"]]],
  ["first-project-agy", [["dev.owner", "agy"], ["dev.check", "agy"]]],
] as const;

describe("built-in team names and resource resolution", () => {
  let isolatedHome: string;
  beforeAll(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), "builtin-team-home-"));
    vi.stubEnv("HOME", isolatedHome);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(isolatedHome, { recursive: true, force: true });
  });
  for (const [name, seats] of choices) {
    it(`${name}: discovers its seats and resolves their selected resources`, async () => {
      const lib = new SpecLibraryService({
        roots: [{ path: specs, sourceType: "builtin" }],
        specReviewService: new SpecReviewService(),
      });
      lib.scan();
      const matches = lib.list({ kind: "rig" }).filter((entry) => entry.name === name);
      expect(matches).toHaveLength(1);
      const found = lib.get(matches[0]!.id)!;
      const root = dirname(found.entry.sourcePath);
      const result = validateRigSpecFromYaml(found.yaml);
      expect(result.valid, result.errors.join("\n")).toBe(true);
      if (!result.valid) throw new Error("invalid starter");
      const spec = RigSpecSchema.normalize(RigSpecCodec.parse(found.yaml) as Record<string, unknown>);
      expect(spec.pods.flatMap((pod) => pod.members.map((member) => [`${pod.id}.${member.id}`, member.runtime]))).toEqual(seats);
      if (name === "starter") expect(spec.pods[0]!.edges).toEqual([{ kind: "delegates_to", from: "build", to: "review" }]);
      const cwd = join(tmpdir(), "builtin-team-repository");
      const preflight = await rigPreflight({ rigSpecYaml: found.yaml, rigRoot: root, cwdOverride: cwd, fsOps });
      expect(preflight.errors).toEqual([]);
      expect(preflight.ready).toBe(true);
      for (const pod of spec.pods) for (const member of pod.members) {
        const agent = resolveAgentRef(member.agentRef, root, fsOps);
        if (!agent.ok) throw new Error(JSON.stringify(agent));
        const resolved = resolveNodeConfig({
          baseSpec: agent.resolved, importedSpecs: agent.imports, collisions: agent.collisions,
          profileName: member.profile, specRoot: root, cwdOverride: cwd,
          homedir: homedir(), systemSkills: [], member, pod, rig: spec,
        });
        if (!resolved.ok) throw new Error(resolved.errors.join("\n"));
        expect(resolved.config.runtime).toBe(member.runtime);
        expect(resolved.config.model).toBe(member.model);
        expect(resolved.config.cwd).toBe(cwd);
        expect(resolved.config.restorePolicy).toBe("resume_if_possible");
        expect(resolved.config.startup.files.length).toBeGreaterThan(0);
        for (const file of agent.resolved.spec.startup?.files ?? []) {
          expect(existsSync(resolve(agent.resolved.sourcePath, file.path))).toBe(true);
        }
        for (const skill of resolved.config.selectedResources.skills) {
          expect(existsSync(resolve(skill.sourcePath, (skill.resource as { path: string }).path, "SKILL.md"))).toBe(true);
        }
        expect(resolved.config.selectedResources.plugins.map((plugin) => plugin.resource.id)).toContain("openrig-core");
        expect(resolved.config.selectedResources.skills.map((skill) => skill.resource.id)).not.toContain("test-driven-development");
        if (name === "factory" && member.id === "advisor") {
          expect(agent.resolved.spec.name).toBe("pm");
          expect(resolved.config.selectedResources.skills.map((skill) => skill.resource.id)).toEqual(["orchestration-team"]);
        }
        const projection = planProjection({ config: resolved.config, collisions: agent.collisions, fsOps });
        if (!projection.ok) throw new Error(projection.errors.join("\n"));
        const runtimeResources = projection.plan.entries.filter((entry) => entry.category === "runtime_resource");
        expect(runtimeResources.map((entry) => entry.resourceType).sort()).toEqual(
          member.runtime === "codex" ? ["codex_config_fragment"]
            : member.runtime === "agy" ? []
            : ["claude_activity_hooks", "claude_mcp_fragment", "claude_settings_fragment"],
        );
        for (const entry of runtimeResources) expect(existsSync(entry.absolutePath)).toBe(true);
      }
    });
  }

  it("an absent unused provider selects the matching kernel, while both available select mixed", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "unavailable" })).toBe("rig-claude-only.yaml");
    expect(selectVariant({ claudeCode: "unavailable", codex: "ok" })).toBe("rig-codex-only.yaml");
    expect(selectVariant({ claudeCode: "ok", codex: "ok" })).toBe("rig.yaml");
  });
});
