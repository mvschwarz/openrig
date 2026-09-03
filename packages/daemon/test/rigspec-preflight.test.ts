import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nodePath from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import type { LegacyRigSpec as RigSpec } from "../src/domain/types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, nodeSpecFieldsSchema, rigArchiveSchema]);
  return db;
}

function mockTmux(sessionExists: Record<string, boolean> = {}): TmuxAdapter {
  return {
    hasSession: vi.fn(async (name: string) => sessionExists[name] ?? false),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

function validSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    schemaVersion: 1,
    name: "r99",
    version: "1.0.0",
    nodes: [
      { id: "worker", runtime: "claude-code", cwd: "/" },
    ],
    edges: [],
    ...overrides,
  };
}

describe("RigSpecPreflight", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPreflight(opts?: { tmux?: TmuxAdapter; exec?: ExecFn; cmuxExec?: ExecFn }) {
    return new RigSpecPreflight({
      rigRepo,
      tmuxAdapter: opts?.tmux ?? mockTmux(),
      exec: opts?.exec ?? (async () => ""),
      cmuxExec: opts?.cmuxExec ?? (async () => ""),
    });
  }

  it("all checks pass -> { ready: true, warnings: [], errors: [] }", async () => {
    const pf = createPreflight();
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("rig name collision -> error", async () => {
    rigRepo.createRig("r99"); // collision
    const pf = createPreflight();
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("r99"))).toBe(true);
  });

  it("M1 A1 — a rig named a virtual-domain token ('external') is REFUSED (rig-slot reserved rail)", async () => {
    const pf = createPreflight();
    const result = await pf.check(validSpec({ name: "external" }));
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("external") && /reserved|virtual-domain/i.test(e))).toBe(true);
  });

  it("tmux session name collision -> error", async () => {
    const tmux = mockTmux({ "r99-worker": true });
    const pf = createPreflight({ tmux });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("r99-worker"))).toBe(true);
  });

  it("derived session name is normalized for ordinary rig names", async () => {
    const spec = validSpec({ name: "badname" });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.some((e) => e.includes("session name"))).toBe(false);
  });

  it("node cwd doesn't exist -> error", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/nonexistent/path/xyz" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("/nonexistent/path/xyz"))).toBe(true);
  });

  it("claude-code probes 'claude --version' (exact command)", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    await pf.check(validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
    }));
    const claudeCall = exec.mock.calls.find((c: unknown[]) => (c[0] as string).includes("claude"));
    expect(claudeCall).toBeDefined();
    expect(claudeCall![0]).toBe("claude --version");
  });

  it("codex probes 'codex --version' (exact command)", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    await pf.check(validSpec({
      nodes: [{ id: "worker", runtime: "codex", cwd: "/" }],
    }));
    const codexCall = exec.mock.calls.find((c: unknown[]) => (c[0] as string).includes("codex"));
    expect(codexCall).toBeDefined();
    expect(codexCall![0]).toBe("codex --version");
  });

  it("runtime not available -> error", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const pf = createPreflight({ exec });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("claude-code"))).toBe(true);
  });

  it("cwd points to a file -> error", async () => {
    // /etc/hosts is a file, not a directory
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/etc/hosts" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("/etc/hosts") && e.includes("directory"))).toBe(true);
  });

  it("cwd points to a directory -> passes cwd check", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/tmp" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    // Should not have a cwd error (may have other errors like session name)
    expect(result.errors.filter((e) => e.includes("cwd") || e.includes("/tmp"))).toHaveLength(0);
  });

  it("multiple errors reported (2 bad cwds -> 2 errors)", async () => {
    const spec = validSpec({
      nodes: [
        { id: "worker-a", runtime: "claude-code", cwd: "/bad/path/a" },
        { id: "worker-b", runtime: "claude-code", cwd: "/bad/path/b" },
      ],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.filter((e) => e.includes("/bad/path")).length).toBe(2);
  });

  it("cmux unavailable + spec has surfaceHint -> warning", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", surfaceHint: "tab:main" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.some((w) => w.toLowerCase().includes("cmux"))).toBe(true);
  });

  it("cmux unavailable + spec has NO layout hints -> no warning", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.filter((w) => w.toLowerCase().includes("cmux"))).toHaveLength(0);
  });

  it("node with no cwd -> no cwd check (passes)", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code" }], // no cwd
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.filter((e) => e.includes("cwd"))).toHaveLength(0);
  });

  it("tmux session name collision detected (derived name exists)", async () => {
    const tmux = mockTmux({ "r99-worker": true });
    const pf = createPreflight({ tmux });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("tmux") || e.includes("session"))).toBe(true);
  });

  it("spec with workspace hint + cmux unavailable -> warning", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", workspace: "review" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.some((w) => w.toLowerCase().includes("cmux"))).toBe(true);
  });

  it("error + warning coexist: bad cwd + cmux unavailable with layout hint", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/nonexistent/bad", surfaceHint: "tab:x" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("cmux availability probed via 'cmux capabilities --json' (exact command)", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockResolvedValue("{}");
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", surfaceHint: "tab:x" }],
    });
    const pf = createPreflight({ cmuxExec });
    await pf.check(spec);
    expect(cmuxExec).toHaveBeenCalledWith("cmux capabilities --json");
  });
});

