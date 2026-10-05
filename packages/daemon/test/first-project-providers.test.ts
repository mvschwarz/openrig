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
  ["first-project", ["codex", "codex"], ["gpt-6-astra", "gpt-6-astra"]],
  ["first-project-claude", ["claude-code", "claude-code"], [undefined, undefined]],
  ["first-project-mixed", ["claude-code", "codex"], [undefined, "gpt-6-astra"]],
] as const;

describe("first-project provider choices", () => {
  let isolatedHome: string;
  beforeAll(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), "first-project-home-"));
    vi.stubEnv("HOME", isolatedHome);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(isolatedHome, { recursive: true, force: true });
  });
  for (const [name, runtimes, models] of choices) {
    it(`${name}: discovers and resolves the same owner/checker task`, async () => {
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
      expect(spec.pods).toHaveLength(1);
      const pod = spec.pods[0]!;
      expect(pod.id).toBe("dev");
      expect(pod.members.map((seat) => seat.id)).toEqual(["owner", "check"]);
      expect(pod.members.map((seat) => seat.runtime)).toEqual(runtimes);
      expect(pod.edges).toEqual([{ kind: "delegates_to", from: "owner", to: "check" }]);
      expect(readFileSync(resolve(root, spec.cultureFile!), "utf8")).toBe(
        readFileSync(join(specs, "rigs/launch/first-project/CULTURE.md"), "utf8"),
      );
      const cwd = join(tmpdir(), "first-project-repository");
      const preflight = await rigPreflight({ rigSpecYaml: found.yaml, rigRoot: root, cwdOverride: cwd, fsOps });
      expect(preflight.errors).toEqual([]);
      expect(preflight.ready).toBe(true);
      for (const [index, member] of pod.members.entries()) {
        const agent = resolveAgentRef(member.agentRef, root, fsOps);
        if (!agent.ok) throw new Error(JSON.stringify(agent));
        expect(agent.resolved.spec.name).toBe(index === 0 ? "implementer" : "qa");
        const resolved = resolveNodeConfig({
          baseSpec: agent.resolved, importedSpecs: agent.imports, collisions: agent.collisions,
          profileName: member.profile, specRoot: root, cwdOverride: cwd,
          homedir: homedir(), systemSkills: [], member, pod, rig: spec,
        });
        if (!resolved.ok) throw new Error(resolved.errors.join("\n"));
        expect(resolved.config.runtime).toBe(runtimes[index]);
        expect(resolved.config.model).toBe(models[index]);
        expect(resolved.config.cwd).toBe(cwd);
        expect(resolved.config.restorePolicy).toBe("resume_if_possible");
        expect(resolved.config.startup.files.length).toBeGreaterThan(0);
        for (const file of agent.resolved.spec.startup?.files ?? []) {
          expect(existsSync(resolve(agent.resolved.sourcePath, file.path))).toBe(true);
        }
        for (const skill of resolved.config.selectedResources.skills) {
          expect(existsSync(resolve(skill.sourcePath, (skill.resource as { path: string }).path, "SKILL.md"))).toBe(true);
        }
        const projection = planProjection({ config: resolved.config, collisions: agent.collisions, fsOps });
        if (!projection.ok) throw new Error(projection.errors.join("\n"));
        const runtimeResources = projection.plan.entries.filter((entry) => entry.category === "runtime_resource");
        expect(runtimeResources.map((entry) => entry.resourceType).sort()).toEqual(
          member.runtime === "codex" ? ["codex_config_fragment"]
            : ["claude_activity_hooks", "claude_mcp_fragment", "claude_settings_fragment"],
        );
        for (const entry of runtimeResources) expect(existsSync(entry.absolutePath)).toBe(true);
      }
    });
  }

  // Regression: `rig up first-project-claude` from a shell at '/' defaults cwdOverride to '/',
  // which used to pass preflight and then fail every projection under the filesystem root.
  it("refuses the filesystem root as launch cwd, even when it arrives as the cwd override", async () => {
    const root = join(specs, "rigs/launch/first-project-claude");
    const preflight = await rigPreflight({
      rigSpecYaml: readFileSync(join(root, "rig.yaml"), "utf8"), rigRoot: root, cwdOverride: "/", fsOps,
    });
    expect(preflight.ready).toBe(false);
    expect(preflight.errors).toEqual([
      expect.stringContaining("dev.owner: Resolved cwd '/' is the filesystem root"),
      expect.stringContaining("dev.check: Resolved cwd '/' is the filesystem root"),
    ]);
  });

  it("an absent unused provider selects the matching kernel, while both available select mixed", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "unavailable" })).toBe("rig-claude-only.yaml");
    expect(selectVariant({ claudeCode: "unavailable", codex: "ok" })).toBe("rig-codex-only.yaml");
    expect(selectVariant({ claudeCode: "ok", codex: "ok" })).toBe("rig.yaml");
  });
});
