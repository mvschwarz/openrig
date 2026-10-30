import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { PiCommunityRuntimeAdapter } from "../src/adapters/pi-community-runtime-adapter.js";
import { withCommunityHarnesses, seatAdapter, withCommunityHarnessResolver } from "../src/adapters/community-harness-runtime-adapter.js";
import { piSeatPaths, buildPendingRunnerState } from "../src/adapters/pi-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-community-test-"));
  const presetsDir = join(root, "community-harnesses");
  const stateRoot = join(root, "state", "pi");
  const files: Record<string, string> = {};

  const fsOps = {
    readFile: (p: string) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    writeFile: (p: string, c: string) => { files[p] = c; },
    exists: (p: string) => p in files,
    mkdirp: (_p: string) => {},
    listFiles: (_dir: string) => [] as string[],
    statMode: (_p: string) => 0o644,
    chmod: (_p: string, _m: number) => {},
  };

  const tmux = {
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "node"),
    sendShellCommand: vi.fn(async () => ({ ok: true as const, code: "ok" })),
    capturePaneContent: vi.fn(async () => "[pi-runner] READY"),
    listPanes: vi.fn(async () => [{ id: "%1" }]),
  };

  const piAdapter = new PiRuntimeAdapter({
    tmux: tmux as any,
    fsOps,
    stateRoot,
    runnerEntryPath: "/dist/adapters/pi-runner.js",
    trustPosture: "no-approve",
    sleep: async () => {},
    newLaunchId: () => "test-launch-id-1",
  });

  return {
    root,
    presetsDir,
    stateRoot,
    files,
    fsOps,
    tmux,
    piAdapter,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("PiCommunityRuntimeAdapter", () => {
  it("resolves through withCommunityHarnesses when protocol: pi-rpc is declared", () => {
    const f = makeFixture();
    try {
      const dir = f.presetsDir;
      const omoYaml = "format: 1\nname: omo\ncommand: omo\nmaintainer: OmO Team\nlimits: []\nprotocol: pi-rpc\n";
      const { mkdirSync } = require("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "omo.yaml"), omoYaml);

      const map = withCommunityHarnesses({ pi: f.piAdapter }, { tmux: f.tmux as any, presetsDir: () => dir, piAdapter: f.piAdapter });
      const adapter = map["omo"];
      expect(adapter).toBeInstanceOf(PiCommunityRuntimeAdapter);
      expect(adapter?.runtime).toBe("omo");
      expect((adapter as PiCommunityRuntimeAdapter).communityHarness).toBe("omo");
    } finally {
      f.cleanup();
    }
  });

  it("launches harness via pi-runner with --command and captures session token", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      expect(adapter.runtime).toBe("omo");

      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFile = join(paths.sessionsDir, "0197-test.jsonl");

      // Simulate pi-runner writing ready sidecar upon launch
      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({
          ready: true,
          launchId: "test-launch-id-1",
          sessionFile,
          updatedAt: new Date().toISOString(),
        });
        f.files[sessionFile] = '{"type":"session_start"}';
        return { ok: true, code: "ok" };
      });

      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
        model: "anthropic/claude-3-5-sonnet",
        effort: "high",
        launchGeneration: "gen-1",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resumeToken).toBe(sessionFile);
        expect(result.resumeType).toBe("community:omo");
      }

      // Verify the command typed into tmux pane
      expect(f.tmux.sendShellCommand).toHaveBeenCalled();
      const sentCmd = f.tmux.sendShellCommand.mock.calls[0]![1];
      expect(sentCmd).toContain("--command 'omo'");
      expect(sentCmd).toContain("--session-name 'omo-seat@rig'");
      expect(sentCmd).toContain("--no-approve");
      expect(sentCmd).toContain("--model 'anthropic/claude-3-5-sonnet'");
      expect(sentCmd).toContain("--thinking 'high'");
    } finally {
      f.cleanup();
    }
  });

  it("resumes an existing session via --session and returns community:<runtime>", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFile = join(paths.sessionsDir, "0197-test.jsonl");
      f.files[sessionFile] = '{"type":"session_start"}';

      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({
          ready: true,
          launchId: "test-launch-id-1",
          sessionFile,
          updatedAt: new Date().toISOString(),
        });
        return { ok: true, code: "ok" };
      });

      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
        launchGeneration: "gen-2",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName, resumeToken: sessionFile });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resumeToken).toBe(sessionFile);
        expect(result.resumeType).toBe("community:omo");
      }

      const sentCmd = f.tmux.sendShellCommand.mock.calls[0]![1];
      expect(sentCmd).toContain(`--session '${sessionFile}'`);
    } finally {
      f.cleanup();
    }
  });

  it("fails resume honestly when the session file is missing (retry_fresh)", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const sessionFile = "/state/pi/omo-seat@rig/sessions/missing.jsonl";

      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName, resumeToken: sessionFile });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        recovery: "retry_fresh",
        missingConversation: true,
      });
      expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("checks readiness through runner sidecar and pane markers", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
      };

      // Not ready when sidecar is missing
      f.tmux.capturePaneContent.mockResolvedValueOnce("");
      expect(await adapter.checkReady(binding)).toMatchObject({ ready: false });

      // Ready when sidecar is ready
      f.files[paths.runnerStatePath] = JSON.stringify({
        ready: true,
        updatedAt: new Date().toISOString(),
      });
      expect(await adapter.checkReady(binding)).toEqual({ ready: true });

      // Not ready when exited
      f.files[paths.runnerStatePath] = JSON.stringify({
        ready: false,
        updatedAt: new Date().toISOString(),
        exited: { code: 1, at: new Date().toISOString() },
      });
      expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
    } finally {
      f.cleanup();
    }
  });
});
