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
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";

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
});
