import { describe, it, expect, vi, afterEach } from "vitest";
import { yoloEnabled } from "../src/adapters/yolo-mode.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// OPR.0.4.8.2 seam 3 — OpenRig YOLO mode (opt-in, default OFF; launch-flag surface only, zero
// config writes). RED-first: on f81018fb yoloEnabled/the bypass flags don't exist yet.

afterEach(() => {
  delete process.env.OPENRIG_YOLO;
});

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
function mockFs(): ClaudeAdapterFsOps {
  const store: Record<string, string> = {};
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
    listFiles: () => [],
  } as ClaudeAdapterFsOps;
}
function makeBinding(cwd = "/project"): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd };
}
async function claudeLaunchCmd(): Promise<string> {
  const tmux = mockTmux();
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
  await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });
  return (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
}

describe("OPR.0.4.8.2 YOLO mode — opt-in, default OFF, launch-flag surface only", () => {
  it("yoloEnabled: OFF unless OPENRIG_YOLO is explicitly 1/true", () => {
    expect(yoloEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(yoloEnabled({ OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(yoloEnabled({ OPENRIG_YOLO: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(yoloEnabled({ OPENRIG_YOLO: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(yoloEnabled({ OPENRIG_YOLO: "yes" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("Claude: OFF -> floor --permission-mode acceptEdits; ON -> --dangerously-skip-permissions", async () => {
    delete process.env.OPENRIG_YOLO;
    const off = await claudeLaunchCmd();
    expect(off).toContain("--permission-mode acceptEdits");
    expect(off).not.toContain("--dangerously-skip-permissions");

    process.env.OPENRIG_YOLO = "1";
    const on = await claudeLaunchCmd();
    expect(on).toContain("--dangerously-skip-permissions");
    expect(on).not.toContain("--permission-mode acceptEdits");
  });

  it("Codex resume: OFF -> harness-default floor (no bypass); ON -> --dangerously-bypass-approvals-and-sandbox", () => {
    delete process.env.OPENRIG_YOLO;
    const off = buildCodexResumeCore("tok-1", null, false);
    expect(off).toBe("codex resume 'tok-1'");

    process.env.OPENRIG_YOLO = "1";
    const on = buildCodexResumeCore("tok-1", null, false);
    expect(on).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("Codex resume ON overrides even a named config profile (every seat full-bypass)", () => {
    process.env.OPENRIG_YOLO = "1";
    const on = buildCodexResumeCore("tok-1", "my-profile", false);
    expect(on).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(on).not.toContain("-p 'my-profile'");
  });
});
