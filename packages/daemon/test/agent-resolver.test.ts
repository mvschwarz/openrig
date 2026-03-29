import { describe, it, expect } from "vitest";
import { resolveAgentRef, type AgentResolverFsOps } from "../src/domain/agent-resolver.js";

/** Helper: create a minimal valid agent.yaml */
function validAgentYaml(overrides?: { name?: string; version?: string; imports?: string; resources?: string }): string {
  const name = overrides?.name ?? "test-agent";
  const version = overrides?.version ?? "1.0.0";
  const imports = overrides?.imports ?? "";
  const resources = overrides?.resources ?? "resources:\n  skills: []\n  guidance: []\n  subagents: []\n  hooks: []\n  runtime_resources: []";
  return `name: ${name}\nversion: "${version}"\n${imports}\n${resources}\nprofiles: {}`;
}

function validAgentYamlWithSkill(name: string, skillId: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills:\n    - id: ${skillId}\n      path: skills/${skillId}\nprofiles: {}`;
}

/** Mock filesystem */
function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`File not found: ${path}`);
    },
    exists: (path: string) => path in files,
  };
}

const RIG_ROOT = "/project/rigs/my-rig";

describe("AgentSpec source resolver + import resolver", () => {
  // T1: local: ref resolves relative to rig root
  it("local: ref resolves relative to rig root", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml(),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.spec.name).toBe("test-agent");
      expect(result.resolved.sourcePath).toBe("/project/rigs/my-rig/agents/impl");
    }
  });

  // T2: path: ref resolves as absolute path
  it("path: ref resolves as absolute path", () => {
    const fs = mockFs({
      "/abs/agents/impl/agent.yaml": validAgentYaml({ name: "abs-agent" }),
    });
    const result = resolveAgentRef("path:/abs/agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.spec.name).toBe("abs-agent");
      expect(result.resolved.sourcePath).toBe("/abs/agents/impl");
    }
  });

  // T3: missing agent.yaml fails with code not_found
  it("missing agent.yaml fails with not_found", () => {
    const fs = mockFs({});
    const result = resolveAgentRef("local:agents/missing", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.error).toContain("agent.yaml");
    }
  });

  // T4: invalid AgentSpec fails with validation_failed
  it("invalid AgentSpec fails with validation errors", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/bad/agent.yaml": "summary: no name or version",
    });
    const result = resolveAgentRef("local:agents/bad", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect((result as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
  });

  // T5: exact version match passes
  it("exact version match passes", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        imports: 'imports:\n  - ref: local:../lib\n    version: "1.0.0"',
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({ name: "lib", version: "1.0.0" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]!.spec.version).toBe("1.0.0");
    }
  });

  // T6: exact version mismatch fails
  it("exact version mismatch fails", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        imports: 'imports:\n  - ref: local:../lib\n    version: "2.0.0"',
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({ name: "lib", version: "1.0.0" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("version_mismatch");
      expect(result.error).toContain("2.0.0");
      expect(result.error).toContain("1.0.0");
    }
  });

  // T7: remote import source fails clearly
  it("remote import source fails at resolve time", () => {
    // Remote sources are rejected by AS-T01 validation, but also by resolver
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml":
        'name: impl\nversion: "1.0.0"\nimports:\n  - ref: "github:foo/bar"\nprofiles: {}',
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    // The validator rejects github: at parse time, so this should fail at validation
    expect(result.ok).toBe(false);
  });

  // T8: base/import collision produces diagnostic
  it("base/import collision produces diagnostic", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
        resources: "resources:\n  skills:\n    - id: shared-skill\n      path: skills/shared",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYamlWithSkill("lib", "shared-skill"),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collisions.length).toBeGreaterThan(0);
      const collision = result.collisions.find((c) => c.resourceId === "shared-skill");
      expect(collision).toBeDefined();
      expect(collision!.sources).toHaveLength(2);
    }
  });

  // T9: imported resource addressable by qualified id
  it("collision diagnostic includes qualified id", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
        resources: "resources:\n  skills:\n    - id: foo\n      path: skills/foo",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYamlWithSkill("lib", "foo"),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const collision = result.collisions.find((c) => c.resourceId === "foo");
      expect(collision).toBeDefined();
      const libSource = collision!.sources.find((s) => s.specName === "lib");
      expect(libSource!.qualifiedId).toBe("lib:foo");
    }
  });

  // T10: self-import rejected
  it("self-import (cycle) is rejected", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:.",
      }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cycle_detected");
    }
  });

  // T11: resolved spec hash is deterministic
  it("resolved spec hash is deterministic", () => {
    const yaml = validAgentYaml({ name: "stable" });
    const fs = mockFs({
      "/project/rigs/my-rig/agents/stable/agent.yaml": yaml,
    });
    const r1 = resolveAgentRef("local:agents/stable", RIG_ROOT, fs);
    const r2 = resolveAgentRef("local:agents/stable", RIG_ROOT, fs);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.resolved.hash).toBe(r2.resolved.hash);
      expect(r1.resolved.hash.length).toBe(64); // SHA-256 hex
    }
  });

  // T12: imported spec with non-empty imports -> rejected
  it("imported spec with nested imports is rejected", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({
        name: "lib",
        imports: "imports:\n  - ref: local:agents/nested",
      }),
      "/project/rigs/my-rig/agents/nested/agent.yaml": validAgentYaml({ name: "nested" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("import_error");
      expect(result.error).toContain("nested imports");
      expect(result.error).toContain("not supported in v1");
    }
  });

  // T13: import/import collision -> ResourceCollision with both sources
  it("import/import collision produces diagnostic with both qualified ids", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib-a\n  - ref: local:../lib-b",
      }),
      "/project/rigs/my-rig/agents/lib-a/agent.yaml": validAgentYamlWithSkill("lib-a", "shared"),
      "/project/rigs/my-rig/agents/lib-b/agent.yaml": validAgentYamlWithSkill("lib-b", "shared"),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const collision = result.collisions.find((c) => c.resourceId === "shared");
      expect(collision).toBeDefined();
      expect(collision!.sources).toHaveLength(2);
      expect(collision!.sources.map((s) => s.qualifiedId).sort()).toEqual(["lib-a:shared", "lib-b:shared"]);
    }
  });

  // T14: two imports resolving to same spec name -> rejected
  it("two imports with same spec name are rejected", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib-v1\n  - ref: local:../lib-v2",
      }),
      "/project/rigs/my-rig/agents/lib-v1/agent.yaml": validAgentYaml({ name: "lib" }),
      "/project/rigs/my-rig/agents/lib-v2/agent.yaml": validAgentYaml({ name: "lib" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("import_error");
      expect(result.error).toContain("Duplicate import name");
      expect(result.error).toContain("lib");
    }
  });

  // T15: imported spec name containing colon -> rejected
  it("imported spec name with colon is rejected", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({ name: "has:colon" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("import_error");
      expect(result.error).toContain("colon");
      expect(result.error).toContain("qualified ref syntax");
    }
  });
});
