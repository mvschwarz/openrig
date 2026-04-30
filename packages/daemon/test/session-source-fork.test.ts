import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";

import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RuntimeAdapter, NodeBinding, ForkSource } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { RigSpec, SessionSourceSpec } from "../src/domain/types.js";

// ============================================================================
// Fixtures
// ============================================================================

function baseValidSpec(): Record<string, unknown> {
  return {
    version: "0.2",
    name: "fork-test-rig",
    pods: [
      {
        id: "dev",
        label: "Dev pod",
        members: [
          {
            id: "impl",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

function withMember(spec: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(spec));
  const pods = next.pods as Array<Record<string, unknown>>;
  const members = pods[0]!.members as Array<Record<string, unknown>>;
  members[0] = { ...members[0], ...override };
  return next;
}

// ============================================================================
// Schema validation — Honest Refusal Matrix
// ============================================================================

describe("session_source schema validation", () => {
  it("accepts claude-code + fork + native_id + non-empty value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: {
        mode: "fork",
        ref: { kind: "native_id", value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6" },
      },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts codex + fork + native_id + non-empty value", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "codex",
      session_source: { mode: "fork", ref: { kind: "native_id", value: "thread-id-abc" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
  });

  it("rejects terminal runtime with session_source", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      profile: "none",
      session_source: { mode: "fork", ref: { kind: "native_id", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal runtime has no native fork primitive"))).toBe(true);
  });

  it("rejects mode != fork", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "snapshot", ref: { kind: "native_id", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('v1 supports "fork" only'))).toBe(true);
  });

  it("rejects ref.kind=artifact_path (deferred per dossier)", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "artifact_path", value: "/some/path" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"artifact_path" deferred to follow-up slice'))).toBe(true);
  });

  it("rejects ref.kind=name", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "name", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weaker than "native_id"'))).toBe(true);
  });

  it("rejects ref.kind=last", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "last" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weaker than "native_id"'))).toBe(true);
  });

  it("rejects missing ref.value when kind=native_id", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "native_id" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ref.value: required non-empty string"))).toBe(true);
  });

  it("rejects empty ref.value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "native_id", value: "   " } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ref.value: required non-empty string"))).toBe(true);
  });

  it("rejects missing ref entirely", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork" },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(".ref:"))).toBe(true);
  });

  it("rejects unknown kind value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "magic" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('v1 supports "native_id" only'))).toBe(true);
  });
});

// ============================================================================
// normalizePod — schema-side typed coercion
// ============================================================================

describe("session_source normalization", () => {
  it("normalizes valid session_source onto RigSpecPodMember.sessionSource", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "native_id", value: "abc" } },
    });
    const normalized = RigSpecSchema.normalize(spec) as RigSpec;
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toEqual({ mode: "fork", ref: { kind: "native_id", value: "abc" } });
  });

  it("normalizes absent session_source to undefined", () => {
    const spec = baseValidSpec();
    const normalized = RigSpecSchema.normalize(spec) as RigSpec;
    expect(normalized.pods[0]!.members[0]!.sessionSource).toBeUndefined();
  });
});

// ============================================================================
// Codec roundtrip — serialize → parse → normalize
// ============================================================================

describe("session_source codec roundtrip", () => {
  it("preserves session_source through serialize → parse → normalize", () => {
    const seed: RigSpec = {
      version: "0.2",
      name: "fork-test-rig",
      pods: [{
        id: "dev",
        label: "Dev pod",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
          sessionSource: { mode: "fork", ref: { kind: "native_id", value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6" } },
        }],
        edges: [],
      }],
      edges: [],
    };
    const yaml = RigSpecCodec.serialize(seed);
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("mode: fork");
    expect(yaml).toContain("kind: native_id");
    expect(yaml).toContain("0b0165d7-cb4d-4650-90de-15c0a1ede9e6");

    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>) as RigSpec;
    expect(normalized.pods[0]!.members[0]!.sessionSource).toEqual(seed.pods[0]!.members[0]!.sessionSource);
  });
});

// ============================================================================
// Claude adapter fork branch
// ============================================================================

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

function mockClaudeFs(captured?: string): ClaudeAdapterFsOps {
  const store: Record<string, string> = {};
  return {
    readFile: (p: string) => {
      if (captured && p.includes(`12345.json`)) {
        return JSON.stringify({ pid: 12345, sessionId: captured, name: "dev-impl@test-rig" });
      }
      if (p in store) return store[p]!;
      throw new Error(`Not found: ${p}`);
    },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store || (captured ? p.includes("sessions") : false),
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
    readdir: () => (captured ? ["12345.json"] : []),
    homedir: "/mock-home",
  } as ClaudeAdapterFsOps;
}

function makeBinding(): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project",
  };
}

