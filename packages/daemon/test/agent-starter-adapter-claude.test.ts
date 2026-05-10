// Tier 1 proof for the Agent Starter v1 vertical M2 Revision 2 — real
// `ClaudeCodeAdapter` proof. M2 R1 used a mock RuntimeAdapter and only
// asserted the spy received a STARTER ResolvedStartupFile, which is
// caller-wiring proof, not adapter behavior. M2 R2 instantiates the real
// `ClaudeCodeAdapter` and
// mocks at the tmux boundary; the proof is that real `deliverStartup`
// exercises `guidance_merge` and writes the starter content into the
// per-seat CLAUDE.md managed block.

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
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
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
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
  } as unknown as TmuxAdapter;
}

// In-memory FS adapter pattern from claude-runtime-adapter.test.ts. We
// pre-populate the registry-entry path (which the resolver returns as an
// absolute path) so the real ClaudeCodeAdapter can read it via its fs
// seam; writes to <cwd>/CLAUDE.md land in the same store and we read
// them back to verify the merged-guidance result.
function mockClaudeFs(seed: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...seed };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  };
}

const RIG_ROOT = "/project/rigs/test-rig";

const CLAUDE_STARTER = `draft: false
starter_id: claude-fixture-starter
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "claude-fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

describe("Agent Starter v1 vertical — real Claude adapter delivery (M2 R2)", () => {
  it("real ClaudeCodeAdapter.deliverStartup writes STARTER content to CLAUDE.md via guidance_merge", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-adapter-claude-r2-"));
    const registryRoot = path.join(tmpDir, "registry");
    fs.mkdirSync(registryRoot, { recursive: true });
    const registryEntryPath = path.join(registryRoot, "claude-fixture-starter.yaml");
    fs.writeFileSync(registryEntryPath, CLAUDE_STARTER);
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

      // Real ClaudeCodeAdapter. The fs seam is pre-loaded with the
      // registry-entry content (matching the path the resolver will hand
      // back) so the adapter's `readFile(file.absolutePath)` succeeds and
      // the merge_guidance branch can run.
      const claudeFs = mockClaudeFs({ [registryEntryPath]: CLAUDE_STARTER });
      const claudeAdapter = new ClaudeCodeAdapter({ tmux, fsOps: claudeFs });

      // Pass-through Codex/terminal adapters keep the instantiator's
      // adapter map type-complete; this test only exercises Claude.
      const passThroughAdapter: RuntimeAdapter = {
        runtime: "codex",
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
          "claude-code": claudeAdapter,
          "codex": passThroughAdapter,
          "terminal": passThroughAdapter,
        },
        tmuxAdapter: tmux,
      });

      const spec: RigSpec = {
        version: "0.2",
        name: "claude-starter-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "claude-fixture-starter" },
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // The Claude adapter's `mergeGuidance` writes to <binding.cwd>/CLAUDE.md
      // wrapped in a `BEGIN OpenRig MANAGED BLOCK` envelope. The cwd for this
      // member resolves to RIG_ROOT (`cwd: "."`).
      const expectedClaudeMdPath = path.join(RIG_ROOT, "CLAUDE.md");
      const claudeMd = claudeFs._store[expectedClaudeMdPath];
      expect(claudeMd, "expected real ClaudeCodeAdapter to have written CLAUDE.md via guidance_merge").toBeDefined();
      // The managed block is keyed on the starter file path (`file.path`,
      // which is the basename returned by the resolver).
      expect(claudeMd).toContain("BEGIN OpenRig MANAGED BLOCK: claude-fixture-starter.yaml");
      expect(claudeMd).toContain("END OpenRig MANAGED BLOCK: claude-fixture-starter.yaml");
      // Some piece of the starter YAML body must appear inside the block.
      // We pick `starter_id: claude-fixture-starter` because it's a stable,
      // unambiguous marker the resolver passed through.
      expect(claudeMd).toContain("starter_id: claude-fixture-starter");

      db.close();
    } finally {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
