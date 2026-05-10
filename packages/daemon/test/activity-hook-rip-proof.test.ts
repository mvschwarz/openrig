// Test suite for plugin-primitive Phase 3a slice 3.1 — activity-hook
// injection rip-proof. Per velocity-guard cadence boundary (d) Checkpoint
// D.2 2026-05-10. Negative assertions: after rip, deliverStartup MUST
// NOT write OpenRig activity-hook content to provider config locations.
//
// What's gone:
//   - .openrig/activity-hook-relay.cjs file at project cwd
//   - OpenRig-injected entries in .claude/settings.local.json hooks block
//     (any pre-existing user-authored hooks STAY untouched)
//   - .codex/hooks.json with OpenRig SessionStart/UserPromptSubmit/Stop
//     (file may not even exist; if it does, OpenRig doesn't write to it)
//   - activityHookRelayAssetPath constructor option no longer accepted
//
// What stays:
//   - /api/activity/hooks endpoint (plugin-shipped hooks consume it post-3.2)
//   - User-authored existing hooks in settings.local.json — UNTOUCHED
//   - upsertCodexHooksFeature TOML helper — slice 3.5 ensureCodexFeatureFlag uses it

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/types.js";

function mockTmux() {
  return {
    sessionExists: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePaneContent: vi.fn().mockResolvedValue(""),
    getPaneCommand: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    runCommandInSession: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

function mockClaudeFs(files?: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as ClaudeAdapterFsOps & { _store: Record<string, string> };
}

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

describe("Activity-hook injection rip-proof — Claude Code adapter", () => {
  it("HG-1.5 — deliverStartup does NOT create .openrig/activity-hook-relay.cjs at project cwd", async () => {
    const fs = mockClaudeFs();
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    expect(fs._store["/project/.openrig/activity-hook-relay.cjs"]).toBeUndefined();
  });

  it("HG-1.5 — deliverStartup does NOT add OpenRig-injected hook entries to settings.local.json", async () => {
    const fs = mockClaudeFs();
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    const settings = fs._store["/project/.claude/settings.local.json"];
    if (settings !== undefined) {
      const parsed = JSON.parse(settings);
      // If settings.local.json is created/touched at all, its hooks block must
      // not contain references to activity-hook-relay.cjs (the OpenRig-injected
      // command).
      const hookJson = JSON.stringify(parsed.hooks ?? {});
      expect(hookJson).not.toContain("activity-hook-relay");
    }
  });

  it("HG-1.5 — pre-existing user-authored hooks in settings.local.json are PRESERVED untouched", async () => {
    const userHooks = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }],
      },
    });
    const fs = mockClaudeFs({ "/project/.claude/settings.local.json": userHooks });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    // User's pre-existing Stop hook is still there (post-rip OpenRig doesn't
    // mutate the hooks block at all).
    const after = JSON.parse(fs._store["/project/.claude/settings.local.json"]!);
    const hookJson = JSON.stringify(after.hooks);
    expect(hookJson).toContain("node ./my-stop-hook.cjs");
    // OpenRig-injected entries are NOT added
    expect(hookJson).not.toContain("activity-hook-relay");
  });

  it("HG-1.6 — Claude adapter source no longer references provisionActivityHooks / upsertCommandHook / activityHookRelayAssetPath / openrig-activity-hook-relay", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/adapters/claude-code-adapter.ts"), "utf-8");
    expect(src).not.toMatch(/provisionActivityHooks/);
    expect(src).not.toMatch(/upsertCommandHook/);
    expect(src).not.toMatch(/hookEntryContainsCommand/);
    expect(src).not.toMatch(/activityHookRelayAssetPath/);
    expect(src).not.toMatch(/openrig-activity-hook-relay/);
  });
});

describe("Activity-hook injection rip-proof — Codex adapter", () => {
  it("HG-1.5 — deliverStartup does NOT create .openrig/activity-hook-relay.cjs at project cwd", async () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    expect(fs._store["/project/.openrig/activity-hook-relay.cjs"]).toBeUndefined();
  });

  it("HG-1.5 — deliverStartup does NOT write OpenRig-injected events to .codex/hooks.json at project cwd", async () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    // The .codex/hooks.json file at the project cwd should not be created
    // by deliverStartup (post-rip). Pre-rip, this file got SessionStart +
    // UserPromptSubmit + Stop entries pointing at the relay script.
    expect(fs._store["/project/.codex/hooks.json"]).toBeUndefined();
  });

  it("HG-1.6 — Codex adapter source no longer references provisionActivityHooks / upsertCommandHook / activityHookRelayAssetPath / openrig-activity-hook-relay", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/adapters/codex-runtime-adapter.ts"), "utf-8");
    expect(src).not.toMatch(/provisionActivityHooks/);
    expect(src).not.toMatch(/upsertCommandHook/);
    expect(src).not.toMatch(/hookEntryContainsCommand/);
    expect(src).not.toMatch(/activityHookRelayAssetPath/);
    expect(src).not.toMatch(/openrig-activity-hook-relay/);
    // upsertCodexHooksFeature STAYS — slice 3.5 ensureCodexFeatureFlag uses it
    expect(src).toMatch(/upsertCodexHooksFeature/);
  });
});

describe("Activity-hook injection rip-proof — endpoint discipline", () => {
  it("/api/activity/hooks endpoint stays in source (plugin-shipped hooks will consume it post-3.2)", async () => {
    // Documentation-of-intent regression lock: the endpoint is intentionally
    // KEPT during the rip per IMPL-PRD §1 + DESIGN.md §3. Plugin-shipped
    // hooks (slice 3.2) will POST to this endpoint for activity tracking.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const activityRoutesFile = path.resolve(import.meta.dirname, "../src/routes/activity.ts");
    const content = fs.readFileSync(activityRoutesFile, "utf-8");
    // Endpoint registers POST /hooks (mounted under /api/activity/ in the app)
    expect(content).toMatch(/activityRoutes\.post\(\s*["']\/hooks["']/);
  });
});
