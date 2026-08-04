// OPR activity-hook r3 — Claude managed activity-hook DELIVERY pins.
//
// COEXISTS with `activity-hook-rip-proof.test.ts` (it does NOT supersede it): the
// rip-proof suite guards the DISTINCT `deliverStartup` seam (old path/name
// `activity-hook-relay`), which stays ripped. This suite pins the r3 MANAGED
// delivery driven from the always-run `ClaudeCodeAdapter.project()` seam.
//
// The always-run seam is load-bearing: `project()` iterates `plan.entries`
// unconditionally, so DISABLE (strip owned entries) is production-reachable even
// when a profile REMOVES the resource and no entry is emitted. ENABLE fires when a
// `claude_activity_hooks` runtime_resource entry is present AND the relay source +
// canonical event manifest are readable. Event vocabulary is DERIVED from the
// canonical `claude.json` (no parallel hand-maintained constant). Ownership is the
// EXACT `node <quoted relay path>` shape (a user command that merely contains the
// path is preserved). Malformed settings are preserved (fail-closed). Missing
// source produces NO dangling commands and NO false projected claim.

import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { planProjection, type ProjectionPlan, type ProjectionEntry } from "../src/domain/projection-planner.js";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import type { RigSpec, RigSpecPod, RigSpecPodMember } from "../src/domain/types.js";
import { resolveAgentRef, type ResolvedAgentSpec } from "../src/domain/agent-resolver.js";

const CWD = "/project";
const RELAY_SRC = "/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const MANIFEST_SRC = "/assets/plugins/openrig-core/hooks/claude.json";
const RELAY_DEST = "/project/.openrig/hooks/scripts/activity-relay.cjs";
const SETTINGS = "/project/.claude/settings.local.json";
// The concrete, absolute, shell-quoted leg-B firing shape — never ${CLAUDE_PLUGIN_ROOT}.
const OWNED_CMD = `node ${shellQuote(RELAY_DEST)}`;
const OWNED_MARKER = ".openrig/hooks/scripts/activity-relay.cjs";
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification"] as const;

// A faithful subset of the canonical claude.json: the 4 relay events (unscoped
// relay group) interleaved with compaction/bridge groups that must be excluded.
const CANONICAL_MANIFEST = JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] },
      { matcher: "compact", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs"', timeout: 5 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] },
      { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs"', timeout: 5 }] },
    ],
    PreCompact: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/claude-compaction-restore/scripts/precompact-hook.mjs"', timeout: 30 }] }],
    PostCompact: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs"', timeout: 5 }] }],
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] }],
    Notification: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] }],
  },
});

type Store = Record<string, string>;
type Modes = Record<string, number>;

function mockFs(files?: Store, modes?: Modes): ClaudeAdapterFsOps & { _store: Store; _modes: Modes } {
  const store: Store = { ...files };
  const modeMap: Modes = { ...modes };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: (src: string, dest: string) => { store[dest] = store[src] ?? ""; if (src in modeMap) modeMap[dest] = modeMap[src]!; },
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    statMode: (p: string) => (p in modeMap ? modeMap[p]! : 0o644),
    chmod: (p: string, m: number) => { modeMap[p] = m; },
    homedir: "/home/test",
    _store: store,
    _modes: modeMap,
  } as ClaudeAdapterFsOps & { _store: Store; _modes: Modes };
}

function mockTmux() {
  return {
    sessionExists: async () => true, sendKeys: async () => {}, capturePaneContent: async () => "",
    getPaneCommand: async () => "", listSessions: async () => [], runCommandInSession: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: async () => {},
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

function makeAdapter(fs: ClaudeAdapterFsOps, relayPath = RELAY_SRC, manifestPath = MANIFEST_SRC) {
  return new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: relayPath, claudeHooksManifestPath: manifestPath } as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
}

/** Enable-ready fs: relay asset (0755) + canonical manifest seeded. */
function enableFs(extra?: Store): ReturnType<typeof mockFs> {
  return mockFs({ [RELAY_SRC]: "// relay", [MANIFEST_SRC]: CANONICAL_MANIFEST, ...extra }, { [RELAY_SRC]: 0o755 });
}

function binding(cwd = CWD): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "t", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd } as NodeBinding;
}

function plan(entries: ProjectionEntry[]): ProjectionPlan {
  return { runtime: "claude-code", cwd: CWD, entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] };
}

function activityEntry(): ProjectionEntry {
  return {
    category: "runtime_resource", effectiveId: "claude-activity-hooks", sourceSpec: "shared",
    sourcePath: "shared/activity", resourcePath: "activity", absolutePath: RELAY_SRC,
    resourceType: "claude_activity_hooks", classification: "safe_projection",
  };
}

function readSettings(fs: ReturnType<typeof mockFs>): Record<string, any> {
  const raw = fs._store[SETTINGS];
  return raw ? JSON.parse(raw) : {};
}

