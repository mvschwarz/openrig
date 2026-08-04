import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SystemPreflight } from "../../cli/src/system-preflight.js";

const RIG_ROOT = "/project/rigs/policy-discovery";
const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;
const COLLIDING_AGENT_YAML = `name: impl
version: "1.0.0"
imports:
  - ref: local:../lib
resources:
  skills:
    - id: shared
      path: skills/shared
profiles:
  default:
    uses:
      skills: [shared]
`;
const COLLIDING_IMPORT_YAML = `name: lib
version: "1.0.0"
resources:
  skills:
    - id: shared
      path: skills/shared
profiles: {}
`;
const CUSTOM_POLICY = `---
policy_schema_version: 1
name: operator-full
source: custom
description: full-bypass flag policy
surface: flag
launch_posture: full_bypass
---
# Operator full
`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (path) => path.includes("agents/impl") || path.endsWith("policies/operator-full.md"),
    readFile: (path) => {
      if (path.includes("agents/impl")) return AGENT_YAML;
      if (path.endsWith("policies/operator-full.md")) return CUSTOM_POLICY;
      throw new Error(`Not found: ${path}`);
    },
  };
}

function collisionFsOps(): AgentResolverFsOps {
  return {
    exists: (path) => path.includes("agents/impl") || path.includes("agents/lib"),
    readFile: (path) => {
      if (path.includes("agents/impl")) return COLLIDING_AGENT_YAML;
      if (path.includes("agents/lib")) return COLLIDING_IMPORT_YAML;
      throw new Error(`Not found: ${path}`);
    },
  };
}

function rigYaml(opts: { name?: string; rigPolicy?: string; memberPolicy?: string } = {}): string {
  const rigPolicy = opts.rigPolicy ? `permission_policy: ${opts.rigPolicy}\n` : "";
  const memberPolicy = opts.memberPolicy ? `        permission_policy: ${opts.memberPolicy}\n` : "";
  return `version: "0.2"
name: ${opts.name ?? "policy-discovery"}
${rigPolicy}pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
${memberPolicy}        cwd: .
    edges: []
edges: []
`;
}

const policyLines = (warnings: string[]) => warnings.filter((warning) => warning.includes("permission_policy"));

