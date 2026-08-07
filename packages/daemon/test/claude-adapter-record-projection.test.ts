import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// P20 atom 3b — RECORD-AT-APPLY. The discrimination (conflict-detector) and the
// enable path (rigspec-instantiator wiring pin) are inert unless the projector
// actually records what it wrote. This pins the WRITE side: when the adapter
// installs a skill file, it must feed the manifest the exact target + content it
// wrote, so a later projection can classify stale_overwrite vs operator_conflict.
// A drop of the recordProjection call reverts every target to P17-fallback-forever
// (lookup null → hash_conflict), a silent dead invalidator — so this fails RED there.

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
  } as NodeBinding;
}

function skillFile(): ResolvedStartupFile {
  return {
    path: "SKILL.md",
    absolutePath: "/src/skills/my-skill/SKILL.md",
    ownerRoot: "/src",
    deliveryHint: "skill_install",
    required: true,
    appliesOn: ["fresh_start"],
    kind: "file",
  };
}

describe("P20 record-at-apply — the adapter records the manifest on skill_install", () => {
  it("records the exact target path + content it wrote", async () => {
    const CONTENT = "# my-skill\nprojected body v1\n";
    const recorded: Array<{ target: string; content: string }> = [];
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFs({ "/src/skills/my-skill/SKILL.md": CONTENT }),
      recordProjection: (target: string, content: string) => recorded.push({ target, content }),
    });

    await adapter.deliverStartup([skillFile()], makeBinding("/project"));

    expect(recorded).toHaveLength(1);
    // target == the actual write path (cwd/.claude/skills/<skill-dir>/SKILL.md),
    // which is exactly what a later projection will classify.
    expect(recorded[0]!.target).toBe("/project/.claude/skills/my-skill/SKILL.md");
    // content == the bytes written (so hashContent(recorded) == the target's future hash).
    expect(recorded[0]!.content).toBe(CONTENT);
  });

  it("does not record when there is no skill to install (send_text is not a projection)", async () => {
    const recorded: Array<{ target: string; content: string }> = [];
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFs({ "/src/prompt.txt": "hello" }),
      recordProjection: (target: string, content: string) => recorded.push({ target, content }),
    });

    await adapter.deliverStartup(
      [{
        path: "prompt.txt",
        absolutePath: "/src/prompt.txt",
        ownerRoot: "/src",
        deliveryHint: "send_text",
        required: false,
        appliesOn: ["fresh_start"],
        kind: "file",
      }],
      makeBinding("/project"),
    );

    expect(recorded).toHaveLength(0);
  });
});
