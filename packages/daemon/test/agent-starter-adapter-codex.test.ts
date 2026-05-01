// Tier 1 proof for the Agent Starter v1 vertical M2 — Codex adapter
// integration. Mirror of the Claude adapter test but for Codex.
// Verifies that the STARTER layer artifacts (from AgentStarterResolver)
// flow through the existing `codex-runtime-adapter.deliverStartup`
// seam without any adapter-side code change.

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import type { RuntimeAdapter, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

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

function mockCodexAdapter(): RuntimeAdapter {
  return {
    runtime: "codex",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

const RIG_ROOT = "/project/rigs/test-rig";

const CODEX_STARTER = `draft: false
starter_id: codex-fixture-starter
runtime: codex
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "codex-fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

describe("Agent Starter v1 vertical — Codex adapter integration (M2)", () => {
  it("codex-runtime-adapter.deliverStartup receives STARTER layer artifact when starterRef is set", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-adapter-codex-"));
    const registryRoot = path.join(tmpDir, "registry");
    fs.mkdirSync(registryRoot, { recursive: true });
    fs.writeFileSync(path.join(registryRoot, "codex-fixture-starter.yaml"), CODEX_STARTER);
    process.env.OPENRIG_AGENT_STARTER_ROOT = registryRoot;

    try {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const podRepo = new PodRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const tmux = mockTmux();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const codexAdapter = mockCodexAdapter();
      const fsOps: AgentResolverFsOps = {
        readFile: (p: string) => {
          if (p === `${RIG_ROOT}/agents/impl/agent.yaml`) {
            return `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
          }
          throw new Error(`Not found: ${p}`);
        },
        exists: (p: string) => p === `${RIG_ROOT}/agents/impl/agent.yaml`,
      };

      const inst = new PodRigInstantiator({
        db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
        startupOrchestrator: startupOrch, fsOps,
        adapters: {
          "claude-code": mockCodexAdapter(),
          "codex": codexAdapter,
          "terminal": mockCodexAdapter(),
        },
        tmuxAdapter: tmux,
      });

      const spec: RigSpec = {
        version: "0.2",
        name: "codex-starter-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "codex",
            cwd: ".",
            starterRef: { name: "codex-fixture-starter" },
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      const deliverStartupSpy = codexAdapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const files = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];

      // STARTER layer prepended at front
      expect(files[0]!.path).toBe("codex-fixture-starter.yaml");
      expect(files[0]!.ownerRoot).toBe(registryRoot);
      expect(files[0]!.appliesOn).toEqual(["fresh_start"]);
      expect(files[0]!.required).toBe(true);
      expect(files[0]!.deliveryHint).toBe("guidance_merge");

      db.close();
    } finally {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
