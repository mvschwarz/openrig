import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// OPR.0.4.8.2 — agnostic permission RIP-OUT (founder-locked; rip-list = ASSESSMENT sha 5d450fdd).
// Strips the three OpenRig-baked CONFIG-FILE policy writes beyond the floor: C1b (fragment
// permissions.allow), C1c (fragment permissions.ask), C2 (provisionRigPermissions global allow).
// KEEPS the usability floor byte-identical (fragment defaultMode=acceptEdits + the
// --permission-mode acceptEdits launch flag). Two-surface rule: config-file writes go, launch-flag
// floor stays. RED-first: the rip assertions FAIL on f81018fb (which ships allow/ask + rig allow).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENT_PATH = path.join(__dirname, "../specs/agents/shared/runtime/claude-settings.fragment.json");

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockFs(files?: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => {
      if (p in store) return store[p]!;
      throw new Error(`Not found: ${p}`);
    },
    writeFile: (p: string, c: string) => {
      store[p] = c;
    },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  } as ClaudeAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1",
    nodeId: "n1",
    tmuxSession: "r01-impl",
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: "",
    cwd,
  };
}

describe("OPR.0.4.8.2 agnostic rip-out — config-file policy writes stripped, launch-flag floor kept", () => {
  it("C1b/C1c: the shipped fragment carries NO permissions.allow / ask / deny", () => {
    const frag = JSON.parse(fs.readFileSync(FRAGMENT_PATH, "utf8"));
    expect(frag.permissions.allow).toBeUndefined();
    expect(frag.permissions.ask).toBeUndefined();
    expect(frag.permissions.deny).toBeUndefined();
  });

  it("floor KEPT: fragment permissions.defaultMode is exactly acceptEdits (+ mcp servers untouched)", () => {
    const frag = JSON.parse(fs.readFileSync(FRAGMENT_PATH, "utf8"));
    expect(Object.keys(frag.permissions)).toEqual(["defaultMode"]); // ONLY the floor key remains
    expect(frag.permissions.defaultMode).toBe("acceptEdits");
    expect(frag.enabledMcpjsonServers).toEqual(["exa", "context7"]);
  });

  it("C2: a fresh startup authors NO ~/.claude/settings.json for permissions", async () => {
    const fsm = mockFs({});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fsm, homedir: "/home/test" } });
    await adapter.deliverStartup([], makeBinding());
    // Post-rip: nothing authored solely for permissions. (Trust/onboarding write ~/.claude.json,
    // not settings.json.)
    expect(fsm._store["/home/test/.claude/settings.json"]).toBeUndefined();
  });

  it("NO retro-scrub: a pre-existing provenance-marked settings.json is left BYTE-IDENTICAL", async () => {
    // NOTE: no Bash(rig:*) here — so the pre-rip code WOULD add it and rewrite (that is the RED).
    const existing = JSON.stringify(
      { permissions: { allow: ["Bash(npm:*)"] }, _openrig_provenance: { author: "openrig-at-spawn", baseline: "convenience" } },
      null,
      2,
    );
    const fsm = mockFs({ "/home/test/.claude/settings.json": existing });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fsm, homedir: "/home/test" } });
    await adapter.deliverStartup([], makeBinding());
    expect(fsm._store["/home/test/.claude/settings.json"]).toBe(existing); // byte-identical, untouched
  });

  it("floor launch flag KEPT byte-for-byte: launch command still contains --permission-mode acceptEdits", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sessionIdFactory: () => "11111111-1111-4111-8111-111111111111",
    });
    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });
    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const cmd = sendText.mock.calls[0]?.[1] as string;
    expect(cmd).toContain("--permission-mode acceptEdits");
  });
});
