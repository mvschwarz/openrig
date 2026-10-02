import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { planProjection } from "../src/domain/projection-planner.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";

const kernel = path.resolve(import.meta.dirname, "../specs/rigs/launch/kernel");
const cwd = "/fixture/shared";
const ids = ["advisor.lead", "operator.agent", "queue.worker"];
const readFile = (p: string) => fs.readFileSync(p, "utf8");
const rig = RigSpecSchema.normalize(parse(readFile(path.join(kernel, "rig.yaml"))));

function configFor(id: string, sharedRole = false) {
  const [podId, memberId] = id.split(".");
  const pod = rig.pods.find(p => p.id === podId)!;
  const member = pod.members.find(m => m.id === memberId)!;
  const source = path.join(kernel, "agents", podId, memberId);
  const fsOps = { exists: fs.existsSync, readFile(p: string) {
    const text = readFile(p);
    if (!sharedRole || p !== path.join(source, "agent.yaml")) return text;
    // Historical control: the shared role block both Codex seats used to select.
    const old = parse(text);
    old.resources = { ...old.resources, guidance: [{ id: "role", path: "guidance/role.md", target: id === "advisor.lead" ? "CLAUDE.md" : "AGENTS.md", merge: "managed_block" }] };
    old.profiles.default.uses.guidance = ["role"];
    for (const file of old.startup.files) delete file.orientation;
    return stringify(old);
  } };
  const resolved = resolveAgentRef(member.agentRef, kernel, fsOps);
  if (!resolved.ok) throw Error(JSON.stringify(resolved));
  const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports,
    collisions: resolved.collisions, profileName: "default", specRoot: kernel, cwdOverride: cwd,
    member, pod, rig, homedir: "/fixture/home", skillsRoot: "/fixture/empty-catalog" });
  if (!result.ok) throw Error(JSON.stringify(result));
  const projected = planProjection({ config: result.config, collisions: resolved.collisions, fsOps });
  if (!projected.ok) throw Error(JSON.stringify(projected));
  return { source, config: result.config, plan: projected.plan };
}

function memory(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const writes: string[] = [];
  const ops = { homedir: "/fixture/home", exists: (p: string) => files.has(p) || fs.existsSync(p),
    readFile: (p: string) => files.get(p) ?? readFile(p),
    writeFile(p: string, s: string) { files.set(p, s); writes.push(p); }, mkdirp() {},
    copyFile(s: string, d: string) { this.writeFile(d, this.readFile(s)); } };
  const noNative = new Proxy({}, { get: () => () => { throw Error("Native operations forbidden"); } });
  const adapters = {
    "claude-code": new ClaudeCodeAdapter({ tmux: noNative as never, fsOps: ops }),
    codex: new CodexRuntimeAdapter({ tmux: noNative as never, fsOps: ops,
      listProcesses: () => { throw Error("No process survey"); },
      readThreadIdByPid: () => { throw Error("No native thread lookup"); }, codexHome: "/fixture/codex" }),
  };
  return { files, writes, adapters };
}
async function project(id: string, sharedRole: boolean, m: ReturnType<typeof memory>, claudeFile = "CLAUDE.md") {
  const c = configFor(id, sharedRole);
  const adapter = m.adapters[c.config.runtime as keyof typeof m.adapters];
  // Guidance-only projection: no plugin/settings changes or native launch.
  const result = await adapter.project({ ...c.plan, entries: c.plan.entries.filter(e => e.category === "guidance") },
    { nodeId: id, cwd, claudeManagedBlockFile: claudeFile });
  expect(result.failed).toEqual([]);
}

describe("kernel per-seat role orientation", () => {
  it.each(ids)("%s retains role startup and other resources, without selecting shared role guidance", id => {
    const current = configFor(id), old = configFor(id, true);
    expect(current.config.selectedResources.guidance).toEqual([]);
    expect(old.config.selectedResources.guidance.map(g => g.effectiveId)).toEqual(["role"]);
    for (const key of ["skills", "subagents", "plugins", "runtimeResources"] as const) {
      expect(current.config.selectedResources[key]).toEqual(old.config.selectedResources[key]);
    }
    expect(current.config.startup.files.find(f => f.orientation === "role")).toMatchObject({ path: "guidance/role.md", deliveryHint: "send_text", required: true });
    const withoutMarkers = current.config.startup.files.map(({ orientation, ...file }) => file);
    expect(withoutMarkers).toEqual(old.config.startup.files);
    expect(current.config.startup.actions).toEqual(old.config.startup.actions);
    expect(fs.existsSync(path.join(current.source, "guidance/role.md"))).toBe(true);
  });
  it("reproduces the historical Codex last-writer collision in both orders", async () => {
    for (const order of [["operator.agent", "queue.worker"], ["queue.worker", "operator.agent"]]) {
      const m = memory();
      for (const id of order) await project(id, true, m);
      const text = m.files.get(path.join(cwd, "AGENTS.md"))!;
      expect(text).toContain(readFile(path.join(configFor(order[1]).source, "guidance/role.md")));
      expect(text).not.toContain(readFile(path.join(configFor(order[0]).source, "guidance/role.md")));
    }
  });
  it.each(["OpenRig", "RIGGED", "user-only"])("preserves %s files byte-for-byte in both adapters, with no cleanup", async marker => {
    const text = marker === "user-only" ? "# User content  \n" : `# User prefix  \n<!-- BEGIN ${marker} MANAGED BLOCK: role -->\nOld role remains exposed\n<!-- END ${marker} MANAGED BLOCK: role -->\n# User suffix\n`;
    const seed = Object.fromEntries(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"].map(f => [path.join(cwd, f), text]));
    for (const claudeFile of ["CLAUDE.md", "CLAUDE.local.md"]) {
      const m = memory(seed);
      for (const id of ids) await project(id, false, m, claudeFile);
      expect(m.writes).toEqual([]);
      expect(Object.fromEntries(m.files)).toEqual(seed);
    }
  });
});