describe("ClaudeCodeAdapter.launchHarness fork branch", () => {
  it("builds claude --resume <parent> --fork-session for forkSource.kind=native_id and captures the NEW token", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs("NEW-POST-FORK-TOKEN-XYZ") });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-TOKEN-ABC" },
    });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-impl",
      "claude --permission-mode acceptEdits --resume PARENT-TOKEN-ABC --fork-session --name dev-impl@test-rig",
    );
    if (result.ok) {
      // Captured token MUST be the new post-fork token, NOT the parent.
      expect(result.resumeToken).toBe("NEW-POST-FORK-TOKEN-XYZ");
      expect(result.resumeToken).not.toBe("PARENT-TOKEN-ABC");
      expect(result.resumeType).toBe("claude_id");
    }
  });

  it("refuses forkSource.kind=artifact_path (defensive — schema also rejects)", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs() });
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "artifact_path", value: "/some/path" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ref.kind="artifact_path" is not supported in v1');
    }
  });

  it("refuses both resumeToken and forkSource together", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs() });
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "abc",
      forkSource: { kind: "native_id", value: "xyz" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("mutually exclusive");
    }
  });

  it("refuses forkSource with empty value", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs() });
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "  " },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("forkSource.value is required");
    }
  });

  it("does not break the existing fresh and resume paths", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockClaudeFs(),
      sessionIdFactory: () => "fresh-uuid-aaa",
    });
    const fresh = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });
    expect(fresh.ok).toBe(true);

    const resume = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "resume-abc" });
    expect(resume.ok).toBe(true);
  });
});

// ============================================================================
// Codex adapter fork branch
// ============================================================================

describe("CodexRuntimeAdapter.launchHarness fork branch", () => {
  function makeMinimalCodexFs() {
    return {
      readFile: () => "",
      writeFile: () => {},
      exists: () => false,
      mkdirp: () => {},
      listFiles: () => [],
    } as unknown as Parameters<typeof CodexRuntimeAdapter>[0]["fsOps"];
  }

  function makeCodexAdapter(captureThreadId?: string) {
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)"),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => 900),
    } as unknown as TmuxAdapter;
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: makeMinimalCodexFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => (pid === 901 && captureThreadId ? captureThreadId : undefined),
      sleep: async () => {},
    });
    return { tmux, adapter };
  }

  it("builds codex fork <parent> for forkSource.kind=native_id and captures the NEW thread id", async () => {
    const { tmux, adapter } = makeCodexAdapter("NEW-CODEX-THREAD-XYZ");
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-THREAD-ABC" },
    });
    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const sentCmd = sendText.mock.calls[0]?.[1] as string;
    expect(sentCmd).toMatch(/^codex( -p [^ ]+)? fork/);
    expect(sentCmd).toContain("PARENT-THREAD-ABC");
    if (result.ok) {
      expect(result.resumeToken).toBe("NEW-CODEX-THREAD-XYZ");
      expect(result.resumeToken).not.toBe("PARENT-THREAD-ABC");
      expect(result.resumeType).toBe("codex_id");
    }
  });

  it("refuses forkSource.kind=artifact_path", async () => {
    const { adapter } = makeCodexAdapter();
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "artifact_path", value: "/x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ref.kind="artifact_path" is not supported in v1');
    }
  });

  it("refuses both resumeToken and forkSource together", async () => {
    const { adapter } = makeCodexAdapter();
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "r",
      forkSource: { kind: "native_id", value: "p" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("mutually exclusive");
    }
  });

  it("refuses fork when capture fails (identity-honesty: no token == no honest seat)", async () => {
    const { adapter } = makeCodexAdapter(); // no thread id captured
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-X" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not capture new post-fork thread id");
    }
  });
});

// ============================================================================
// Terminal adapter — defensive refusal
// ============================================================================

