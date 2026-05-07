// Tier 1 proof for the Agent Starter v1 vertical M2 Revision 2 — real
// `CodexRuntimeAdapter` proof. Mirror of the Claude adapter R2 test:
// instantiates the real adapter and mocks at the tmux boundary; verifies
// `deliverStartup`'s `guidance_merge` branch writes the starter content
// into the per-seat AGENTS.md managed block.

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
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
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
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => ""),
  } as unknown as TmuxAdapter;
}

function mockCodexFs(seed: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...seed };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
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

describe("Agent Starter v1 vertical — real Codex adapter delivery (M2 R2)", () => {
  it("real CodexRuntimeAdapter.deliverStartup writes STARTER content to AGENTS.md via guidance_merge", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-adapter-codex-r2-"));
    const registryRoot = path.join(tmpDir, "registry");
    fs.mkdirSync(registryRoot, { recursive: true });
    const registryEntryPath = path.join(registryRoot, "codex-fixture-starter.yaml");
    fs.writeFileSync(registryEntryPath, CODEX_STARTER);
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

      const codexFs = mockCodexFs({ [registryEntryPath]: CODEX_STARTER });
      const codexAdapter = new CodexRuntimeAdapter({
        tmux,
        fsOps: codexFs,
        // Stub out process-tree probes so the adapter doesn't shell out.
        listProcesses: () => [],
        readThreadIdByPid: () => undefined,
        resolveHomeDirByPid: () => undefined,
      });

      const passThroughAdapter: RuntimeAdapter = {
        runtime: "claude-code",
        listInstalled: async () => [],
        project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: 0, failed: [] }),
        checkReady: async () => ({ ready: true }),
        launchHarness: async () => ({ ok: true }),
      };

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
          "claude-code": passThroughAdapter,
          "codex": codexAdapter,
          "terminal": passThroughAdapter,
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

      const expectedAgentsMdPath = path.join(RIG_ROOT, "AGENTS.md");
      const agentsMd = codexFs._store[expectedAgentsMdPath];
      expect(agentsMd, "expected real CodexRuntimeAdapter to have written AGENTS.md via guidance_merge").toBeDefined();
      expect(agentsMd).toContain("BEGIN OpenRig MANAGED BLOCK: codex-fixture-starter.yaml");
      expect(agentsMd).toContain("END OpenRig MANAGED BLOCK: codex-fixture-starter.yaml");
      expect(agentsMd).toContain("starter_id: codex-fixture-starter");

      db.close();
    } finally {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
