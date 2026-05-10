import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { resolveAgentRef, type AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { planProjection } from "../src/domain/projection-planner.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { StartupAction } from "../src/domain/types.js";

function mockTmux(): TmuxAdapter {
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

function mockAdapter(fsCheck?: AgentResolverFsOps): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: ["skill-a"], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async (files: ResolvedStartupFile[]) => {
      // Validate paths if fsCheck provided
      const failed: Array<{ path: string; error: string }> = [];
      if (fsCheck) {
        for (const f of files) {
          if (!fsCheck.exists(f.absolutePath)) {
            failed.push({ path: f.path, error: `File not found at absolutePath: ${f.absolutePath}` });
          }
        }
      }
      return { delivered: files.length - failed.length, failed };
    }),
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

describe("AgentSpec startup integration", () => {
  // T12: rig.yaml + agent.yaml resolves, projects, starts, and reaches startup_status: ready
  it("full startup lifecycle: resolve -> project -> start -> ready", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    // 1. Set up rig spec + agent spec on mock filesystem
    const rigRoot = "/project/rigs/my-rig";
    const rigSpecYaml = RigSpecCodec.serialize({
      version: "0.2", name: "integration-rig",
      pods: [{
        id: "dev", label: "Dev",
        members: [{
          id: "impl", agentRef: "local:agents/impl", profile: "default",
          runtime: "claude-code", cwd: ".",
          startup: {
            files: [{ path: "pods/dev/overlays/impl.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }],
            actions: [{ type: "slash_command" as const, value: "/rename impl", phase: "after_ready" as const, appliesOn: ["fresh_start" as const], idempotent: true }],
          },
        }],
        edges: [],
      }],
      edges: [],
    });

    const agentYaml = `name: impl\nversion: "1.0.0"\nstartup:\n  files:\n    - path: startup/base.md\n      delivery_hint: auto\nresources:\n  skills:\n    - id: skill-a\n      path: skills/a\nprofiles:\n  default:\n    uses:\n      skills: [skill-a]`;

    const fs = mockFs({
      [`${rigRoot}/agents/impl/agent.yaml`]: agentYaml,
      [`${rigRoot}/pods/dev/overlays/impl.md`]: "# Impl overlay",
      [`${rigRoot}/agents/impl/startup/base.md`]: "# Base startup",
    });
    const adapter = mockAdapter(fs);

    // 2. Parse rig spec
    const rawRig = RigSpecCodec.parse(rigSpecYaml);
    const rigSpec = RigSpecSchema.normalize(rawRig as Record<string, unknown>);
    const member = rigSpec.pods[0]!.members[0]!;

    // 3. Resolve agent ref
    const resolveResult = resolveAgentRef(member.agentRef, rigRoot, fs);
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    // 4. Resolve node config (profile + precedence)
    const configResult = resolveNodeConfig({
      baseSpec: resolveResult.resolved,
      importedSpecs: resolveResult.imports,
      collisions: resolveResult.collisions,
      profileName: member.profile,
      member,
      pod: rigSpec.pods[0]!,
      rig: rigSpec,
    });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    // 5. Plan projection
    const planResult = planProjection({
      config: configResult.config,
      collisions: resolveResult.collisions,
      fsOps: { readFile: fs.readFile, exists: fs.exists },
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    // 6. Create rig + node + session (simulating NodeLauncher)
    const rig = rigRepo.createRig("integration-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    // 7. Build startup input
    const binding: NodeBinding = {
      id: "b1", nodeId: node.id, tmuxSession: "r01-impl",
      tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null,
      updatedAt: "", cwd: ".",
    };

    // Build resolved startup files with correct owner roots per source
    // Agent base startup files resolve under agent root, member overlay files under rig root
    const agentRoot = resolveResult.resolved.sourcePath;
    const resolvedFiles: ResolvedStartupFile[] = configResult.config.startup.files.map((f) => {
      // Determine owner root: agent startup paths resolve under agent, rig/pod/member under rig
      const isAgentFile = f.path.startsWith("startup/");
      const ownerRoot = isAgentFile ? agentRoot : rigRoot;
      return {
        path: f.path,
        absolutePath: `${ownerRoot}/${f.path}`,
        ownerRoot,
        deliveryHint: f.deliveryHint,
        required: f.required,
        appliesOn: f.appliesOn,
      };
    });

    // 8. Run startup orchestrator
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupResult = await orchestrator.startNode({
      rigId: rig.id,
      nodeId: node.id,
      sessionId: session.id,
      binding,
      adapter,
      plan: planResult.plan,
      resolvedStartupFiles: resolvedFiles,
      startupActions: configResult.config.startup.actions,
      isRestore: false,
    });

    // 9. Verify: startup_status = ready
    expect(startupResult.ok).toBe(true);
    expect(startupResult.startupStatus).toBe("ready");

    const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as { startup_status: string; startup_completed_at: string | null };
    expect(sessionRow.startup_status).toBe("ready");
    expect(sessionRow.startup_completed_at).not.toBeNull();

    // Verify events
    const events = db.prepare("SELECT type FROM events ORDER BY seq").all() as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain("node.startup_pending");
    expect(types).toContain("node.startup_ready");

    db.close();
  });

  it("builtin-style shared import projects openrig-user under the shipped unqualified skill id", () => {
    const rigRoot = "/project/rigs/my-rig";
    const rigSpecYaml = RigSpecCodec.serialize({
      version: "0.2", name: "integration-rig",
      pods: [{
        id: "dev", label: "Dev",
        members: [{
          id: "impl", agentRef: "local:agents/impl", profile: "default",
          runtime: "claude-code", cwd: ".",
        }],
        edges: [],
      }],
      edges: [],
    });

    const fs = mockFs({
      [`${rigRoot}/agents/impl/agent.yaml`]: `
name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [openrig-user]
      guidance: []
      subagents: []
      runtime_resources: []
`.trim(),
      [`${rigRoot}/agents/shared/agent.yaml`]: `
name: shared
version: "1.0.0"
resources:
  skills:
    - id: openrig-user
      path: skills/openrig-user
profiles: {}
`.trim(),
      [`${rigRoot}/agents/shared/skills/openrig-user/SKILL.md`]: "---\nname: openrig-user\n---\n# OpenRig User\n",
    });

    const rawRig = RigSpecCodec.parse(rigSpecYaml);
    const rigSpec = RigSpecSchema.normalize(rawRig as Record<string, unknown>);
    const member = rigSpec.pods[0]!.members[0]!;

    const resolveResult = resolveAgentRef(member.agentRef, rigRoot, fs);
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    const configResult = resolveNodeConfig({
      baseSpec: resolveResult.resolved,
      importedSpecs: resolveResult.imports,
      collisions: resolveResult.collisions,
      profileName: member.profile,
      member,
      pod: rigSpec.pods[0]!,
      rig: rigSpec,
      specRoot: rigRoot,
    });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    const planResult = planProjection({
      config: configResult.config,
      collisions: resolveResult.collisions,
      fsOps: { readFile: fs.readFile, exists: fs.exists },
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const projectedSkill = planResult.plan.entries.find((entry) => entry.category === "skill");
    expect(projectedSkill).toBeDefined();
    expect(projectedSkill!.effectiveId).toBe("openrig-user");
    expect(projectedSkill!.sourceSpec).toBe("shared");
    expect(projectedSkill!.sourcePath).toBe(`${rigRoot}/agents/shared`);
    expect(projectedSkill!.absolutePath).toBe(`${rigRoot}/agents/shared/skills/openrig-user`);
  });
});
