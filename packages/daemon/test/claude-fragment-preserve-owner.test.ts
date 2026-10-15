// A project's .claude/settings.local.json or .mcp.json that isn't a JSON object (it doesn't parse, or it holds an
// array or a single value) belongs to its owner. Projecting a Claude settings or MCP fragment leaves it byte-for-byte,
// reports the fragment skipped with a warning, and doesn't fail the projection; the context collector that runs before
// launch, and again later, leaves it alone too. Valid objects, missing, empty and whitespace-only files behave as
// before. Through the adapter's project(), deliverStartup() and ensureContextCollector(), with the daemon's real
// filesystem operations in a temporary seat directory.
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { replaceFile } from "../src/adapters/replace-file.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const TARGETS = [
  { type: "claude_settings_fragment", rel: ".claude/settings.local.json", fragment: { permissions: { allow: ["Bash(npm test:*)"] } }, key: "permissions" },
  { type: "claude_mcp_fragment", rel: ".mcp.json", fragment: { mcpServers: { "spec-server": { command: "spec-mcp" } } }, key: "mcpServers" },
] as const;

function seat(target: (typeof TARGETS)[number], existing: string | null, fragmentText?: string) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fragment-owner-"));
  roots.push(root);
  const cwd = nodePath.join(root, "seat");
  fs.mkdirSync(nodePath.join(cwd, ".claude"), { recursive: true });
  const fragmentPath = nodePath.join(root, "spec", "fragment.json");
  fs.mkdirSync(nodePath.dirname(fragmentPath), { recursive: true });
  fs.writeFileSync(fragmentPath, fragmentText ?? JSON.stringify(target.fragment));
  const asset = nodePath.join(root, "collector.cjs");
  fs.writeFileSync(asset, "// collector\n");
  const targetPath = nodePath.join(cwd, target.rel);
  if (existing !== null) fs.writeFileSync(targetPath, existing);
  const fsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), copyFile: replaceFile,
    homedir: nodePath.join(root, "home"),
  };
  const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateDir: nodePath.join(root, "openrig"), collectorAssetPath: asset });
  const plan = {
    runtime: "claude-code", cwd, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    entries: [{ category: "runtime_resource", effectiveId: "spec-fragment", sourceSpec: "spec", sourcePath: fragmentPath,
      resourcePath: "fragment.json", absolutePath: fragmentPath, resourceType: target.type, classification: "safe_projection" }],
  } as unknown as ProjectionPlan;
  const binding = { id: "b", nodeId: "n", cwd, tmuxSession: "seat@rig" } as NodeBinding;
  const read = () => (fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf-8") : null);
  return { adapter, plan, binding, cwd, targetPath, fragmentPath, read };
}

/** Projection, then the pre-launch collector (deliverStartup), then a later collector call. */
async function sequence(s: ReturnType<typeof seat>) {
  const projection = await s.adapter.project(s.plan, s.binding);
  const afterProjection = s.read();
  await s.adapter.deliverStartup([], s.binding);
  const afterStartup = s.read();
  s.adapter.ensureContextCollector(s.binding);
  return { projection, afterProjection, afterStartup, afterLater: s.read() };
}

const UNUSABLE: Array<[string, string, RegExp]> = [
  ["truncated JSON", '{ "owner_note": "keep me", "env": { "A": "1" ', /isn't valid JSON \(/],
  ["a trailing comma", '{ "owner_note": "keep me", }', /isn't valid JSON \(/],
  ["a JSON array", '[ { "owner_note": "keep me" } ]', /holds a JSON array, not an object/],
  ["a JSON number", "42", /holds a JSON number, not an object/],
  ["JSON null", "null", /holds JSON null, not an object/],
  ["a JSON string", '"keep me"', /holds a JSON string, not an object/],
];

describe("a project file that isn't a JSON object is left as it is", () => {
  for (const target of TARGETS) for (const [label, text, reason] of UNUSABLE) {
    it(`${target.rel} holding ${label}: kept byte-for-byte through projection and both collector calls; the fragment is skipped with a warning`, async () => {
      const s = seat(target, text);
      const r = await sequence(s);
      expect([r.afterProjection, r.afterStartup, r.afterLater]).toEqual([text, text, text]);
      expect(r.projection.failed).toEqual([]);
      expect(r.projection.projected).not.toContain("spec-fragment");
      expect(r.projection.skipped).toContain("spec-fragment");
      expect(r.projection.warnings).toHaveLength(1);
      const warning = r.projection.warnings![0]!;
      expect(warning).toMatch(new RegExp(`^Left ${s.targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} as it is: `));
      expect(warning).toMatch(reason);
      expect(warning).toContain(`The fragment ${s.fragmentPath} wasn't applied; fix the file and launch again to apply it.`);
      // Nothing was copied to the generic extensions directory instead.
      expect(fs.existsSync(nodePath.join(s.cwd, ".claude", "extensions"))).toBe(false);
    });
  }
});

describe("controls: as before", () => {
  for (const target of TARGETS) {
    it(`${target.rel}: a valid object is merged, keeping the owner's keys`, async () => {
      const s = seat(target, '{ "owner_note": "keep me", "env": { "A": "1" } }');
      const r = await sequence(s);
      expect(r.projection.projected).toContain("spec-fragment");
      expect(r.projection.warnings ?? []).toEqual([]);
      const after = JSON.parse(r.afterProjection!) as Record<string, unknown>;
      expect(after).toMatchObject({ owner_note: "keep me", env: { A: "1" }, [target.key]: target.fragment[target.key as keyof typeof target.fragment] });
    });
    for (const [label, text] of [["missing", null], ["empty", ""], ["whitespace-only", "  \n\t"]] as const) {
      it(`${target.rel}: a ${label} file gets the fragment`, async () => {
        const s = seat(target, text);
        const r = await sequence(s);
        expect(r.projection.projected).toContain("spec-fragment");
        expect(r.projection.warnings ?? []).toEqual([]);
        expect(JSON.parse(r.afterProjection!)).toEqual(target.fragment);
      });
    }
    it(`${target.rel}: a fragment that isn't a JSON object still fails its entry, as before`, async () => {
      const s = seat(target, '{ "owner_note": "keep me" }', "[]");
      const r = await s.adapter.project(s.plan, s.binding);
      expect(r.failed).toEqual([{ effectiveId: "spec-fragment", error: `${s.fragmentPath} must be a JSON object` }]);
      expect(s.read()).toBe('{ "owner_note": "keep me" }');
    });
  }

  it("the collector still installs its status line into a settings file that holds an object", async () => {
    const s = seat(TARGETS[0], '{ "owner_note": "keep me" }');
    const r = await sequence(s);
    expect(JSON.parse(r.afterStartup!)).toMatchObject({ owner_note: "keep me", permissions: { allow: ["Bash(npm test:*)"] }, statusLine: { type: "command" } });
  });
});
