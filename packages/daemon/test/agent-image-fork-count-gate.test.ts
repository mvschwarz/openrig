// PL-016 hardening v0+1 — fork_count gating integration test
// (review-lead live e2e finding 4, 2026-05-04).
//
// Pins: when an agent_image-backed launch FAILS at the
// startupOrchestrator stage, the AgentImageLibraryService receives
// recordConsumption(id, { incrementForkCount: false }) ONLY — the
// post-launch fork-count bump is gated on startupResult.ok===true.
// Asserts via a spy on the library's recordConsumption method.

import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import type { AgentImageEntry } from "../src/domain/agent-images/agent-image-types.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

/** Minimal RuntimeAdapter whose launchHarness returns failure —
 *  forces the instantiator's startupResult.ok to be false. */
function mockFailingAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({
      ok: false,
      error: "simulated launch failure for fork-count-gate test",
    })),
  };
}

function mockSucceedingAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

const RIG_ROOT = "/project/rigs/my-rig";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function makeRigSpec(): RigSpec {
  return {
    version: "0.2",
    name: "fork-count-gate-rig",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "impl",
        agentRef: "local:agents/impl",
        profile: "default",
        runtime: "claude-code",
        cwd: ".",
        sessionSource: {
          mode: "agent_image",
          ref: { kind: "image_name", value: "test-image" },
        },
      }],
      edges: [],
    }],
    edges: [],
  };
}

/** Hand-built in-memory AgentImageLibraryService — populated with a
 *  fake AgentImageEntry so getByNameVersion returns a usable image
 *  without needing a real on-disk manifest fixture. */
function makeStubLibrary(): AgentImageLibraryService {
  // Construct a real instance backed by an empty roots[] (no scan
  // walks the filesystem); inject a fake entry into its internal
  // map directly via type-cast.
  const lib = new AgentImageLibraryService({ roots: [] });
  const entry: AgentImageEntry = {
    id: "agent-image:test-image:1",
    kind: "agent-image",
    name: "test-image",
    version: "1",
    runtime: "claude-code",
    sourceSeat: "alice@rig",
    sourceSessionId: "src-session-id",
    sourceResumeToken: "RESUME-TOKEN-XYZ",
    notes: null,
    createdAt: "2026-05-04T00:00:00Z",
    sourceType: "user_file",
    sourcePath: "/tmp/nonexistent",
    relativePath: "test-image",
    updatedAt: "2026-05-04T00:00:00Z",
    manifestEstimatedTokens: null,
    derivedEstimatedTokens: 100,
    files: [],
    stats: { forkCount: 0, lastUsedAt: null, estimatedSizeBytes: 0, lineage: [] },
    lineage: [],
    pinned: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lib as any).entries.set(entry.id, entry);
  return lib;
}

describe("agent_image fork_count gating on launch outcome (PL-016 hardening v0+1 finding 4)", () => {
  it("FAILED launch: recordConsumption called once with { incrementForkCount: false } only", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const failingAdapter = mockFailingAdapter();
    const fsOps = mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });

    const library = makeStubLibrary();
    // Stub recordConsumption so the test doesn't try to write stats.json
    // to /tmp/nonexistent — verifies call shape only.
    const recordConsumption = vi.spyOn(library, "recordConsumption").mockImplementation(() => {});

    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps,
      adapters: { "claude-code": failingAdapter, "codex": mockSucceedingAdapter("codex"), "terminal": mockSucceedingAdapter("terminal") },
      tmuxAdapter: tmux,
      agentImageLibrary: library,
    });

    const yaml = RigSpecCodec.serialize(makeRigSpec());
    await inst.instantiate(yaml, RIG_ROOT);

    // Pre-launch optimistic call must have happened with incrementForkCount: false
    const calls = recordConsumption.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("agent-image:test-image:1");
    expect(calls[0]![1]).toEqual({ incrementForkCount: false });

    db.close();
  });

  it("SUCCESSFUL launch: recordConsumption called twice — pre-launch (false) + post-launch success (true)", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const succeedingAdapter = mockSucceedingAdapter();
    const fsOps = mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });

    const library = makeStubLibrary();
    const recordConsumption = vi.spyOn(library, "recordConsumption").mockImplementation(() => {});

    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps,
      adapters: { "claude-code": succeedingAdapter, "codex": mockSucceedingAdapter("codex"), "terminal": mockSucceedingAdapter("terminal") },
      tmuxAdapter: tmux,
      agentImageLibrary: library,
    });

    const yaml = RigSpecCodec.serialize(makeRigSpec());
    await inst.instantiate(yaml, RIG_ROOT);

    // Two calls: pre-launch false, post-launch success true.
    const calls = recordConsumption.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]![1]).toEqual({ incrementForkCount: false });
    expect(calls[1]![1]).toEqual({ incrementForkCount: true });

    db.close();
  });
});