// -- Rebooted rig preflight (AgentSpec reboot) --

import { rigPreflight, type RigPreflightInput } from "../src/domain/rigspec-preflight.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

function validAgentYaml(name: string, opts?: { profiles?: string }): string {
  const profiles = opts?.profiles ?? "profiles:\n  default:\n    uses:\n      skills: []";
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\n${profiles}`;
}

function makeRigYaml(overrides?: Partial<PodRigSpec>): string {
  const spec: PodRigSpec = {
    version: "0.2", name: "test-rig",
    pods: [{
      id: "dev", label: "Dev",
      members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
      edges: [],
    }],
    edges: [],
    ...overrides,
  };
  return RigSpecCodec.serialize(spec);
}

const RIG_ROOT = "/project/rigs/my-rig";

describe("Rebooted rig preflight", () => {
  it("resolves a selector-only profile from the configured managed skill catalog", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-preflight-skill-catalog-"));
    try {
      const rigRoot = nodePath.join(root, "rig");
      const catalog = nodePath.join(root, "managed-skills");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(rigRoot, "agents", "impl"), { recursive: true });
      fs.mkdirSync(nodePath.join(rigRoot, "agents", "shared"), { recursive: true });
      fs.mkdirSync(nodePath.join(catalog, "topology-skill"), { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(
        nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
        `name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [topology-skill]
  missing:
    uses:
      skills: [absent-skill]
`,
      );
      fs.writeFileSync(
        nodePath.join(rigRoot, "agents", "shared", "agent.yaml"),
        "name: shared\nversion: \"1.0.0\"\nresources:\n  skills: []\nprofiles: {}\n",
      );
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(
        nodePath.join(catalog, "topology-skill", "SKILL.md"),
        "---\nname: topology-skill\ndescription: Use when testing selector-only preflight.\n---\n\n# Topology skill\n",
      );
      execFileSync("git", ["-C", root, "init", "-q"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

      const rigSpecYaml = makeRigYaml({
        pods: [{
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project }],
          edges: [],
        }],
      });
      const input: RigPreflightInput = {
        rigSpecYaml,
        rigRoot,
        fsOps: {
          readFile: (path: string) => fs.readFileSync(path, "utf-8"),
          exists: (path: string) => fs.existsSync(path),
        },
        skillsRoot: catalog,
      };

      const result = await rigPreflight(input);

      expect(result.ready, JSON.stringify(result.errors)).toBe(true);
      expect(result.errors).toEqual([]);

      const missingResult = await rigPreflight({
        ...input,
        rigSpecYaml: makeRigYaml({
          pods: [{
            id: "dev", label: "Dev",
            members: [{ id: "impl", agentRef: "local:agents/impl", profile: "missing", runtime: "codex", cwd: project }],
            edges: [],
          }],
        }),
      });
      expect(missingResult.ready).toBe(false);
      expect(missingResult.errors).toContain('dev.impl: Profile uses skills: "absent-skill" not found in resource pool');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // T5: resolves all agent refs
  it("resolves all agent refs successfully", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T5b: missing profile surfaces in preflight
  it("catches missing profile", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "nonexistent", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent") && e.includes("not found"))).toBe(true);
  });

  // T5c: invalid restore-policy narrowing surfaces
  it("catches invalid restore-policy narrowing", async () => {
    const agentYaml = `name: impl\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\n    restore_policy: checkpoint_only\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml,
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", restorePolicy: "resume_if_possible" }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("broadens"))).toBe(true);
  });

  // T6: unsupported runtime
  it("reports unsupported runtime", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "unsupported-runtime", cwd: "." }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("unsupported runtime"))).toBe(true);
  });

  // Slice 51-01 stub-runtime — TEST-ONLY RED (undisputed mechanical FACT 1): a modern pod member
  // with runtime: stub + a resolvable agent_ref must be ACCEPTED by preflight. RED now because
  // SUPPORTED_RUNTIMES (rigspec-preflight.ts:133) omits "stub"; green once production adds it there.
  // Encodes NO disputed hook/usage/compaction/packaging surface.
  it("FACT1: accepts a modern pod member with runtime: stub + resolvable agent_ref [RED until SUPPORTED_RUNTIMES adds stub]", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready, `preflight must accept runtime: stub; errors: ${JSON.stringify(result.errors)}`).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T7: missing cwd
  it("reports missing cwd", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    // Can't have empty cwd since RigSpec schema requires it — test with RigSpec that has cwd but empty
    // Actually, cwd is required on RigSpecPodMember, so an empty cwd would fail schema validation.
    // Let's verify the schema catches it.
    const rigYaml = `version: "0.2"\nname: test-rig\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n    edges: []\nedges: []`;
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("cwd"))).toBe(true);
  });

  // T8: import collision as warning
  it("rejects invalid session name characters in authored pod/member/rig names with per-component error", async () => {
    const rigYaml = makeRigYaml({
      name: "my rig",
      pods: [{
        id: "dev 1", label: "Dev",
        members: [{ id: "impl!", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    // Per-component errors for pod, member, and rig name
    expect(result.errors.some((e) => e.includes("pod name") && e.includes("dev 1") && e.includes(" "))).toBe(true);
    expect(result.errors.some((e) => e.includes("member name") && e.includes("impl!") && e.includes("!"))).toBe(true);
    expect(result.errors.some((e) => e.includes("rig name") && e.includes("my rig") && e.includes(" "))).toBe(true);
  });

  it("reports import collision as warning", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nimports:\n  - ref: local:../lib\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles:\n  default:\n    uses:\n      skills: [shared]`,
      [`${RIG_ROOT}/agents/lib/agent.yaml`]: `name: lib\nversion: "1.0.0"\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles: {}`,
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(true);
    expect(result.warnings.some((w) => w.includes("collision"))).toBe(true);
  });

  it("fails honestly when builtin/library cwd resolves inside the OpenRig install without --cwd", async () => {
    const builtinRoot = nodePath.resolve(import.meta.dirname, "../src/../specs");
    const files: Record<string, string> = {
      [`${builtinRoot}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: builtinRoot, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("inside the OpenRig installation"))).toBe(true);
    expect(result.errors.some((e) => e.includes("--cwd"))).toBe(true);
  });

  it("accepts builtin/library specs when cwdOverride is provided", async () => {
    const builtinRoot = nodePath.resolve(import.meta.dirname, "../src/../specs");
    const files: Record<string, string> = {
      [`${builtinRoot}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({
      rigSpecYaml: makeRigYaml(),
      rigRoot: builtinRoot,
      cwdOverride: "/workspace/project",
      fsOps: mockFs(files),
    });
    expect(result.ready).toBe(true);
  });
});
