// The Codex resume command OpenRig prints for a person recovering a seat (`rig ps --nodes` resumeCommand and the
// node detail's recovery guidance) keeps the --no-daemon choice the seat's last managed launch positively made.
// That choice rides the existing launch-fact record. A choice that was never recorded stays unknown: the old
// command, plus a note saying so. A legacy choice (no --no-daemon) prints the old command unchanged.
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeCodexSandbox, type AppliedLaunchObservation } from "../src/domain/permission-drift.js";
import { getNodeDetail, getNodeInventory } from "../src/domain/node-inventory.js";
import { buildCodexResumeCore, buildNativeResumeCommand } from "../src/domain/native-resume-probe.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { CodexDaemonSupport, CodexDaemonSupportDetector } from "../src/domain/codex-daemon-support.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// No real Codex, shell or tmux runs here.
const processMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execSync: vi.fn<() => string>(() => { throw new Error("Unexpected synchronous process execution"); }),
}));
// Only the process launchers are replaced; the rest of the module stays real for imports that bind it at load.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()), execFile: processMocks.execFile, execSync: processMocks.execSync,
}));

const NOT_RECORDED = "Not recorded whether this seat's last managed launch used --no-daemon. If `codex --help` lists --no-daemon, "
  + "add it right after `codex`, as the managed launch does.";
const codexFloor = observeCodexSandbox("-s workspace-write");
const withChoice = (daemonOptOut: boolean) => ({ ...codexFloor, daemonOptOut }) as AppliedLaunchObservation;

describe("the printed Codex resume command", () => {
  it("adds --no-daemon right after codex only for a positively recorded opt-out", () => {
    const old = buildCodexResumeCore("sess 456", null);
    expect(old).toBe("codex -s workspace-write resume 'sess 456'");
    const build = buildNativeResumeCommand as (...args: unknown[]) => string | null;
    expect(build("codex", "sess 456", null, null)).toBe(old);
    expect(build("codex", "sess 456", null, null, false)).toBe(old);
    expect(build("codex", "sess 456", null, null, true)).toBe("codex --no-daemon -s workspace-write resume 'sess 456'");
    expect(build("codex", "sess 456", null, "profile's name", true))
      .toBe(buildCodexResumeCore("sess 456", "profile's name").replace(/^codex /, "codex --no-daemon "));
    // Claude's command has no daemon choice.
    expect(build("claude-code", "tok", "dev-impl@r1", null, true)).toBe(buildNativeResumeCommand("claude-code", "tok", "dev-impl@r1"));
  });
});

describe("the launch-fact record keeps a Codex launch's daemon choice", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let store: AppliedLaunchObservationStore;

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r1");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("node-1", "rig-1", "dev.qa", "worker", "codex", "/tmp/project");
    registry = new SessionRegistry(db);
    store = new AppliedLaunchObservationStore(db);
  });
  afterEach(() => db.close());

  it("reads back supported, legacy and unrecorded choices", () => {
    registry.registerSession("node-1", "dev-qa@r1");
    const generation = registry.currentOccupantTenure("node-1")!.generationUuid;
    expect(store.recordGeneration(generation, withChoice(true))).toBe(true);
    expect(store.readCurrent("node-1")).toMatchObject({ value: "workspace-write", daemonOptOut: true });
    expect(store.recordGeneration(generation, withChoice(false))).toBe(true);
    expect(store.readCurrent("node-1")).toMatchObject({ value: "workspace-write", daemonOptOut: false });
    expect(store.recordGeneration(generation, codexFloor)).toBe(true);
    expect(store.readCurrent("node-1")).not.toHaveProperty("daemonOptOut");
  });
});