function allCommands(settings: Record<string, any>): string[] {
  const out: string[] = [];
  const hooks = settings.hooks ?? {};
  for (const groups of Object.values(hooks) as any[]) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) if (typeof h.command === "string") out.push(h.command);
  }
  return out;
}

/** settings.local.json pre-seeded with the 4 managed owned entries. */
function seededOwned(): string {
  const hooks: Record<string, any> = {};
  for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: "command", command: OWNED_CMD, timeout: 5 }] }];
  return JSON.stringify({ hooks });
}

// Packaged contract (QA blocker 1f53796c): the projected relay must be 0755, and production
// PRESERVES the source mode (no adapter chmod policy). So the SHIPPED asset itself must be
// executable — this regression STATS the real committed asset, not a synthetic 0o755 fixture.
describe("Claude activity-hook delivery — shipped relay asset executable mode (0755 contract)", () => {
  it("the committed activity-relay.cjs asset is executable 0755 (so the preserved projection meets the contract)", () => {
    const assetPath = pathResolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const mode = statSync(assetPath).mode & 0o777;
    expect(mode & 0o111, `shipped relay mode is 0${mode.toString(8)}, expected executable`).not.toBe(0);
    expect(mode, `shipped relay mode is 0${mode.toString(8)}, expected 0755`).toBe(0o755);
  });
});

