import { describe, it, expect, vi, afterEach } from "vitest";
import { yoloEnabled, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
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

  it("Codex resume: OFF -> explicit -s workspace-write floor flag; ON -> -s danger-full-access", () => {
    delete process.env.OPENRIG_YOLO;
    const off = buildCodexResumeCore("tok-1", null, false);
    expect(off).toBe("codex -s workspace-write resume 'tok-1'");

    process.env.OPENRIG_YOLO = "1";
    const on = buildCodexResumeCore("tok-1", null, false);
    expect(on).toContain("-s danger-full-access");
  });

  it("Codex resume ON overrides even a named config profile (every seat -s danger-full-access)", () => {
    process.env.OPENRIG_YOLO = "1";
    const on = buildCodexResumeCore("tok-1", "my-profile", false);
    expect(on).toContain("-s danger-full-access");
    expect(on).not.toContain("-p 'my-profile'");
  });

  // ── The three managed launch paths the fresh-only wiring missed (guard finding) ──

  it("Claude RESTORE (ClaudeResumeAdapter) carries the posture flag: OFF floor / ON bypass", async () => {
    delete process.env.OPENRIG_YOLO;
    const tmuxOff = mockTmux();
    await new ClaudeResumeAdapter(tmuxOff).resume("r01-impl", "claude_name", "my-session", "/repo");
    const off = (tmuxOff.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(off).toContain("--permission-mode acceptEdits");
    expect(off).toContain("--resume 'my-session'");

    process.env.OPENRIG_YOLO = "1";
    const tmuxOn = mockTmux();
    await new ClaudeResumeAdapter(tmuxOn).resume("r01-impl", "claude_name", "my-session", "/repo");
    const on = (tmuxOn.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(on).toContain("--dangerously-skip-permissions");
    expect(on).not.toContain("--permission-mode acceptEdits");
  });

  it("Codex native FORK carries the posture: OFF -s workspace-write / ON -s danger-full-access", async () => {
    const codexFs = {
      readFile: () => { throw new Error("nf"); },
      writeFile: () => {},
      exists: () => false,
      mkdirp: () => {},
      copyFile: () => {},
      listFiles: () => [],
    } as unknown as ConstructorParameters<typeof CodexRuntimeAdapter>[0]["fsOps"];
    const forkOpts = { name: "dev-impl@test-rig", forkSource: { kind: "native_id" as const, value: "parent-123" } };

    delete process.env.OPENRIG_YOLO;
    const tmuxOff = mockTmux();
    await new CodexRuntimeAdapter({ tmux: tmuxOff, fsOps: codexFs }).launchHarness(makeBinding(), forkOpts);
    const off = (tmuxOff.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(off).toContain("fork");
    expect(off).toContain("-s workspace-write");
    expect(off).not.toContain("-s danger-full-access");

    process.env.OPENRIG_YOLO = "1";
    const tmuxOn = mockTmux();
    await new CodexRuntimeAdapter({ tmux: tmuxOn, fsOps: codexFs }).launchHarness(makeBinding(), forkOpts);
    const on = (tmuxOn.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(on).toContain("-s danger-full-access");
    expect(on).toContain("fork");
  });

  it("codexPostureArg: OFF no-profile -> explicit -s workspace-write floor; OFF profile passes through; ON -> -s danger-full-access", () => {
    expect(codexPostureArg(" -p 'x'", {} as NodeJS.ProcessEnv)).toBe(" -p 'x'");
    expect(codexPostureArg("", {} as NodeJS.ProcessEnv)).toBe(" -s workspace-write");
    expect(codexPostureArg(" -p 'x'", { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv)).toBe(" -s danger-full-access");
  });

  it("piTrust (RESOURCE TRUST, not permission policy): OFF keeps configured/no-approve; ON forces approve", () => {
    expect(piTrust("no-approve", {} as NodeJS.ProcessEnv)).toBe("no-approve");
    expect(piTrust(undefined, {} as NodeJS.ProcessEnv)).toBe("no-approve");
    expect(piTrust("approve", {} as NodeJS.ProcessEnv)).toBe("approve");
    expect(piTrust("no-approve", { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv)).toBe("approve");
  });
});
