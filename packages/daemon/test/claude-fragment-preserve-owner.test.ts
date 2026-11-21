// A project's .claude/settings.local.json or .mcp.json that can't be read, or isn't a JSON object (it doesn't parse, or
// it holds an array or a single value), belongs to its owner. Projecting a Claude settings or MCP fragment leaves it as it is,
// reports the fragment skipped with a warning, and doesn't fail the projection; the context collector that runs before
// launch, and again later, leaves it alone too. Valid objects, missing, empty and whitespace-only files behave as
// before. Through the adapter's project(), deliverStartup() and ensureContextCollector(), and StartupOrchestrator.startNode()
// up to the harness launch, with the daemon's real filesystem operations in a temporary seat directory.
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, replaceClaudeFragment } from "../src/adapters/claude-code-adapter.js";
import { replaceFile } from "../src/adapters/replace-file.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";

const roots: string[] = [];
const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  // Give back write and read permission so the temp seat can be removed.
  for (const root of roots.splice(0)) {
    for (const rel of ["seat/.claude/settings.local.json", "seat/.mcp.json"]) { try { fs.chmodSync(nodePath.join(root, rel), 0o700); } catch { /* absent */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SENTENCE = "once the file is fixed, the next fresh launch applies it (resuming or restoring the session doesn't).";

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
    replaceFragment: replaceClaudeFragment,
    homedir: nodePath.join(root, "home"),
  };
  const written = new Map<string, string>();
  const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateDir: nodePath.join(root, "openrig"), collectorAssetPath: asset,
    readProjectionHash: (path: string) => written.get(path) ?? null,
    recordProjection: (path: string, content: string) => written.set(path, createHash("sha256").update(content).digest("hex")),
  });
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

const UNUSABLE: Array<[string, string, string]> = [
  ["truncated JSON", '{ "owner_note": "keep me", "env": { "A": "1" ', "it isn't valid JSON"],
  ["a trailing comma", '{ "owner_note": "keep me", }', "it isn't valid JSON"],
  ["a JSON array", '[ { "owner_note": "keep me" } ]', "it holds a JSON array, not an object"],
  ["a JSON number", "42", "it holds a JSON number, not an object"],
  ["JSON null", "null", "it holds JSON null, not an object"],
  ["a JSON string", '"keep me"', "it holds a JSON string, not an object"],
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
      // A fixed reason: no parser message, which could quote the file.
      expect(r.projection.warnings).toEqual([`Left ${s.targetPath} as it is: ${reason}. The fragment ${s.fragmentPath} wasn't applied; ${SENTENCE}`]);
      // Nothing was copied to the generic extensions directory instead.
      expect(fs.existsSync(nodePath.join(s.cwd, ".claude", "extensions"))).toBe(false);
    });
  }
});

// Mode bits only stop a reader who isn't root, so each case first checks that the file really can't be read.
const UNREADABLE: Array<[string, (p: string) => void]> = [
  ["mode 0200 (write-only)", p => { fs.writeFileSync(p, '{ "owner_note": "keep me" }'); fs.chmodSync(p, 0o200); }],
  ["mode 0000", p => { fs.writeFileSync(p, '{ "owner_note": "keep me" }'); fs.chmodSync(p, 0o000); }],
  ["a directory", p => { fs.mkdirSync(p); fs.writeFileSync(nodePath.join(p, "owner-file"), "keep me"); }],
];

function snapshot(p: string) {
  const st = fs.statSync(p);
  return { dir: st.isDirectory(), mode: st.mode & 0o777, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
}

describe.skipIf(process.getuid?.() === 0)("a project file that can't be read is left as it is", () => {
  for (const target of TARGETS) for (const [label, make] of UNREADABLE) {
    it(`${target.rel} that is ${label}: untouched through projection and both collector calls; the fragment is skipped with a warning`, async () => {
      const s = seat(target, null);
      make(s.targetPath);
      expect(() => fs.readFileSync(s.targetPath, "utf-8")).toThrow();
      const before = snapshot(s.targetPath);
      const projection = await s.adapter.project(s.plan, s.binding);
      expect(snapshot(s.targetPath)).toEqual(before);
      await s.adapter.deliverStartup([], s.binding);
      expect(snapshot(s.targetPath)).toEqual(before);
      try { s.adapter.ensureContextCollector(s.binding); } catch { /* the later poll's caller catches this, as before */ }
      expect(snapshot(s.targetPath)).toEqual(before);
      expect(projection.failed).toEqual([]);
      expect(projection.projected).not.toContain("spec-fragment");
      expect(projection.skipped).toContain("spec-fragment");
      expect(projection.warnings).toEqual([`Left ${s.targetPath} as it is: it couldn't be read. The fragment ${s.fragmentPath} wasn't applied; ${SENTENCE}`]);
      expect(fs.existsSync(nodePath.join(s.cwd, ".claude", "extensions"))).toBe(false);
      if (!before.dir) {
        fs.chmodSync(s.targetPath, 0o600);
        expect(fs.readFileSync(s.targetPath, "utf-8")).toBe('{ "owner_note": "keep me" }');
      } else {
        expect(fs.readdirSync(s.targetPath)).toEqual(["owner-file"]);
      }
    });

    it(`${target.rel} that is ${label}: startNode reaches the harness launch, with the warning in its result`, async () => {
      const s = seat(target, null);
      make(s.targetPath);
      const db = createFullTestDb(); dbs.push(db);
      const rigRepo = new RigRepository(db), rig = rigRepo.createRig("preserve");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: s.cwd });
      const registry = new SessionRegistry(db);
      const session = registry.registerSession(node.id, "dev-impl@preserve");
      const binding = { ...s.binding, nodeId: node.id, tmuxSession: session.sessionName } as NodeBinding;
      const launchHarness = vi.spyOn(s.adapter, "launchHarness").mockResolvedValue({ ok: false, error: "inert boundary" });
      const orchestrator = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter: {} as TmuxAdapter });
      const result = await orchestrator.startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id, binding, adapter: s.adapter,
        plan: s.plan, resolvedStartupFiles: [], startupActions: [], isRestore: false });
      expect(launchHarness).toHaveBeenCalledTimes(1);
      // The only error is the stubbed harness boundary: the skipped fragment didn't fail the start.
      expect(result).toMatchObject({ errors: ["Harness launch failed: inert boundary"],
        warnings: [`Left ${s.targetPath} as it is: it couldn't be read. The fragment ${s.fragmentPath} wasn't applied; ${SENTENCE}`] });
      const st = fs.statSync(s.targetPath);
      expect([st.isDirectory(), st.mode & 0o777]).toEqual(label === "a directory" ? [true, expect.any(Number)] : [false, label === "mode 0000" ? 0 : 0o200]);
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