describe("Claude activity-hook delivery — ENABLE (entry present, source + manifest readable)", () => {
  it("copies the relay to <cwd>/.openrig/hooks/scripts/ at mode 0755", async () => {
    const fs = enableFs();
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(fs._store[RELAY_DEST]).toBe("// relay");
    expect(fs._modes[RELAY_DEST]! & 0o777).toBe(0o755);
  });

  it("upserts the owned relay command for exactly the 4 relay events with the concrete absolute command", async () => {
    const fs = enableFs();
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const settings = readSettings(fs);
    for (const ev of EVENTS) {
      const cmds = (settings.hooks?.[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(cmds).toContain(OWNED_CMD);
    }
    expect(JSON.stringify(settings.hooks)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("injects NO compaction hooks (PreCompact/PostCompact/compaction-restore-bridge)", async () => {
    const fs = enableFs();
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const settings = readSettings(fs);
    expect(settings.hooks?.PreCompact).toBeUndefined();
    expect(settings.hooks?.PostCompact).toBeUndefined();
    expect(JSON.stringify(settings.hooks ?? {})).not.toContain("compaction-restore-bridge");
  });

  it("derives the injected events from the canonical claude.json manifest (no hardcoded event set)", async () => {
    // A manifest where ONLY Stop references the relay → only Stop is injected.
    const onlyStop = JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 9 }] }],
      PreCompact: [{ hooks: [{ type: "command", command: "node bridge.cjs" }] }],
    } });
    const fs = mockFs({ [RELAY_SRC]: "// relay", [MANIFEST_SRC]: onlyStop }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(Object.keys(readSettings(fs).hooks)).toEqual(["Stop"]);
  });

  it("is idempotent: a second project() adds no duplicate owned entries", async () => {
    const fs = enableFs();
    const adapter = makeAdapter(fs);
    await adapter.project(plan([activityEntry()]), binding());
    const once = fs._store[SETTINGS];
    await adapter.project(plan([activityEntry()]), binding());
    expect(fs._store[SETTINGS]).toBe(once);
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER)).length).toBe(EVENTS.length);
  });

  it("preserves pre-existing user hooks while adding the owned entry", async () => {
    const fs = enableFs({ [SETTINGS]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }] } }) });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const cmds = allCommands(readSettings(fs));
    expect(cmds).toContain("node ./my-stop-hook.cjs");
    expect(cmds).toContain(OWNED_CMD);
  });

  it("replaces a stale owned entry at a CHANGED relay path (no duplicate)", async () => {
    const stale = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${shellQuote(`/old/prefix/${OWNED_MARKER}`)}`, timeout: 5 }] }] } });
    const fs = enableFs({ [SETTINGS]: stale });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const stopCmds = (readSettings(fs).hooks?.Stop ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
    expect(stopCmds.filter((c: string) => c.includes(OWNED_MARKER))).toEqual([OWNED_CMD]);
  });
});

describe("Claude activity-hook delivery — DISABLE via the always-run project() seam", () => {
  function seededManaged(extra?: Record<string, any>) {
    const hooks: Record<string, any> = {};
    for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: "command", command: OWNED_CMD, timeout: 5 }] }];
    if (extra) for (const [k, v] of Object.entries(extra)) hooks[k] = [...(hooks[k] ?? []), ...v];
    return JSON.stringify({ hooks });
  }

  it("strips owned entries when NO claude_activity_hooks entry is present (production-reachable disable)", async () => {
    const fs = enableFs({ [SETTINGS]: seededManaged() });
    await makeAdapter(fs).project(plan([]), binding());
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
  });

  it("prunes emptied event containers after stripping", async () => {
    const fs = enableFs({ [SETTINGS]: seededManaged() });
    await makeAdapter(fs).project(plan([]), binding());
    const settings = readSettings(fs);
    for (const ev of EVENTS) expect(settings.hooks?.[ev]).toBeUndefined();
  });

  it("strips ONLY owned entries and preserves user hooks on disable", async () => {
    const fs = enableFs({ [SETTINGS]: seededManaged({ Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }] }) });
    await makeAdapter(fs).project(plan([]), binding());
    const cmds = allCommands(readSettings(fs));
    expect(cmds).toContain("node ./my-stop-hook.cjs");
    expect(cmds.filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
  });
});

describe("Claude activity-hook delivery — hardening (guard r3 findings)", () => {
  it("EXACT ownership: does NOT strip a user command that merely CONTAINS the relay path", async () => {
    // An echo whose argument contains the marker — NOT the owned `node <path>` shape.
    const userCmd = `echo ${shellQuote(`/somewhere/${OWNED_MARKER}`)}`;
    const fs = enableFs({ [SETTINGS]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: userCmd, timeout: 3 }] }] } }) });
    await makeAdapter(fs).project(plan([]), binding()); // disable path exercises the strip
    expect(allCommands(readSettings(fs))).toContain(userCmd);
  });

  it("FAIL-CLOSED: preserves malformed settings bytes (no clobber to {})", async () => {
    const malformed = "{ broken json";
    const fs = enableFs({ [SETTINGS]: malformed });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(fs._store[SETTINGS]).toBe(malformed);
  });

  it("MISSING SOURCE: writes NO dangling commands and reports the entry skipped, not projected", async () => {
    const fs = mockFs({ [MANIFEST_SRC]: CANONICAL_MANIFEST }, {}); // relay source absent
    const res = await makeAdapter(fs, "/assets/missing-relay.cjs").project(plan([activityEntry()]), binding());
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
    expect(res.projected).not.toContain("claude-activity-hooks");
    expect(res.skipped).toContain("claude-activity-hooks");
  });

  // PREVALIDATE BEFORE MUTATION: a relay source present but a canonical manifest that is
  // missing / malformed / yields zero relay events must NOT strip existing managed hooks,
  // NOT copy the relay, NOT mutate settings, and NOT claim projected/delivered.
  for (const [label, manifest] of [
    ["ABSENT manifest", undefined],
    ["MALFORMED manifest", "{ broken json"],
    ["ZERO-relay-event manifest", JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: "node bridge.cjs" }] }] } })],
  ] as const) {
    it(`${label} on enable: preserves existing managed hooks + settings bytes, no projected claim, no relay copy`, async () => {
      const seeded = seededOwned();
      const files: Store = { [RELAY_SRC]: "// relay", [SETTINGS]: seeded };
      if (manifest !== undefined) files[MANIFEST_SRC] = manifest;
      const fs = mockFs(files, { [RELAY_SRC]: 0o755 });
      const manifestPath = manifest === undefined ? "/assets/missing-manifest.json" : MANIFEST_SRC;
      const res = await makeAdapter(fs, RELAY_SRC, manifestPath).project(plan([activityEntry()]), binding());
      expect(fs._store[SETTINGS]).toBe(seeded); // settings bytes untouched (no strip, no write)
      expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER)).length).toBe(EVENTS.length); // managed hooks preserved
      expect(fs._store[RELAY_DEST]).toBeUndefined(); // relay NOT copied
      expect(res.projected).not.toContain("claude-activity-hooks");
      expect(res.skipped).toContain("claude-activity-hooks");
    });
  }
});

// M1 (R1 verdict): ownership must ROUND-TRIP shellQuote. A cwd containing a legal apostrophe
// (O'Brien) makes shellQuote escape ' as '"'"', which the naive quoted-arg matcher missed —
// so owned hooks accumulated without bound on re-enable and dangled on disable.
describe("Claude activity-hook delivery — ownership round-trips shellQuote (apostrophe cwd)", () => {
  it("cwd with an apostrophe (O'Brien): enable x2 keeps exactly one owned entry/event, disable strips all", async () => {
    const cwd = "/project/O'Brien";
    const settingsPath = `${cwd}/.claude/settings.local.json`;
    const ownedCmd = `node ${shellQuote(`${cwd}/.openrig/hooks/scripts/activity-relay.cjs`)}`;
    const fs = enableFs();
    const adapter = makeAdapter(fs);
    await adapter.project(plan([activityEntry()]), binding(cwd));
    await adapter.project(plan([activityEntry()]), binding(cwd)); // idempotent re-enable
    const enabled = JSON.parse(fs._store[settingsPath]!);
    expect(allCommands(enabled).filter((c) => c === ownedCmd).length, "no unbounded accumulation").toBe(EVENTS.length);
    await adapter.project(plan([]), binding(cwd)); // disable
    const disabled = fs._store[settingsPath] ? JSON.parse(fs._store[settingsPath]!) : {};
    expect(allCommands(disabled).filter((c) => c.includes(OWNED_MARKER)), "no dangling owned hook").toEqual([]);
  });

  it("PRESERVES a user multi-arg command whose LAST arg ends in the relay suffix (not one owned token)", async () => {
    // Both of these are USER commands: node <user-arg> <relay-path>. Neither is a single
    // canonical shellQuote token, so ownership must NOT claim (and delete) them.
    const userSingle = `node 'user-arg' ${shellQuote("/tmp/.openrig/hooks/scripts/activity-relay.cjs")}`;
    const userDouble = `node "user-arg" "/tmp/.openrig/hooks/scripts/activity-relay.cjs"`;
    const seeded = JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: "command", command: userSingle, timeout: 3 },
      { type: "command", command: userDouble, timeout: 3 },
    ] }] } });
    const fs = enableFs({ [SETTINGS]: seeded });
    await makeAdapter(fs).project(plan([]), binding()); // disable exercises the strip
    const cmds = allCommands(readSettings(fs));
    expect(cmds, "single-quoted multi-arg user command preserved").toContain(userSingle);
    expect(cmds, "double-quoted multi-arg user command preserved").toContain(userDouble);
  });
});

// Production-altitude reachability: the ACTUAL SHIPPED profile bytes (development/implementer,
// which selects shared:claude-activity-hooks) must resolve — through the REAL resolveAgentRef ->
// resolveNodeConfig -> planProjection -> adapter — to a plan entry the adapter enables. Loaded
// from disk (not an in-memory AgentSpec) so this pins the shipped selection, not a mirror.
describe("Claude activity-hook — REAL SHIPPED-spec resolver -> planner -> adapter reachability", () => {
  const SHIPPED_SPECS_ROOT = pathResolve(import.meta.dirname, "../specs");
  const realSpecFs = { readFile: (p: string) => readFileSync(p, "utf-8"), exists: (p: string) => existsSync(p) };
  const member = (): RigSpecPodMember => ({ id: "impl", agentRef: "local:agents/development/implementer", profile: "default", runtime: "claude-code", cwd: "." } as RigSpecPodMember);
  const pod = (): RigSpecPod => ({ id: "dev", label: "Dev", members: [member()], edges: [] } as RigSpecPod);
  const rig = (): RigSpec => ({ version: "0.2", name: "test-rig", pods: [pod()], edges: [] } as RigSpec);

  it("the SHIPPED development/implementer profile selects claude_activity_hooks -> plan entry -> adapter ENABLES", async () => {
    // 1. Resolve the ACTUAL shipped agent.yaml + its shared import from disk.
    const rr = resolveAgentRef("local:agents/development/implementer", SHIPPED_SPECS_ROOT, realSpecFs);
    expect(rr.ok, rr.ok ? "" : `resolve failed: ${JSON.stringify(rr)}`).toBe(true);
    if (!rr.ok) return;
    const ctx: ResolutionContext = {
      baseSpec: rr.resolved as ResolvedAgentSpec, importedSpecs: rr.imports, collisions: rr.collisions,
      profileName: "default", member: member(), pod: pod(), rig: rig(),
    };
    // 2. REAL resolver — the shipped selection resolves to a claude_activity_hooks runtime resource.
    const rc = resolveNodeConfig(ctx);
    expect(rc.ok).toBe(true);
    if (!rc.ok) return;
    expect(rc.config.selectedResources.runtimeResources.some((qr) => (qr.resource as { type?: string }).type === "claude_activity_hooks")).toBe(true);
    // 3. REAL planner emits the entry.
    const pr = planProjection({ config: rc.config, collisions: [], fsOps: { readFile: () => "{}", exists: () => true } });
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const entry = pr.plan.entries.find((e) => e.resourceType === "claude_activity_hooks");
    expect(entry, "planner must emit a claude_activity_hooks entry from the shipped spec").toBeDefined();
    expect(entry!.category).toBe("runtime_resource");
    // 4. REAL adapter enables from the REAL plan (skill-entry projection noise is irrelevant —
    //    the always-run reconcile delivers off the manifest DI).
    const fs = enableFs();
    await makeAdapter(fs).project(pr.plan, binding());
    expect(fs._store[RELAY_DEST]).toBe("// relay");
    for (const ev of EVENTS) {
      const cmds = (readSettings(fs).hooks?.[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(cmds).toContain(OWNED_CMD);
    }
  });
});
