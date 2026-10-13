import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { AgyResumeAdapter } from "../src/adapters/agy-resume.js";
import { AgyRuntimeAdapter, defaultCaptureAgyConversationId, type AgyAdapterFsOps } from "../src/adapters/agy-runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
}) {
  const tmux = {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "agy"),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => "Antigravity CLI\nagy> Ready"),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => true,
  } as unknown as TmuxAdapter;
  return mockShellCommand(tmux);
}

function mockFs(files?: Record<string, string>): AgyAdapterFsOps & { _store: Record<string, string> } {
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
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  };
}

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1",
    nodeId: "n1",
    tmuxSession: "r01-dev",
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: "",
    cwd,
  };
}

describe("AgyResumeAdapter", () => {
  describe("canResume", () => {
    it("agy_id + token -> true", () => {
      const adapter = new AgyResumeAdapter(mockTmux());
      expect(adapter.canResume("agy_id", "conv-123")).toBe(true);
    });

    it("agy_id without token -> false", () => {
      const adapter = new AgyResumeAdapter(mockTmux());
      expect(adapter.canResume("agy_id", null)).toBe(false);
    });

    it("cross-harness (codex_id or claude_id) -> false", () => {
      const adapter = new AgyResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", "conv-123")).toBe(false);
      expect(adapter.canResume("claude_id", "conv-123")).toBe(false);
    });
  });

  describe("resume", () => {
    it("launches agy with conversation token and posture", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new AgyResumeAdapter(tmux, { pollMs: 10, maxWaitMs: 100 });

      const result = await adapter.resume("test-sess", "agy_id", "conv-456", "/project", "gemini-2.5-flash", "full_bypass");
      expect(result.ok).toBe(true);
      expect(sendText).toHaveBeenCalled();
      const sentCmd = sendText.mock.calls[0]![1];
      expect(sentCmd).toContain("agy");
      expect(sentCmd).toContain("--dangerously-skip-permissions");
      expect(sentCmd).toContain("--model 'gemini-2.5-flash'");
      expect(sentCmd).toContain("--conversation 'conv-456'");
    });

    it("returns error if canResume fails", async () => {
      const adapter = new AgyResumeAdapter(mockTmux());
      const result = await adapter.resume("test-sess", "claude_id", "conv-456", "/project");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("no_resume");
    });

    it("returns error if sendShellCommand fails", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, message: "tmux died" }));
      const tmux = mockTmux({ sendText });
      const adapter = new AgyResumeAdapter(tmux);

      const result = await adapter.resume("test-sess", "agy_id", "conv-456", "/project");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("resume_failed");
    });
  });
});

describe("AgyRuntimeAdapter", () => {
  describe("launchHarness", () => {
    it("builds fresh launch command with model and permissions bypass", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new AgyRuntimeAdapter({
        tmux,
        fsOps: mockFs(),
      });

      const binding = makeBinding("/workspace");
      binding.model = "gemini-2.5-pro";
      binding.launchPosture = "full_bypass";

      const launch = await adapter.launchHarness(binding, { name: "dev-owner" });

      expect(launch.ok).toBe(true);
      expect(sendText).toHaveBeenCalled();
      const sentCmd = sendText.mock.calls[0]![1];
      expect(sentCmd).toContain("agy");
      expect(sentCmd).toContain("--dangerously-skip-permissions");
      expect(sentCmd).toContain("--model 'gemini-2.5-pro'");
      expect(launch.appliedLaunch).toEqual({
        runtime: "agy",
        axis: "permission",
        state: "observed",
        value: "bypassPermissions",
        reason: "emitted_launch_arguments",
      });
    });

    it("builds resume launch command if resumeToken is provided", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new AgyRuntimeAdapter({
        tmux,
        fsOps: mockFs(),
      });

      const binding = makeBinding("/workspace");
      binding.model = "gemini-2.5-flash";
      binding.launchPosture = "floor";

      const launch = await adapter.launchHarness(binding, {
        name: "dev-owner",
        resumeToken: "token-999",
      });

      expect(launch.ok).toBe(true);
      expect(sendText).toHaveBeenCalled();
      const sentCmd = sendText.mock.calls[0]![1];
      expect(sentCmd).toContain("agy");
      expect(sentCmd).toContain("--conversation 'token-999'");
    });
  });

  describe("project", () => {
    it("projects guidance and instructions into AGENTS.md", async () => {
      const fsOps = mockFs({
        "/specs/role.md": "Be thorough and write good tests.",
      });
      const adapter = new AgyRuntimeAdapter({
        tmux: mockTmux(),
        fsOps,
      });

      const binding = makeBinding("/workspace");
      const plan: ProjectionPlan = {
        binding,
        entries: [
          {
            category: "guidance",
            effectiveId: "openrig-guidance",
            absolutePath: "/specs/role.md",
            targetPath: "/workspace/AGENTS.md",
            content: "Be thorough and write good tests.",
            mode: "merge_managed_block",
            blockId: "openrig-guidance",
            mergeStrategy: "managed_block",
            classification: "overwrite",
          },
        ],
      };

      const result = await adapter.project(plan, binding);
      expect(result.projected).toContain("openrig-guidance");
      expect(fsOps._store["/workspace/AGENTS.md"]).toContain("Be thorough and write good tests.");
    });
  });

  describe("deliverStartup", () => {
    it("delivers text guidance via tmux sendText", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const fsOps = mockFs({
        "/workspace/guidance/role.md": "You are the project owner.",
      });
      const adapter = new AgyRuntimeAdapter({
        tmux,
        fsOps,
      });

      const files: ResolvedStartupFile[] = [
        {
          path: "guidance/role.md",
          absolutePath: "/workspace/guidance/role.md",
          deliveryHint: "send_text",
          required: true,
        },
      ];

      const binding = makeBinding("/workspace");
      const result = await adapter.deliverStartup(files, binding);
      expect(result.delivered).toBe(1);
      expect(sendText).toHaveBeenCalled();
    });
  });

  describe("checkReady", () => {
    it("reports ready when agy TUI prompt is visible", async () => {
      const adapter = new AgyRuntimeAdapter({
        tmux: mockTmux({
          capturePaneContent: async () => "Antigravity CLI\nagy> Hello",
        }),
        fsOps: mockFs(),
      });

      const readiness = await adapter.checkReady(makeBinding());
      expect(readiness.ready).toBe(true);
    });
  });

  describe("defaultCaptureAgyConversationId", () => {
    it("reads conversation_id for workspace from sqlite db", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "openrig-agy-test-"));
      const dbPath = join(tmpDir, "conversation_summaries.db");

      try {
        const db = new Database(dbPath);
        db.exec(`
          CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            last_modified_time TEXT,
            workspace_uris TEXT,
            title TEXT
          );
          INSERT INTO conversation_summaries VALUES
            ('conv-aaa', '2026-10-01T20:00:00Z', '["file:///other/path"]', 'Other project'),
            ('conv-bbb', '2026-10-01T21:00:00Z', '["file:///workspace/my-project"]', 'My project');
        `);
        db.close();

        const convId = defaultCaptureAgyConversationId(
          dbPath,
          "/workspace/my-project",
        );
        expect(convId).toBe("conv-bbb");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
