// The shipped agent specs that carry a per-seat role file mark it as the seat's role orientation (#562's channel), so
// `rig queue whoami` reports the binding and refocus names the file. Nothing else about them changes: they still
// select no shared role guidance, and their startup delivery is the same `send_text` file it was.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";

const agents = path.resolve(import.meta.dirname, "../specs/agents");
const readFile = (p: string) => fs.readFileSync(p, "utf8");
const fsOps = { exists: fs.existsSync, readFile };

/** Every shipped agent spec that starts a seat with `guidance/role.md`. */
const roleSpecs = fs.globSync("**/agent.yaml", { cwd: agents })
  .filter((rel) => (parse(readFile(path.join(agents, rel))) as { startup?: { files?: Array<{ path: string }> } })
    .startup?.files?.some((f) => f.path === "guidance/role.md"))
  .map((rel) => path.dirname(rel))
  .sort();

/** The same spec without the role marker, as it was before it was marked: exactly one line differs. */
function unmarked(dir: string): string {
  const text = readFile(path.join(agents, dir, "agent.yaml"));
  const marker = "      orientation: role\n";
  expect(text.split(marker)).toHaveLength(2);
  return text.replace(marker, "");
}

function resolve(dir: string, profile: string, text?: string) {
  const rig = RigSpecSchema.normalize(parse(`version: "0.2"\nname: role-check\npods:\n  - id: pod\n    label: Pod\n    members:\n      - id: seat\n        agent_ref: "local:${dir}"\n        runtime: claude-code\n        profile: ${profile}\n        cwd: "."\n`));
  const pod = rig.pods[0]!;
  const member = pod.members[0]!;
  const ops = text === undefined ? fsOps : { exists: fs.existsSync, readFile: (p: string) => p === path.join(agents, dir, "agent.yaml") ? text : readFile(p) };
  const resolved = resolveAgentRef(member.agentRef, agents, ops);
  if (!resolved.ok) throw Error(JSON.stringify(resolved));
  const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
    profileName: profile, specRoot: agents, cwdOverride: "/fixture/shared", member, pod, rig,
    homedir: "/fixture/home", skillsRoot: "/fixture/empty-catalog" });
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.config;
}

describe("shipped agent specs mark their per-seat role file as the seat's role orientation", () => {
  it("covers the shipped specs that start a seat with a role file", () => {
    expect(roleSpecs).toHaveLength(15);
  });

  it.each(roleSpecs)("%s: every profile marks the role file, selects no shared role guidance, and is otherwise unchanged", (dir) => {
    const profiles = Object.keys((parse(readFile(path.join(agents, dir, "agent.yaml"))) as { profiles: object }).profiles);
    for (const profile of profiles) {
      const current = resolve(dir, profile);
      const old = resolve(dir, profile, unmarked(dir));
      expect(current.startup.files.find((f) => f.orientation === "role"))
        .toMatchObject({ path: "guidance/role.md", deliveryHint: "send_text", required: true });
      expect(current.selectedResources.guidance.map((g) => g.effectiveId)).not.toContain("role");
      expect(current.selectedResources).toEqual(old.selectedResources);
      expect(current.startup.files.map(({ orientation, ...file }) => file)).toEqual(old.startup.files);
      expect(current.startup.actions).toEqual(old.startup.actions);
    }
  });
});