describe("rig ps resumeCommand and the node detail's recovery guidance", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let store: AppliedLaunchObservationStore;
  let sessionId: string;

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-2", "test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-2", "rig-2", "dev", "Dev");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("node-codex", "rig-2", "dev.qa", "codex", "/workspace/app", "pod-2", "local:agents/qa", "default", "qa", "1.0.0", "hash");
    registry = new SessionRegistry(db);
    store = new AppliedLaunchObservationStore(db);
    sessionId = registry.registerSession("node-codex", "dev-qa@test-rig").id;
  });
  afterEach(() => db.close());

  const record = (observation: AppliedLaunchObservation) =>
    expect(store.recordGeneration(registry.currentOccupantTenure("node-codex")!.generationUuid, observation)).toBe(true);
  const printed = () => {
    const entry = getNodeInventory(db, "rig-2").find((e) => e.logicalId === "dev.qa")!;
    const detail = getNodeDetail(db, "rig-2", "dev.qa")!;
    return { resumeCommand: entry.resumeCommand, guidance: detail.recoveryGuidance! };
  };

  describe("with a stored conversation", () => {
    beforeEach(() => registry.updateResumeToken(sessionId, "codex_id", "sess-456", "hook"));

    it("a recorded opt-out prints --no-daemon in both, with no limitation note", () => {
      record(withChoice(true));
      const { resumeCommand, guidance } = printed();
      expect(resumeCommand).toBe("codex --no-daemon -s workspace-write resume 'sess-456'");
      expect(guidance.commands).toEqual(["codex --no-daemon -s workspace-write resume 'sess-456'", "cd /workspace/app"]);
      expect(guidance.notes).not.toContain(NOT_RECORDED);
    });

    it("a recorded legacy launch prints the old command unchanged, with no limitation note", () => {
      record(withChoice(false));
      const { resumeCommand, guidance } = printed();
      expect(resumeCommand).toBe("codex -s workspace-write resume 'sess-456'");
      expect(guidance.commands).toEqual(["codex -s workspace-write resume 'sess-456'", "cd /workspace/app"]);
      expect(guidance.notes).not.toContain(NOT_RECORDED);
    });

    it("an unrecorded choice keeps the old command and says it isn't known", () => {
      record(codexFloor);
      const { resumeCommand, guidance } = printed();
      expect(resumeCommand).toBe("codex -s workspace-write resume 'sess-456'");
      expect(guidance.commands).toEqual(["codex -s workspace-write resume 'sess-456'", "cd /workspace/app"]);
      expect(guidance.notes).toContain(NOT_RECORDED);
    });

    it("a successor generation doesn't inherit its predecessor's choice", () => {
      record(withChoice(true));
      registry.mintOccupantTenure("node-codex", "handover");
      const { resumeCommand, guidance } = printed();
      expect(resumeCommand).toBe("codex -s workspace-write resume 'sess-456'");
      expect(guidance.notes).toContain(NOT_RECORDED);
    });
  });

  it("without a stored conversation, the picker command and the summary carry a recorded opt-out", () => {
    record(withChoice(true));
    const { resumeCommand, guidance } = printed();
    expect(resumeCommand).toBeNull();
    expect(guidance.commands).toEqual(["cd /workspace/app", "codex --no-daemon -s workspace-write resume --last"]);
    expect(guidance.summary).toContain("Try codex --no-daemon -s workspace-write resume --last;");
    expect(guidance.notes).not.toContain(NOT_RECORDED);
  });

  it("without a stored conversation and an unrecorded choice, the picker command and summary are unchanged", () => {
    const { guidance } = printed();
    expect(guidance.commands).toEqual(["cd /workspace/app", "codex -s workspace-write resume --last"]);
    expect(guidance.summary).toContain("Try codex -s workspace-write resume --last;");
    expect(guidance.notes).toContain(NOT_RECORDED);
  });
});

describe("Codex managed launches return the daemon choice with their launch facts", () => {
  const supported: CodexDaemonSupport = { kind: "supported" };
  const legacy: CodexDaemonSupport = { kind: "legacy" };

  function mockTmux(): TmuxAdapter {
    return mockShellCommand({
      sendText: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => null),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
    } as unknown as TmuxAdapter);
  }
  const fsOps = (): CodexAdapterFsOps => ({
    readFile: () => { throw new Error("not found"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [],
  });
  const binding = (): NodeBinding => ({
    id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", model: "gpt-5.5",
  });
  const detector = (support: CodexDaemonSupport | undefined) =>
    support ? { detectDaemonSupport: vi.fn<CodexDaemonSupportDetector>(async () => support) } : {};

  for (const kind of ["fresh", "fork"] as const) {
    it(`${kind}: supported records true, legacy records false, no probe records nothing`, async () => {
      const run = async (support: CodexDaemonSupport | undefined) => {
        const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsOps(), listProcesses: () => [], sleep: async () => {}, ...detector(support) });
        const result = await adapter.launchHarness(binding(), kind === "fork"
          ? { name: "dev-qa@test-rig", forkSource: { kind: "native_id" as const, value: "parent", pendingIdAllowed: true } }
          : { name: "dev-qa@test-rig" });
        expect(result.ok).toBe(true);
        return (result as { appliedLaunch?: AppliedLaunchObservation }).appliedLaunch!;
      };
      expect(await run(supported)).toMatchObject({ ...codexFloor, daemonOptOut: true });
      expect(await run(legacy)).toMatchObject({ ...codexFloor, daemonOptOut: false });
      expect(await run(undefined)).toEqual(codexFloor);
    });
  }

  it("the legacy restore path: supported records true, legacy records false, no probe records nothing", async () => {
    const run = async (support: CodexDaemonSupport | undefined) => {
      const adapter = new CodexResumeAdapter(mockTmux(), { sleep: async () => {}, maxWaitMs: 0, ...detector(support) });
      const result = await adapter.resume("r01-qa", "codex_id", "sess 456", "/project", null, undefined, "gpt-5.5");
      expect(result.ok).toBe(true);
      return (result as { appliedLaunch?: AppliedLaunchObservation }).appliedLaunch!;
    };
    expect(await run(supported)).toMatchObject({ ...codexFloor, daemonOptOut: true });
    expect(await run(legacy)).toMatchObject({ ...codexFloor, daemonOptOut: false });
    expect(await run(undefined)).toEqual(codexFloor);
  });
});