describe("Claude runtime fragments that follow their sources", () => {
  for (const [target, next] of [
    [TARGETS[0], { env: { FIXTURE_FLAG: "changed" } }],
    [TARGETS[1], { mcpServers: { "spec-server": { command: "changed" } } }],
  ] as const) {
    it(`${target.rel} refreshes its source, and keeps a later operator edit`, async () => {
      const s = seat(target, '{ "owner_note": "keep me" }');
      s.plan.entries[0]!.onRestore = "follow_source";
      await sequence(s);
      fs.writeFileSync(s.fragmentPath, JSON.stringify(next));
      expect(await s.adapter.project(s.plan, s.binding)).toMatchObject({ projected: ["spec-fragment"], failed: [] });
      expect(JSON.parse(s.read()!)).toMatchObject({ owner_note: "keep me", ...next });

      const edited = '{ "owner_note": "operator edit" }\n';
      fs.writeFileSync(s.targetPath, edited);
      const result = await s.adapter.project(s.plan, s.binding);
      expect(result).toMatchObject({ skipped: ["spec-fragment"], failed: [], warnings: [expect.stringContaining("local edits")] });
      expect(s.read()).toBe(edited);
    });

    it(`${target.rel} leaves the old projection intact when a following source is invalid`, async () => {
      const s = seat(target, null);
      s.plan.entries[0]!.onRestore = "follow_source";
      await s.adapter.project(s.plan, s.binding);
      const before = s.read();
      fs.writeFileSync(s.fragmentPath, "[]");
      const result = await s.adapter.project(s.plan, s.binding);
      expect(result).toMatchObject({ skipped: ["spec-fragment"], failed: [], warnings: [expect.stringContaining("source")] });
      expect(s.read()).toBe(before);
    });
  }

  it("keeps an edit protected after a start that needs no fragment update", async () => {
    const s = seat(TARGETS[1], null);
    s.plan.entries[0]!.onRestore = "follow_source";
    await s.adapter.project(s.plan, s.binding);
    const edited = JSON.stringify({ ...TARGETS[1].fragment, owner_note: "editor addition" });
    fs.writeFileSync(s.targetPath, edited);
    expect((await s.adapter.project(s.plan, s.binding)).warnings).toBeUndefined();
    fs.writeFileSync(s.fragmentPath, '{"mcpServers":{"spec-server":{"command":"changed"}}}');
    expect((await s.adapter.project(s.plan, s.binding)).skipped).toEqual(["spec-fragment"]);
    expect(s.read()).toBe(edited);
  });

  it("keeps an unrecorded MCP value and reports why a conflicting selection was skipped", async () => {
    const current = '{ "mcpServers": { "spec-server": { "command": "owner-command" } } }\n';
    const s = seat(TARGETS[1], current);
    s.plan.entries[0]!.onRestore = "follow_source";
    expect(await s.adapter.project(s.plan, s.binding)).toMatchObject({
      skipped: ["spec-fragment"], failed: [], warnings: [expect.stringContaining("no write record")],
    });
    expect(s.read()).toBe(current);
  });

  it("leaves a linked MCP target intact when the opted-in projection cannot replace it", async () => {
    const s = seat(TARGETS[1], null);
    const linked = nodePath.join(nodePath.dirname(s.cwd), "shared-mcp.json");
    fs.writeFileSync(linked, "{}");
    fs.symlinkSync(linked, s.targetPath);
    s.plan.entries[0]!.onRestore = "follow_source";
    expect(await s.adapter.project(s.plan, s.binding)).toMatchObject({
      skipped: ["spec-fragment"], failed: [], warnings: [expect.stringContaining("couldn't be written safely")],
    });
    expect(fs.readFileSync(linked, "utf8")).toBe("{}");
    expect(fs.lstatSync(s.targetPath).isSymbolicLink()).toBe(true);
  });
});
