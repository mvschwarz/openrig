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
import { ProbeTimeoutError, RUNTIME_PROBE_TIMEOUT_MS } from "../src/adapters/bounded-probe-exec.js";

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

  it("probes OMP independently of Pi for an OMP-only legacy rig", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    const result = await pf.check(validSpec({ nodes: [{ id: "worker", runtime: "omp", cwd: "/" }] }));
    expect(result.ready).toBe(true);
    expect(exec).toHaveBeenCalledWith("omp --version");
    expect(exec).not.toHaveBeenCalledWith("pi --version");
  });

  it("runtime not available -> error", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const pf = createPreflight({ exec });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("claude-code"))).toBe(true);
  });

  it.each([["claude-code", "claude"], ["codex", "codex"]])("a %s version check that hit the time limit says so, and nothing else", async (runtime, binary) => {
    const cmd = `${binary} --version`;
    const exec = vi.fn<ExecFn>().mockRejectedValue(new ProbeTimeoutError(cmd, RUNTIME_PROBE_TIMEOUT_MS));
    const result = await createPreflight({ exec }).check(validSpec({ nodes: [{ id: "worker", runtime: runtime as "codex", cwd: "/" }] }));
    expect(result.ready).toBe(false);
    expect(result.errors).toEqual([`\`${cmd}\` didn't answer within 30 s`]);
  });

  it("a Pi version check that hit the time limit stays a warning with the same message", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(new ProbeTimeoutError("pi --version", RUNTIME_PROBE_TIMEOUT_MS));
    const result = await createPreflight({ exec }).check(validSpec({ nodes: [{ id: "worker", runtime: "pi", cwd: "/" }] }));
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(["`pi --version` didn't answer within 30 s"]);
  });

  it("a runtime that fails some other way keeps its 'not available' error", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(Object.assign(new Error("x"), { code: "ETIMEDOUT" }));
    const result = await createPreflight({ exec }).check(validSpec());
    expect(result.errors).toEqual(["Runtime 'claude-code' not available (claude --version failed: ETIMEDOUT)"]);
  });

  it("reports old Pi versions in legacy preflight without blocking", async () => {
    const pf = createPreflight({ exec: async () => "0.73.1" });
    const result = await pf.check(validSpec({ nodes: [{ id: "worker", runtime: "pi", cwd: "/" }] }));
    expect(result.ready).toBe(true);
    expect(result.warnings.join("\n")).toContain("older than OpenRig's tested baseline");
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

  it("shows an unknown uses key as a launch warning, and stays ready", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skils: [review]`,
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(true);
    expect(result.warnings).toContain(`dev.impl: agent spec advisory (impl, ${RIG_ROOT}/agents/impl): profiles.default.uses.skils: unknown key ignored; known keys are skills, guidance, subagents, plugins, runtime_resources`);
  });

  it("shows an agent spec's advisories, its own and its imports', as launch warnings, and stays ready", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nimports:\n  - ref: local:../shared\ndefaults:\n  effort: 3\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`,
      [`${RIG_ROOT}/agents/shared/agent.yaml`]: `name: shared\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\nresources:\n  skills: []\nprofiles: {}`,
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(true);
    expect(result.warnings).toContain(`dev.impl: agent spec advisory (impl, ${RIG_ROOT}/agents/impl): defaults.effort: non-string value "3" ignored; effort must be a text value`);
    expect(result.warnings.filter((w) => w.startsWith(`dev.impl: agent spec advisory (shared, ${RIG_ROOT}/agents/shared): defaults.lifecycle.compaction_strategy: "harness_native" is deprecated`))).toHaveLength(1);
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


describe("seat login-shell PATH warning", () => {
  const isLookup = (command: string) => command.endsWith(" -lc 'command -v rig'");
  const warning = (warnings: string[]) => warnings.filter(text => text.includes("login-shell PATH"));
  async function preflight(exec: ExecFn, materializeOnly = false, runtime = "codex") {
    const member = { agentRef: "local:agents/impl", profile: "default", runtime, cwd: ".",
      env: { PATH: "/member/bin:/usr/bin", MEMBER_TAG: "member" } };
    const input = {
      rigSpecYaml: makeRigYaml({ env: { SHELL: "/bin/bash", PATH: "/rig/bin:/usr/bin", RIG_TAG: "rig" },
        pods: [{ id: "dev", label: "Dev", members: [{ ...member, id: "one" }, { ...member, id: "two" }], edges: [] }] }),
      rigRoot: RIG_ROOT, fsOps: mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl") }),
      exec, materializeOnly, envOverride: { PATH: "/override/bin:/usr/bin" },
    };
    return rigPreflight(input);
  }

  it("warns once for matching seat environments without refusing, with the login-profile fix", async () => {
    const exec = vi.fn<ExecFn>().mockImplementation(async command => {
      if (isLookup(command)) throw Object.assign(new Error("private diagnostic"), { code: 1 });
      return "available";
    });
    const result = await preflight(exec);
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(warning(result.warnings)).toHaveLength(1);
    expect(warning(result.warnings)[0]).toContain("dev.one, dev.two");
    expect(warning(result.warnings)[0]).toContain("~/.profile");
    expect(warning(result.warnings)[0]).toContain("bash -lc 'command -v node rig'");
    expect(warning(result.warnings)[0]).toContain("launch continues");
    expect(result.warnings.join("\n")).not.toContain("private diagnostic");
    const lookups = exec.mock.calls.map(([command]) => command).filter(isLookup);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain("'/bin/bash' -lc 'command -v rig'");
    expect(lookups[0]).toContain("'PATH=/override/bin:/usr/bin'");
    expect(lookups[0]).toContain("'RIG_TAG=rig'");
    expect(lookups[0]).toContain("'MEMBER_TAG=member'");
    expect(lookups[0]).not.toContain("/rig/bin");
    expect(lookups[0]).not.toContain("/member/bin");
  });

  it("reports an uncompleted login check as unconfirmed, with no new error or leaked command", async () => {
    const exec = vi.fn<ExecFn>().mockImplementation(async command => {
      if (isLookup(command)) throw new ProbeTimeoutError(command + " private diagnostic", RUNTIME_PROBE_TIMEOUT_MS);
      return "available";
    });
    const result = await preflight(exec);
    expect(result).toMatchObject({ ready: true, errors: [] });
    expect(warning(result.warnings)).toHaveLength(1);
    expect(warning(result.warnings)[0]).toContain("could not confirm");
    expect(warning(result.warnings)[0]).not.toContain("private diagnostic");
    expect(warning(result.warnings)[0]).not.toContain("/override/bin");
  });

  it("keeps a successful lookup quiet", async () => {
    const result = await preflight(async () => "/opt/node/bin/rig");
    expect(result).toMatchObject({ ready: true, errors: [] });
    expect(warning(result.warnings)).toEqual([]);
  });

  it("does not start a login-shell lookup for materialize-only preflight", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("available");
    const result = await preflight(exec, true);
    expect(result).toMatchObject({ ready: true, errors: [] });
    expect(exec.mock.calls.map(([command]) => command).filter(isLookup)).toEqual([]);
    expect(warning(result.warnings)).toEqual([]);
  });

  it("keeps a Claude-only pod quiet when rig exists only in its interactive shell", async () => {
    const exec = vi.fn<ExecFn>().mockImplementation(async command => {
      if (isLookup(command)) throw Object.assign(new Error("login PATH has no rig"), { code: 1 });
      return "available";
    });
    const result = await preflight(exec, false, "claude-code");
    expect(result).toMatchObject({ ready: true, errors: [] });
    expect(warning(result.warnings)).toEqual([]);
    expect(exec.mock.calls.map(([command]) => command).filter(isLookup)).toEqual([]);
  });

  it("keeps a Claude-only legacy launch quiet without a login-shell lookup", async () => {
    const db = setupDb();
    const exec = vi.fn<ExecFn>().mockImplementation(async command => {
      if (isLookup(command)) throw Object.assign(new Error("login PATH has no rig"), { code: 1 });
      return "available";
    });
    try {
      const preflight = new RigSpecPreflight({ rigRepo: new RigRepository(db), tmuxAdapter: mockTmux(), exec, cmuxExec: exec });
      const result = await preflight.check(validSpec());
      expect(result).toMatchObject({ ready: true, errors: [] });
      expect(warning(result.warnings)).toEqual([]);
      expect(exec.mock.calls.map(([command]) => command).filter(isLookup)).toEqual([]);
    } finally { db.close(); }
  });

  it("validates launch_wrapper[0] against daemon PATH for pi and codex members", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };

    // 1. Missing or directory wrapper executable on daemon PATH -> preflight error (fail closed)
    for (const badExec of ["definitely-missing-wrapper-bin-xyz987", "/usr/bin/"]) {
      const missingYaml = makeRigYaml({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "codex",
            cwd: ".",
            launchWrapper: [badExec, "--flag"],
          }],
          edges: [],
        }],
      });
      const missingResult = await rigPreflight({
        rigSpecYaml: missingYaml,
        rigRoot: RIG_ROOT,
        fsOps: mockFs(files),
        materializeOnly: true,
      });
      expect(missingResult.ready).toBe(false);
      expect(missingResult.errors).toContain(
        `dev.impl: Seat launch requires ${badExec} on the daemon launch PATH.`,
      );
    }

    // 2. Resolvable wrapper executable on daemon PATH (/bin/sh and dot-segment /bin/../bin/sh) -> passes preflight
    for (const wrapper of [["/bin/sh", "-c"], ["/bin/../bin/sh", "-c"]]) {
      const validYaml = makeRigYaml({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "pi",
            cwd: ".",
            launchWrapper: wrapper,
          }],
          edges: [],
        }],
      });
      const validResult = await rigPreflight({
        rigSpecYaml: validYaml,
        rigRoot: RIG_ROOT,
        fsOps: mockFs(files),
        materializeOnly: true,
      });
      expect(validResult.ready, JSON.stringify(validResult.errors)).toBe(true);
      expect(validResult.errors).toEqual([]);
    }

    // 3. Relative PATH entry in process.env.PATH resolves against daemon process.cwd(), not member cwd
    const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-preflight-wrapper-cwd-"));
    const origCwd = process.cwd();
    const origPath = process.env.PATH;
    try {
      const daemonDir = nodePath.join(tmpRoot, "daemon-cwd");
      const memberDir = nodePath.join(tmpRoot, "member-cwd");
      fs.mkdirSync(nodePath.join(daemonDir, "rel-bin"), { recursive: true });
      fs.mkdirSync(nodePath.join(memberDir, "rel-bin"), { recursive: true });

      const daemonWrapper = nodePath.join(daemonDir, "rel-bin", "daemon-only-wrapper");
      fs.writeFileSync(daemonWrapper, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
      const memberWrapper = nodePath.join(memberDir, "rel-bin", "member-only-wrapper");
      fs.writeFileSync(memberWrapper, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });

      process.chdir(daemonDir);
      process.env.PATH = `rel-bin${nodePath.delimiter}${origPath ?? ""}`;

      const daemonScopedYaml = makeRigYaml({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "codex",
            cwd: memberDir,
            launchWrapper: ["daemon-only-wrapper", "--"],
          }],
          edges: [],
        }],
      });
      const daemonScopedResult = await rigPreflight({
        rigSpecYaml: daemonScopedYaml,
        rigRoot: RIG_ROOT,
        fsOps: mockFs(files),
        materializeOnly: true,
      });
      expect(daemonScopedResult.ready, JSON.stringify(daemonScopedResult.errors)).toBe(true);
      expect(daemonScopedResult.errors).toEqual([]);

      const memberScopedYaml = makeRigYaml({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "codex",
            cwd: memberDir,
            launchWrapper: ["member-only-wrapper", "--"],
          }],
          edges: [],
        }],
      });
      const memberScopedResult = await rigPreflight({
        rigSpecYaml: memberScopedYaml,
        rigRoot: RIG_ROOT,
        fsOps: mockFs(files),
        materializeOnly: true,
      });
      expect(memberScopedResult.ready).toBe(false);
      expect(memberScopedResult.errors).toContain(
        "dev.impl: Seat launch requires member-only-wrapper on the daemon launch PATH.",
      );
    } finally {
      process.chdir(origCwd);
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
