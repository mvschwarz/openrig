// OPR activity-hook r3 — Claude managed activity-hook DELIVERY pins.
//
// SUPERSEDES the `activity-hook-rip-proof.test.ts` no-injection pins: post-rip
// the OLD ad-hoc `deliverStartup` injection was ripped; r3 RE-introduces activity
// hooks as a MANAGED, reconciled projection driven from the always-run
// `ClaudeCodeAdapter.project()` seam (NOT `deliverStartup`, NOT the old
// provisionActivityHooks/upsertCommandHook path — those banned names stay gone).
//
// The always-run seam is load-bearing (r3 correction): `project()` iterates
// `plan.entries` unconditionally, so DISABLE (strip owned entries) is
// production-reachable even when a profile REMOVES the resource and no entry is
// emitted. ENABLE fires when a `claude_activity_hooks` runtime_resource entry is
// present. Exactly 4 relay events; owned entries recognised by the OpenRig relay
// script path; user hooks always preserved.

import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";

const CWD = "/project";
const RELAY_SRC = "/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const RELAY_DEST = "/project/.openrig/hooks/scripts/activity-relay.cjs";
const SETTINGS = "/project/.claude/settings.local.json";
// The concrete, absolute, shell-quoted leg-B firing shape — never ${CLAUDE_PLUGIN_ROOT}.
const OWNED_CMD = `node "${RELAY_DEST}"`;
// Ownership marker: any command referencing the OpenRig-owned relay script path,
// so a changed absolute prefix is still recognised + replaced (not duplicated).
const OWNED_MARKER = ".openrig/hooks/scripts/activity-relay.cjs";
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification"] as const;

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

function makeAdapter(fs: ClaudeAdapterFsOps) {
  // activityRelayPath is the DI source of the relay asset (parity with the Codex
  // adapter's `activityRelayPath` wired at startup.ts).
  return new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY_SRC } as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
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

/** All command strings in a settings.local hooks block, flattened. */
function allCommands(settings: Record<string, any>): string[] {
  const out: string[] = [];
  const hooks = settings.hooks ?? {};
  for (const groups of Object.values(hooks) as any[]) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) if (typeof h.command === "string") out.push(h.command);
  }
  return out;
}

describe("Claude activity-hook delivery — ENABLE (claude_activity_hooks entry present)", () => {
  it("copies the relay to <cwd>/.openrig/hooks/scripts/ at mode 0755", async () => {
    const fs = mockFs({ [RELAY_SRC]: "// relay" }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(fs._store[RELAY_DEST]).toBe("// relay");
    expect(fs._modes[RELAY_DEST]! & 0o777).toBe(0o755);
  });

  it("upserts the owned relay command for exactly the 4 relay events with the concrete absolute command", async () => {
    const fs = mockFs({ [RELAY_SRC]: "// relay" }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const settings = readSettings(fs);
    for (const ev of EVENTS) {
      const cmds = (settings.hooks?.[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(cmds).toContain(OWNED_CMD);
    }
    // The owned command is the concrete absolute path — never the plugin-root token.
    expect(JSON.stringify(settings.hooks)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("injects NO compaction hooks (PreCompact/PostCompact/compaction-restore-bridge)", async () => {
    const fs = mockFs({ [RELAY_SRC]: "// relay" }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const settings = readSettings(fs);
    expect(settings.hooks?.PreCompact).toBeUndefined();
    expect(settings.hooks?.PostCompact).toBeUndefined();
    expect(JSON.stringify(settings.hooks ?? {})).not.toContain("compaction-restore-bridge");
  });

  it("is idempotent: a second project() adds no duplicate owned entries", async () => {
    const fs = mockFs({ [RELAY_SRC]: "// relay" }, { [RELAY_SRC]: 0o755 });
    const adapter = makeAdapter(fs);
    await adapter.project(plan([activityEntry()]), binding());
    const once = fs._store[SETTINGS];
    await adapter.project(plan([activityEntry()]), binding());
    expect(fs._store[SETTINGS]).toBe(once);
    // exactly one owned command per event (4 total), no duplicates.
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER)).length).toBe(EVENTS.length);
  });

  it("preserves pre-existing user hooks while adding the owned entry", async () => {
    const user = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }] } });
    const fs = mockFs({ [RELAY_SRC]: "// relay", [SETTINGS]: user }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const cmds = allCommands(readSettings(fs));
    expect(cmds).toContain("node ./my-stop-hook.cjs"); // user hook untouched
    expect(cmds).toContain(OWNED_CMD); // owned added alongside
  });

  it("replaces a stale owned entry at a CHANGED relay path (no duplicate)", async () => {
    const stale = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "/old/prefix/${OWNED_MARKER}"`, timeout: 5 }] }] } });
    const fs = mockFs({ [RELAY_SRC]: "// relay", [SETTINGS]: stale }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const stopCmds = (readSettings(fs).hooks?.Stop ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
    const owned = stopCmds.filter((c: string) => c.includes(OWNED_MARKER));
    expect(owned).toEqual([OWNED_CMD]); // exactly one, at the new path
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
    const fs = mockFs({ [SETTINGS]: seededManaged() });
    // A plan with zero activity-hook entries — the profile removed the resource.
    await makeAdapter(fs).project(plan([]), binding());
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
  });

  it("prunes emptied event containers after stripping", async () => {
    const fs = mockFs({ [SETTINGS]: seededManaged() });
    await makeAdapter(fs).project(plan([]), binding());
    const settings = readSettings(fs);
    for (const ev of EVENTS) expect(settings.hooks?.[ev]).toBeUndefined();
  });

  it("strips ONLY owned entries and preserves user hooks on disable", async () => {
    const fs = mockFs({ [SETTINGS]: seededManaged({ Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }] }) });
    await makeAdapter(fs).project(plan([]), binding());
    const cmds = allCommands(readSettings(fs));
    expect(cmds).toContain("node ./my-stop-hook.cjs"); // user hook survives
    expect(cmds.filter((c) => c.includes(OWNED_MARKER))).toEqual([]); // owned gone
  });
});