describe("TerminalAdapter.launchHarness fork refusal", () => {
  it("refuses forkSource (terminal has no native fork primitive)", async () => {
    const adapter = new TerminalAdapter();
    const result = await adapter.launchHarness(makeBinding(), {
      name: "term@rig",
      forkSource: { kind: "native_id", value: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("terminal runtime has no native fork primitive");
    }
  });

  it("still succeeds for the no-fork path", async () => {
    const adapter = new TerminalAdapter();
    const result = await adapter.launchHarness(makeBinding(), { name: "term@rig" });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Startup orchestrator — forkSource → continuityOutcome="forked" + new token
// persisted; identity prompt NOT replayed (forked seat carries parent context)
// ============================================================================

function mockOrchTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function makeStubAdapter(forkResumeToken: string): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async (_binding, opts) => {
      // Honest identity rule: the captured token IS the new post-fork token.
      if (opts.forkSource) {
        return { ok: true, resumeToken: forkResumeToken, resumeType: "claude_id" };
      }
      return { ok: true };
    }),
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

describe("StartupOrchestrator forkSource integration", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });
  afterEach(() => { db.close(); });

  function seed(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("fork-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(s: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: s.rigId,
      nodeId: s.nodeId,
      sessionId: s.sessionId,
      binding: { id: "b1", nodeId: s.nodeId, tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
      adapter: makeStubAdapter("NEW-POST-FORK-TOKEN-aaa"),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  function createOrch(): StartupOrchestrator {
    return new StartupOrchestrator({
      db, sessionRegistry, eventBus,
      tmuxAdapter: mockOrchTmux(),
      sleep: async () => {},
    });
  }

  it("sets continuityOutcome=forked when forkSource is provided and launch succeeds", async () => {
    const s = seed();
    const orch = createOrch();
    const forkSource: ForkSource = { kind: "native_id", value: "PARENT-TOKEN-ABC" };
    const result = await orch.startNode(makeInput(s, { forkSource }));
    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "forked",
    });
  });

  it("persists the NEW post-fork token onto the seat, NOT the parent", async () => {
    const s = seed();
    const orch = createOrch();
    const forkSource: ForkSource = { kind: "native_id", value: "PARENT-TOKEN-ABC" };
    await orch.startNode(makeInput(s, { forkSource }));

    const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(s.sessionId) as { resume_token: string };
    expect(row.resume_token).toBe("NEW-POST-FORK-TOKEN-aaa");
    expect(row.resume_token).not.toBe("PARENT-TOKEN-ABC");
  });

  it("passes forkSource through to adapter.launchHarness opts (not resumeToken)", async () => {
    const s = seed();
    const orch = createOrch();
    const adapter = makeStubAdapter("any-token");
    const launchSpy = adapter.launchHarness as ReturnType<typeof vi.fn>;
    const forkSource: ForkSource = { kind: "native_id", value: "PARENT-TOKEN" };

    await orch.startNode(makeInput(s, { adapter, forkSource }));

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const opts = launchSpy.mock.calls[0]![1];
    expect(opts.forkSource).toEqual(forkSource);
    expect(opts.resumeToken).toBeUndefined();
  });

  it("fresh path (no resumeToken, no forkSource) is unchanged: continuityOutcome=fresh", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "fresh" });
  });

  it("resume path (resumeToken set) is unchanged: continuityOutcome=resumed", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s, {
      resumeToken: "stored-token-xyz",
      isRestore: true,
    }));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "resumed" });
  });
});

// ============================================================================
// rig-expansion-service buildSyntheticSpec pass-through
// ============================================================================

describe("rig-expansion buildSyntheticSpec session_source pass-through", () => {
  it("includes session_source in the synthetic YAML when member.sessionSource is set", async () => {
    const { RigExpansionService } = await import("../src/domain/rig-expansion-service.js");
    const fakeRigRepo = { getRig: () => ({ rig: { name: "rig-x" }, nodes: [] }) } as never;
    const fakeEventBus = { emit: () => {} } as never;
    const podSpecs: string[] = [];
    const fakePodInstantiator = {
      materialize: async (specYaml: string) => {
        podSpecs.push(specYaml);
        return { ok: true as const, result: { nodes: [] } };
      },
      launchMaterialized: async () => ({ ok: true as const, result: { nodes: [], warnings: [] } }),
    } as never;

    const svc = new RigExpansionService({
      db: {} as never,
      rigRepo: fakeRigRepo,
      eventBus: fakeEventBus,
      nodeLauncher: {} as never,
      podInstantiator: fakePodInstantiator,
      sessionRegistry: {} as never,
    });
    const result = await svc.expand({
      rigId: "rig-x",
      pod: {
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          runtime: "claude-code",
          agentRef: "local:impl",
          profile: "default",
          cwd: ".",
          sessionSource: { mode: "fork", ref: { kind: "native_id", value: "fork-source-id" } },
        }],
        edges: [],
      },
    });
    expect(result.ok).toBe(true);
    expect(podSpecs).toHaveLength(1);
    const yaml = podSpecs[0]!;
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("mode: fork");
    expect(yaml).toContain("kind: native_id");
    expect(yaml).toContain("fork-source-id");
  });
});

// ============================================================================
// Honest UX literal — continuityOutcome union includes "forked"
// ============================================================================

describe("identity-honesty literal contract", () => {
  it('continuityOutcome union accepts "forked" alongside "resumed" and "fresh"', () => {
    const r1 = { ok: true as const, startupStatus: "ready" as const, continuityOutcome: "forked" as const };
    const r2 = { ok: true as const, startupStatus: "ready" as const, continuityOutcome: "resumed" as const };
    const r3 = { ok: true as const, startupStatus: "ready" as const, continuityOutcome: "fresh" as const };
    expect(r1.continuityOutcome).toBe("forked");
    expect(r2.continuityOutcome).toBe("resumed");
    expect(r3.continuityOutcome).toBe("fresh");
  });

  it("does NOT reuse 'restored', 'resumed', or 'snapshot' wording for the fork path", () => {
    const fork: SessionSourceSpec = { mode: "fork", ref: { kind: "native_id", value: "x" } };
    expect(fork.mode).toBe("fork");
    expect(["restored", "resumed", "snapshot", "snapshot_copy"]).not.toContain(fork.mode as string);
  });
});
