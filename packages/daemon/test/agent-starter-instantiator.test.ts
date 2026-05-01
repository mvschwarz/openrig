// Tier 1 proof for the Agent Starter v1 vertical M2 — instantiator
// integration. M1 shipped the schema + resolver scaffolding; M2 wires
// the resolver into `launchExistingAgentMember`, prepending the resolved
// starter artifacts as a STARTER layer ahead of the per-agent /
// per-pod startup files.
//
// Key invariants:
// - Resolver invoked when `member.starterRef` is set.
// - STARTER layer prepended in `resolvedStartupFiles` (not a separate
//   orchestrator branch).
// - Resolver THROW (any cause: missing entry, malformed YAML, failed
//   credential scan) aborts the launch BEFORE `startNode` runs — no
//   adapter `deliverStartup` is called and no STARTER layer lands
//   downstream. Load-bearing credential-safety contract per M1 R1
//   finding 2.
// - Composition with `session_source.mode: "rebuild"` works
//   independently (both apply on fresh_start; per slice schema).

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

function mockAdapter(runtime = "claude-code"): RuntimeAdapter {
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

const RIG_ROOT = "/project/rigs/test-rig";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function specWithStarterRef(): RigSpec {
  return {
    version: "0.2",
    name: "test-rig",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "impl",
        agentRef: "local:agents/impl",
        profile: "default",
        runtime: "claude-code",
        cwd: ".",
        starterRef: { name: "fixture-starter" },
      }],
      edges: [],
    }],
    edges: [],
  };
}