describe("Seam C permission-policy discovery", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces an attached builtin ref with honest origin and bound posture", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:yolo" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(policyLines(result.warnings)).toEqual([
      'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
    ]);
  });

  it("surfaces the per-member custom override instead of the rig-level policy", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:standard", memberPolicy: "policies/operator-full.md" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });

    expect(result.ready).toBe(true);
    expect(policyLines(result.warnings)).toEqual([
      'dev.impl: permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
    ]);
    expect(result.warnings.join("\n")).not.toContain("builtin:standard");
  });

  it("surfaces honest absence as the floor without errors or blocking", async () => {
    const result = await rigPreflight({ rigSpecYaml: rigYaml(), rigRoot: RIG_ROOT, fsOps: fsOps() });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(policyLines(result.warnings)).toEqual([
      "dev.impl: permission_policy absent; launch_posture=floor",
    ]);
  });

  it("carries policy discovery and existing preflight advisories through materialize in order", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: collisionFsOps() });
      const outcome = await setup.podInstantiator.materialize(
        rigYaml({ name: "policy-materialize-warnings", rigPolicy: "builtin:yolo" }),
        RIG_ROOT,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.warnings).toEqual([
        'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
        'dev.impl: base/import collision in skills on "shared"',
      ]);
    } finally {
      db.close();
    }
  });

  it("carries policy discovery and existing preflight advisories through instantiate in order", async () => {
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: collisionFsOps(),
      });
      const outcome = await setup.podInstantiator.instantiate(
        rigYaml({ name: "policy-instantiate-warnings", rigPolicy: "builtin:yolo" }),
        RIG_ROOT,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.warnings).toEqual([
        'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
        'dev.impl: base/import collision in skills on "shared"',
      ]);
    } finally {
      db.close();
    }
  });

  it("carries structured materialize warnings through the public expansion response in order", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: collisionFsOps() });
      const rig = setup.rigRepo.createRig("policy-expand-warnings");
      const response = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rigRoot: RIG_ROOT,
          pod: {
            id: "dev",
            label: "Dev",
            members: [{
              id: "impl",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              permission_policy: "builtin:yolo",
              cwd: ".",
            }],
            edges: [],
          },
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { warnings: string[] };
      expect(body.warnings).toEqual([
        'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
        'dev.impl: base/import collision in skills on "shared"',
      ]);
    } finally {
      db.close();
    }
  });

  it("discovers persisted target-rig policy provenance and matches the launch binding", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: agentOnlyFsOps,
      });
      const rig = setup.rigRepo.createRig("persisted-policy-target");
      setup.rigRepo.setRigPermissionPolicy(rig.id, "policies/operator-full.md");
      setup.rigRepo.setRigPolicyProvenance(rig.id, {
        origin: "custom",
        resolvedTarget: "/original/rig/policies/operator-full.md",
        declaringDir: "/original/rig",
        launchPosture: "full_bypass",
      });
      const specObject = {
        version: "0.2",
        name: rig.name,
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }, {
            id: "override",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            permission_policy: "builtin:standard",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      };

      const materialized = await setup.podInstantiator.materializeStructured(
        specObject,
        "/different/operation-root",
        { targetRigId: rig.id },
      );
      expect(materialized.ok).toBe(true);
      if (!materialized.ok) return;
      expect(materialized.result.warnings).toEqual([
        'dev.impl: permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
        'dev.override: permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
      ]);

      const launched = await setup.podInstantiator.launchValidatedSpec(
        PodRigSpecSchema.normalize(specObject),
        "/different/operation-root",
        rig.id,
      );
      expect(launched.ok).toBe(true);
      expect(bindings.map((binding) => binding.launchPosture)).toEqual(["full_bypass", "floor"]);
    } finally {
      db.close();
    }
  });

  it("keeps launch outcomes identical while carrying discovery on the rig-up result", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: fsOps(),
      });
      const absent = await setup.podInstantiator.instantiate(rigYaml({ name: "policy-absent" }), RIG_ROOT);
      const attached = await setup.podInstantiator.instantiate(
        rigYaml({ name: "policy-attached", rigPolicy: "builtin:locked" }),
        RIG_ROOT,
      );

      expect(absent.ok).toBe(true);
      expect(attached.ok).toBe(true);
      if (!absent.ok || !attached.ok) return;
      expect(absent.result.nodes.map(({ logicalId, status }) => ({ logicalId, status })))
        .toEqual(attached.result.nodes.map(({ logicalId, status }) => ({ logicalId, status })));
      expect(bindings).toHaveLength(2);
      expect(policyLines(absent.result.warnings ?? [])).toEqual([
        "dev.impl: permission_policy absent; launch_posture=floor",
      ]);
      expect(policyLines(attached.result.warnings ?? [])).toEqual([
        'dev.impl: permission_policy ref="builtin:locked" origin=builtin launch_posture=floor',
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps SYSTEM setup preflight policy-blind while rig lifecycle preflight discovers policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "seam-c-system-preflight-"));
    tempDirs.push(home);
    const system = new SystemPreflight({
      exec: async (cmd) => cmd === "tmux -V" ? "tmux 3.6" : "",
      configStore: {
        resolve: () => ({
          daemon: { host: "127.0.0.1", port: 0 },
          db: { path: join(home, "openrig.db") },
          transcripts: { path: join(home, "transcripts") },
        }),
      } as never,
      getDaemonStatus: async () => ({ state: "stopped" }),
      openrigHome: home,
    });

    const systemResult = await system.run({ port: 0 });
    expect(JSON.stringify(systemResult)).not.toContain("permission_policy");

    const lifecycleResult = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:standard" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });
    expect(policyLines(lifecycleResult.warnings)).toHaveLength(1);
  });

  it("rejects an invalid ref upstream and never misreports it as floor discovery", async () => {
    const invalid = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:missing" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });

    expect(invalid.ready).toBe(false);
    expect(invalid.errors.join("\n")).toContain("unknown built-in policy 'missing'");
    expect(policyLines(invalid.warnings)).toEqual([]);

    const valid = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:standard" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });
    expect(valid.ready).toBe(true);
    expect(policyLines(valid.warnings)).toEqual([
      'dev.impl: permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
    ]);
  });
});