const CLEAN_STARTER = `draft: false
starter_id: fixture-starter
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

const MALICIOUS_STARTER = `draft: false
starter_id: fixture-mal
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "x"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
api_key: example-not-real
`;

function setupWithStarter(opts: {
  starterContent?: string | null;        // null → registry directory empty
  starterFilename?: string;              // default: fixture-starter.yaml
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-instantiator-"));
  const registryRoot = path.join(tmpDir, "registry");
  fs.mkdirSync(registryRoot, { recursive: true });

  if (opts.starterContent) {
    const filename = opts.starterFilename ?? "fixture-starter.yaml";
    fs.writeFileSync(path.join(registryRoot, filename), opts.starterContent);
  }

  // Tell the resolver to use this fixture directory via the documented
  // env-var lookup branch.
  process.env.OPENRIG_AGENT_STARTER_ROOT = registryRoot;

  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const adapter = mockAdapter("claude-code");
  const codexAdapter = mockAdapter("codex");
  const fsOps = mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });

  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator: startupOrch,
    fsOps,
    adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
    tmuxAdapter: tmux,
  });

  const cleanup = () => {
    delete process.env.OPENRIG_AGENT_STARTER_ROOT;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { db, rigRepo, sessionRegistry, eventBus, inst, adapter, codexAdapter, tmux, registryRoot, cleanup };
}

describe("Agent Starter v1 vertical — instantiator integration (M2)", () => {
  it("invokes resolver and prepends STARTER layer when member.starterRef is set", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // adapter.deliverStartup should have been called; the first arg is the
      // ResolvedStartupFile[] that includes the STARTER layer at the front.
      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const filesArg = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];

      // STARTER layer prepended: the first ResolvedStartupFile must come from
      // the registryRoot we set up.
      expect(filesArg.length).toBeGreaterThan(0);
      expect(filesArg[0]!.ownerRoot).toBe(ctx.registryRoot);
      expect(filesArg[0]!.path).toBe("fixture-starter.yaml");
      expect(filesArg[0]!.appliesOn).toEqual(["fresh_start"]);
    } finally {
      ctx.cleanup();
    }
  });

  it("aborts launch when resolver throws — adapter.deliverStartup NOT called", async () => {
    // Malicious starter (api_key field) → resolver throws
    // AgentStarterCredentialScanFailedError → instantiator returns failed
    // before adapter.deliverStartup runs. Load-bearing credential-safety
    // contract per M1 R1 finding 2.
    const ctx = setupWithStarter({ starterContent: MALICIOUS_STARTER });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);

      // Some node failed (the impl member) — instantiator may still report
      // ok=true with a failed node entry, depending on partial-failure
      // policy. The load-bearing assertion is: deliverStartup was NEVER
      // called for this node, AND the node's status is "failed".
      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).not.toHaveBeenCalled();

      if (result.ok) {
        const node = result.result.nodes.find((n) => n.logicalId === "dev.impl");
        expect(node?.status).toBe("failed");
        expect(node?.error).toContain("Agent Starter resolver failed");
      } else {
        // result.ok=false is also acceptable closure
        expect(result.ok).toBe(false);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("aborts launch when starter registry entry is missing (resolver throws)", async () => {
    // No registry file → resolver throws "no registry entry found".
    const ctx = setupWithStarter({ starterContent: null });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);

      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).not.toHaveBeenCalled();

      if (result.ok) {
        const node = result.result.nodes.find((n) => n.logicalId === "dev.impl");
        expect(node?.status).toBe("failed");
        expect(node?.error).toContain("Agent Starter resolver failed");
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("does NOT invoke resolver when member.starterRef is absent (no STARTER layer)", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      // Spec without starterRef on the member.
      const spec: RigSpec = {
        version: "0.2",
        name: "no-starter-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const filesArg = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];

      // No file from the registryRoot should appear in the chain.
      const fromRegistry = filesArg.find((f) => f.ownerRoot === ctx.registryRoot);
      expect(fromRegistry).toBeUndefined();
    } finally {
      ctx.cleanup();
    }
  });

  // M2 R2 — Patch row M2-R2-4 — continuityOutcome stays at the
  // fresh-launch default when starter is the only continuity source.
  // Per startup-orchestrator.ts:114, continuityOutcome is derived from
  // `input.resumeToken` / `input.forkSource` / `input.rebuildArtifacts`
  // (initialized as "fresh" when none are present). A starter-only
  // member must not set any of these, so continuityOutcome stays at
  // "fresh" — proving STARTER is purely an additive guidance layer and
  // does NOT masquerade as a continuity surface (which would be Finding 1
  // territory).
  it("M2-R2-4: continuityOutcome stays 'fresh' when starter is the only continuity source", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    const startNodeSpy = vi.spyOn(
      ctx.inst["deps"].startupOrchestrator!,
      "startNode",
    );
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // Assert the startup-orchestrator was called with no continuity
      // surfaces — these are exactly the inputs that would change
      // continuityOutcome away from "fresh" per the orchestrator's
      // initial-value branch.
      expect(startNodeSpy).toHaveBeenCalled();
      const startNodeInput = startNodeSpy.mock.calls[0]![0];
      expect(startNodeInput.resumeToken).toBeUndefined();
      expect(startNodeInput.forkSource).toBeUndefined();
      const rebuildArr = startNodeInput.rebuildArtifacts ?? [];
      expect(rebuildArr.length).toBe(0);

      // Belt-and-suspenders: assert the resolved promise carries
      // continuityOutcome === "fresh" (the orchestrator surfaces it on
      // success).
      const startNodeResult = await startNodeSpy.mock.results[0]!.value as
        | { ok: true; continuityOutcome: string }
        | { ok: false };
      expect(startNodeResult.ok).toBe(true);
      if (startNodeResult.ok) {
        expect(startNodeResult.continuityOutcome).toBe("fresh");
      }
    } finally {
      ctx.cleanup();
    }
  });

  // M2 R2 — Patch row M2-R2-4 — STARTER layer carries through SQLite
  // roundtrip via `node_startup_context.resolved_files_json`. The
  // startup-orchestrator persists the consumed `input.resolvedStartupFiles`
  // verbatim at startup-orchestrator.ts:293-301; on restore replay the
  // STARTER layer must come back intact (its absence here would imply
  // the layer was held only in transient memory and would silently
  // vanish across daemon restart).
  it("M2-R2-4: STARTER layer survives node_startup_context.resolved_files_json roundtrip", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.result.nodes.find((n) => n.logicalId === "dev.impl");
      expect(node).toBeDefined();
      // The instantiator's NodeOutcome carries logicalId only; resolve the
      // DB nodeId via the rig record (logicalId is the qualifiedId stored
      // on the node row).
      const rig = ctx.rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
      const dbNode = rig!.nodes.find((n) => n.logicalId === "dev.impl");
      expect(dbNode, "expected dev.impl node row in rig").toBeDefined();
      const nodeId = dbNode!.id;

      const row = ctx.db
        .prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?")
        .get(nodeId) as { resolved_files_json: string } | undefined;

      expect(row, "expected node_startup_context row to exist after launch").toBeDefined();
      const persisted = JSON.parse(row!.resolved_files_json) as Array<{
        path: string;
        ownerRoot: string;
        appliesOn: string[];
        deliveryHint: string;
      }>;
      expect(Array.isArray(persisted)).toBe(true);
      expect(persisted.length).toBeGreaterThan(0);
      // STARTER layer must be at index 0 (resolver result, ownerRoot =
      // registryRoot, appliesOn = ["fresh_start"], deliveryHint =
      // "guidance_merge"). Survival across the JSON roundtrip is the proof.
      expect(persisted[0]!.ownerRoot).toBe(ctx.registryRoot);
      expect(persisted[0]!.path).toBe("fixture-starter.yaml");
      expect(persisted[0]!.appliesOn).toEqual(["fresh_start"]);
      expect(persisted[0]!.deliveryHint).toBe("guidance_merge");
    } finally {
      ctx.cleanup();
    }
  });

  it("composition: starterRef + sessionSource.mode='rebuild' both fire on fresh_start", async () => {
    // Create a real artifact file that the rebuild resolver can find.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-rebuild-"));
    const rebuildArtifactPath = path.join(tmpDir, "rebuild-artifact.md");
    fs.writeFileSync(rebuildArtifactPath, "rebuild context fixture");

    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      const spec: RigSpec = {
        version: "0.2",
        name: "compose-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "fixture-starter" },
            sessionSource: {
              mode: "rebuild",
              ref: { kind: "artifact_set", value: [rebuildArtifactPath] },
            },
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // Adapter.deliverStartup receives the STARTER layer prepended.
      // The rebuild artifacts are passed via a separate `rebuildArtifacts`
      // kwarg to startNode (not via resolvedStartupFiles), so they don't
      // appear in deliverStartup's files arg — but the launch should
      // still succeed.
      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const filesArg = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];
      // STARTER layer is at the front
      expect(filesArg[0]!.ownerRoot).toBe(ctx.registryRoot);
    } finally {
      ctx.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
