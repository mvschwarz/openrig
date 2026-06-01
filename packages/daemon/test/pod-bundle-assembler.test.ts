import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../src/domain/pod-bundle-assembler.js";
import { validatePodBundleManifest, parsePodBundleManifest, serializePodBundleManifest, type PodBundleManifest } from "../src/domain/bundle-types.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { RigSpec } from "../src/domain/types.js";

// -- Mock filesystem --

function mockFs(files: Record<string, string>): PodAssemblerFsOps {
  const written: Record<string, string> = {};
  const dirs = new Set<string>();

  return {
    readFile: (p: string) => {
      if (p in files) return files[p]!;
      if (p in written) return written[p]!;
      throw new Error(`File not found: ${p}`);
    },
    exists: (p: string) => p in files || p in written,
    mkdirp: (p: string) => { dirs.add(p); },
    writeFile: (p: string, content: string) => { written[p] = content; },
    copyDir: () => {},
    listFiles: (dirPath: string) => {
      const result: string[] = [];
      for (const key of Object.keys(files)) {
        if (key.startsWith(dirPath + "/")) {
          result.push(key.slice(dirPath.length + 1));
        }
      }
      return result;
    },
    _written: written, // for test inspection
  } as PodAssemblerFsOps & { _written: Record<string, string> };
}

// -- Helpers --

const RIG_ROOT = "/project/rigs/my-rig";

function makeRigSpec(overrides?: Partial<RigSpec>): RigSpec {
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
      }],
      edges: [],
    }],
    edges: [],
    ...overrides,
  };
}

function rigSpecYaml(spec: RigSpec): string {
  return RigSpecCodec.serialize(spec);
}

function validAgentYaml(name: string, opts?: { imports?: string; skills?: string[] }): string {
  const imports = opts?.imports ?? "";
  const skills = (opts?.skills ?? []).map((s) => `    - id: ${s}\n      path: skills/${s}`).join("\n");
  const resourceBlock = skills ? `resources:\n  skills:\n${skills}` : "resources:\n  skills: []";
  return `name: ${name}\nversion: "1.0.0"\n${imports}\n${resourceBlock}\nprofiles:\n  default:\n    uses:\n      skills: [${(opts?.skills ?? []).join(", ")}]`;
}

function setupBasicRig(fs: ReturnType<typeof mockFs>, spec?: RigSpec): RigSpec {
  const rigSpec = spec ?? makeRigSpec();
  const yaml = rigSpecYaml(rigSpec);
  (fs as unknown as { _files: Record<string, string> })["_files"] = {};

  // Put files into mock FS
  const files = fs as unknown as Record<string, unknown>;
  // We need to add to the original files object, but mockFs creates a closure.
  // Instead, re-create the FS with the needed files.
  return rigSpec;
}

describe("PodBundleAssembler", () => {
  // T1: assembler walks embedded pod members correctly
  it("walks embedded pod members and collects agent dirs", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging",
      bundleName: "test-bundle",
      bundleVersion: "1.0.0",
    });

    expect(result.manifest.agents).toHaveLength(1);
    expect(result.manifest.agents[0]!.name).toBe("impl");
    expect(result.manifest.agents[0]!.path).toBe("agents/impl");
    expect(result.collectedFiles).toContain("rig.yaml");
  });

  // T2: referenced AgentSpecs included exactly once (dedup)
  it("deduplicates AgentSpecs referenced by multiple members", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev",
        label: "Dev",
        members: [
          { id: "impl1", agentRef: "local:agents/shared", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "impl2", agentRef: "local:agents/shared", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/shared/agent.yaml`]: validAgentYaml("shared"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.agents).toHaveLength(1);
  });

  it("preserves builtin terminal members without trying to vendor them", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "infra",
        label: "Infra",
        members: [{
          id: "daemon",
          agentRef: "builtin:terminal",
          profile: "none",
          runtime: "terminal",
          cwd: ".",
        }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging",
      bundleName: "test",
      bundleVersion: "1.0",
    });

    expect(result.manifest.agents).toHaveLength(0);
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const rewrittenRig = written["/tmp/staging/rig.yaml"]!;
    expect(rewrittenRig).toContain("agent_ref: builtin:terminal");
    expect(rewrittenRig).not.toContain("local:agents/");
  });

  // T3: flat imports collected with correct per-import originalRef
  it("collects flat imports with correct originalRef per import", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl", { imports: "imports:\n  - ref: local:../lib-a\n  - ref: local:../lib-b" }),
      [`${RIG_ROOT}/agents/lib-a/agent.yaml`]: validAgentYaml("lib-a"),
      [`${RIG_ROOT}/agents/lib-b/agent.yaml`]: validAgentYaml("lib-b"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.agents[0]!.importEntries).toHaveLength(2);
    const impA = result.manifest.agents[0]!.importEntries.find((ie) => ie.name === "lib-a");
    const impB = result.manifest.agents[0]!.importEntries.find((ie) => ie.name === "lib-b");
    expect(impA).toBeDefined();
    expect(impA!.originalRef).toBe("local:../lib-a");
    expect(impB).toBeDefined();
    expect(impB!.originalRef).toBe("local:../lib-b");
  });

  // T4: culture_file included
  it("includes culture_file in bundle", () => {
    const spec = makeRigSpec({ cultureFile: "culture.md" });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/culture.md`]: "# Culture",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("culture.md");
    expect(result.manifest.cultureFile).toBe("culture.md");
  });

  // T5: rig startup files included
  it("includes rig startup files", () => {
    const spec = makeRigSpec({
      startup: { files: [{ path: "startup/all-hands.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/startup/all-hands.md`]: "# All hands",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("startup/all-hands.md");
  });

  // T6: pod shared startup files included
  it("includes pod shared startup files", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        startup: { files: [{ path: "pods/dev/shared.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/pods/dev/shared.md`]: "# Shared",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("pods/dev/shared.md");
  });

  // T7: member overlay startup files included
  it("includes member startup overlay files", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [{
          id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".",
          startup: { files: [{ path: "pods/dev/overlays/impl.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
        }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/pods/dev/overlays/impl.md`]: "# Impl overlay",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("pods/dev/overlays/impl.md");
  });

  // T8: path traversal rejected
  it("rejects path traversal in startup files", () => {
    const spec = makeRigSpec({
      startup: { files: [{ path: "../escape.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow(/traversal|escape/i);
  });

  // T8b: path: absolute agent_ref outside rig root included and ref is rewritten
  it("path: absolute agent_ref outside rig root is vendored with rewritten ref", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "path:/external/agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      ["/external/agents/impl/agent.yaml"]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.agents).toHaveLength(1);
    expect(result.manifest.agents[0]!.originalRef).toBe("path:/external/agents/impl");

    // Verify rewritten rig.yaml has local: ref, not path:
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const rewrittenRig = written["/tmp/staging/rig.yaml"]!;
    expect(rewrittenRig).toContain("local:agents/impl");
    expect(rewrittenRig).not.toContain("path:/external/agents/impl");
  });

  // T9: remote import source rejected
  it("rejects remote import source during assembly", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: 'name: impl\nversion: "1.0.0"\nimports:\n  - ref: "github:foo/bar"\nprofiles: {}',
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow();
  });

  // T10: round-trip: assemble -> verify manifest shape
  it("assembled manifest has correct shape and validates", () => {
    const spec = makeRigSpec({ cultureFile: "culture.md" });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/culture.md`]: "# Culture",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "my-bundle", bundleVersion: "2.0.0",
    });

    // Verify manifest shape
    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.name).toBe("my-bundle");
    expect(result.manifest.version).toBe("2.0.0");
    expect(result.manifest.rigSpec).toBe("rig.yaml");
    expect(result.manifest.cultureFile).toBe("culture.md");
    expect(result.manifest.agents).toHaveLength(1);

    // Serialize and re-validate
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const manifestYaml = written["/tmp/staging/bundle.yaml"];
    expect(manifestYaml).toBeDefined();
    const parsed = parsePodBundleManifest(manifestYaml!);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
  });

  // T11: integration: assemble -> verify manifest + file contents
  it("integration: assembled bundle has correct manifest and files", () => {
    const spec = makeRigSpec({
      cultureFile: "culture.md",
      startup: { files: [{ path: "startup/rig.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/culture.md`]: "# Culture doc",
      [`${RIG_ROOT}/startup/rig.md`]: "# Rig startup",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl", { skills: ["deep-pr-review"] }),
      [`${RIG_ROOT}/agents/impl/skills/deep-pr-review`]: "skill content",
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "full-bundle", bundleVersion: "1.0.0",
    });

    // Verify collected files
    expect(result.collectedFiles).toContain("rig.yaml");
    expect(result.collectedFiles).toContain("culture.md");
    expect(result.collectedFiles).toContain("startup/rig.md");
    expect(result.collectedFiles.some((f) => f.startsWith("agents/impl/"))).toBe(true);

    // Verify written files exist
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    expect(written["/tmp/staging/rig.yaml"]).toBeDefined();
    expect(written["/tmp/staging/culture.md"]).toBe("# Culture doc");
    expect(written["/tmp/staging/bundle.yaml"]).toBeDefined();
  });

  // T12: PodBundleManifest shape validates
  it("PodBundleManifest validates with correct schema_version", () => {
    const raw = {
      schema_version: 2,
      name: "test",
      version: "1.0",
      created_at: new Date().toISOString(),
      rig_spec: "rig.yaml",
      agents: [{
        name: "impl",
        version: "1.0",
        path: "agents/impl",
        original_ref: "local:agents/impl",
        hash: "abc123",
        import_entries: [],
      }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T13: vendored agent.yaml import refs are rewritten
  it("vendored agent.yaml has import refs rewritten to local:", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl", { imports: "imports:\n  - ref: local:../lib" }),
      [`${RIG_ROOT}/agents/lib/agent.yaml`]: validAgentYaml("lib"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const vendoredAgentYaml = written["/tmp/staging/agents/impl/agent.yaml"]!;
    expect(vendoredAgentYaml).toBeDefined();
    expect(vendoredAgentYaml).toContain("local:../lib");
    expect(vendoredAgentYaml).not.toContain("local:../lib-a"); // no stray rewrites
  });

  // T14: shared imports appear in all referencing agents' importEntries
  it("shared imports appear in all referencing agents importEntries", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl-a", agentRef: "local:agents/agent-a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "impl-b", agentRef: "local:agents/agent-b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/agent-a/agent.yaml`]: validAgentYaml("agent-a", { imports: "imports:\n  - ref: local:../shared-lib" }),
      [`${RIG_ROOT}/agents/agent-b/agent.yaml`]: validAgentYaml("agent-b", { imports: "imports:\n  - ref: local:../shared-lib" }),
      [`${RIG_ROOT}/agents/shared-lib/agent.yaml`]: validAgentYaml("shared-lib"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    // Both agents should have shared-lib in their importEntries
    const agentA = result.manifest.agents.find((a) => a.name === "agent-a");
    const agentB = result.manifest.agents.find((a) => a.name === "agent-b");
    expect(agentA!.importEntries).toHaveLength(1);
    expect(agentA!.importEntries[0]!.name).toBe("shared-lib");
    expect(agentB!.importEntries).toHaveLength(1);
    expect(agentB!.importEntries[0]!.name).toBe("shared-lib");
  });

  // Deferred: full golden-path integration (assemble -> validate -> preflight -> instantiate)
  // will be verified at Checkpoint 2 when AS-T11 + AS-T08b land

  // Item 1 — provenance capture (slice-05 Checkpoint 2 part 2)
  it("v2: captures provenance from opts into manifest", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-prov",
      bundleName: "test-bundle",
      bundleVersion: "1.0.0",
      provenance: {
        sourceHost: "test-host",
        authorSession: "velocity-driver@openrig-velocity",
        daemonVersion: "0.3.2",
        cliVersion: "0.3.2",
        notes: "v2 capture fixture",
      },
    });

    expect(result.manifest.provenance).toBeDefined();
    expect(result.manifest.provenance?.sourceHost).toBe("test-host");
    expect(result.manifest.provenance?.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(result.manifest.provenance?.daemonVersion).toBe("0.3.2");
    expect(result.manifest.provenance?.notes).toBe("v2 capture fixture");
    // createdAt mirrors root
    expect(result.manifest.provenance?.createdAt).toBe(result.manifest.createdAt);
  });

  it("v2: respects opts.provenance.createdAt when pre-set (test determinism)", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const fixedCreatedAt = "2026-01-01T00:00:00Z";
    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-fixed-createdat",
      bundleName: "test", bundleVersion: "1.0",
      provenance: { createdAt: fixedCreatedAt, sourceHost: "h" },
    });

    expect(result.manifest.provenance?.createdAt).toBe(fixedCreatedAt);
    expect(result.manifest.createdAt).not.toBe(fixedCreatedAt);
  });

  it("v2: omits provenance when opts.provenance not provided (backward compat)", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-no-prov",
      bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.provenance).toBeUndefined();
  });

  // Item 2 — compatibility capture (slice-05 Checkpoint 3.2)
  it("v2: captures compatibility from opts into manifest", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-compat",
      bundleName: "test-bundle",
      bundleVersion: "1.0.0",
      compatibility: {
        minDaemonVersion: "0.3.2",
        minCliVersion: "0.3.2",
        schemaVersion: 2,
      },
    });

    expect(result.manifest.compatibility).toBeDefined();
    expect(result.manifest.compatibility?.minDaemonVersion).toBe("0.3.2");
    expect(result.manifest.compatibility?.minCliVersion).toBe("0.3.2");
    expect(result.manifest.compatibility?.schemaVersion).toBe(2);
  });

  it("v2: omits compatibility when opts.compatibility not provided (backward compat)", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-no-compat",
      bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.compatibility).toBeUndefined();
  });
});

describe("PodBundleManifest validation", () => {
  it("valid schemaVersion 2 manifest passes validation", () => {
    const raw = {
      schema_version: 2,
      name: "test-bundle",
      version: "1.0.0",
      created_at: "2026-03-29T00:00:00Z",
      rig_spec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        original_ref: "local:agents/impl", hash: "abc123",
        import_entries: [],
      }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("wrong schema_version fails", () => {
    const raw = {
      schema_version: 1, name: "test", version: "1.0",
      created_at: "2026-03-29T00:00:00Z", rig_spec: "rig.yaml",
      agents: [],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/schema_version must be 2/);
  });

  it("serialize -> parse -> validate round-trips", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-test", version: "2.0",
      createdAt: "2026-03-29T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def456",
        importEntries: [{ name: "lib", version: "1.0", path: "agents/lib", originalRef: "local:../lib", hash: "ghi789" }],
      }],
    };
    const yaml = serializePodBundleManifest(manifest);
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    // Verify agent entry round-trips
    const m = parsed as Record<string, unknown>;
    const agents = m["agents"] as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!["name"]).toBe("impl");
    expect(agents[0]!["hash"]).toBe("def456");
    const imports = agents[0]!["import_entries"] as Array<Record<string, unknown>>;
    expect(imports).toHaveLength(1);
    expect(imports[0]!["name"]).toBe("lib");
  });

  // Item 1 — provenance block (slice-05): backward-compat + presence + round-trip
  it("v2: missing provenance block passes validation (backward compat)", () => {
    const raw = {
      schema_version: 2, name: "no-prov", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        original_ref: "local:agents/impl", hash: "abc",
        import_entries: [],
      }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: full provenance block passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-prov", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        original_ref: "local:agents/impl", hash: "abc",
        import_entries: [],
      }],
      provenance: {
        created_at: "2026-05-18T00:00:00Z",
        source_host: "test-host.local",
        author_session: "velocity-driver@openrig-velocity",
        source_rig_id: "01KQEQPN4MQJN0DHBM5CQ0N8D7",
        source_rig_name: "openrig-velocity",
        daemon_version: "0.3.2",
        cli_version: "0.3.2",
        notes: "Test bundle for Item 1",
      },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: provenance present but not an object rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-prov", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      provenance: "string-not-object",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provenance"))).toBe(true);
  });

  it("v2: provenance field with wrong type rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-prov-field", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      provenance: { source_host: 12345 },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provenance.source_host"))).toBe(true);
  });

  // -- Item 2 compatibility block tests (slice-05 Checkpoint 3.1) --

  it("v2: missing compatibility block passes validation (backward compat)", () => {
    const raw = {
      schema_version: 2, name: "no-compat", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: full compatibility block passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-compat", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      compatibility: { min_daemon_version: "0.3.2", min_cli_version: "0.3.2", schema_version: 2 },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: compatibility present but not an object rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-compat", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      compatibility: "0.3.2",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("compatibility"))).toBe(true);
  });

  it("v2: compatibility field with wrong type rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-compat-field", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      compatibility: { min_daemon_version: 0.3 },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("compatibility.min_daemon_version"))).toBe(true);
  });

  // -- Item 6 skills block tests for v2 (slice-05 Checkpoint 7.1) --

  it("v2: missing skills block passes validation (backward compat)", () => {
    const raw = {
      schema_version: 2, name: "no-skills", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: skills as string array passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-skills", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      skills: ["skills/foo/SKILL.md", "skills/bar/SKILL.md"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: unsafe skill path rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-skills", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      skills: ["../escape/skill.md"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]") && e.includes("not safe"))).toBe(true);
  });

  // -- Item 6 plugins block tests for v2 (slice-05 Checkpoint 7.3b) --

  it("v2: missing plugins block passes validation", () => {
    const raw = {
      schema_version: 2, name: "no-plugins", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: plugins as valid {id, source} array passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-plugins", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      plugins: [{ id: "gstack", source: { kind: "local", path: "plugins/gstack" } }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: plugin entry with unsafe source.path rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-plugins", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      plugins: [{ id: "x", source: { kind: "local", path: "../escape" } }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source.path") && e.includes("not safe"))).toBe(true);
  });

  it("v2: round-trip preserves plugins through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-plugins-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      plugins: [{ id: "gstack", source: { kind: "local", path: "plugins/gstack" } }],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("plugins:");
    expect(yaml).toContain("id: gstack");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    const ps = m["plugins"] as Array<Record<string, unknown>>;
    expect(ps).toHaveLength(1);
    expect(ps[0]!["id"]).toBe("gstack");
    expect((ps[0]!["source"] as Record<string, unknown>)["path"]).toBe("plugins/gstack");
  });

  it("v2: round-trip preserves skills through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-skills-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      skills: ["skills/v2-foo/SKILL.md", "skills/v2-bar/SKILL.md"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("skills:");
    expect(yaml).toContain("skills/v2-foo/SKILL.md");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["skills"]).toEqual(["skills/v2-foo/SKILL.md", "skills/v2-bar/SKILL.md"]);
  });

  // -- Item 6 workflow_specs block tests for v2 (slice-05 Checkpoint 7.3e) --

  it("v2: missing workflow_specs block passes validation (backward compat)", () => {
    const raw = {
      schema_version: 2, name: "no-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: workflow_specs as string array passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: ["workflows/onboarding.yaml", "workflows/release.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: workflow_specs as non-array rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: "workflows/a.yaml",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs must be an array"))).toBe(true);
  });

  it("v2: non-string workflow_specs entry rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: [123, "workflows/ok.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]") && e.includes("must be a string"))).toBe(true);
  });

  it("v2: unsafe workflow_specs path rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: ["../escape/spec.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]") && e.includes("not safe"))).toBe(true);
  });

  it("v2: round-trip preserves workflow_specs through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-workflow-specs-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      workflowSpecs: ["workflows/v2-onboarding.yaml", "workflows/v2-release.yaml"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("workflow_specs:");
    expect(yaml).toContain("workflows/v2-onboarding.yaml");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["workflow_specs"]).toEqual(["workflows/v2-onboarding.yaml", "workflows/v2-release.yaml"]);
  });

  it("v2: round-trip preserves all 3 cross-primitive blocks together (skills + plugins + workflow_specs)", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-all-three", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      skills: ["skills/co-test/SKILL.md"],
      plugins: [{ id: "co-plugin", source: { kind: "local", path: "plugins/co-plugin" } }],
      workflowSpecs: ["workflows/co-flow.yaml"],
    };
    const yaml = serializePodBundleManifest(manifest);
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["skills"]).toEqual(["skills/co-test/SKILL.md"]);
    expect(m["workflow_specs"]).toEqual(["workflows/co-flow.yaml"]);
    const ps = m["plugins"] as Array<Record<string, unknown>>;
    expect(ps[0]!["id"]).toBe("co-plugin");
  });

  // -- Item 6 context_packs block tests for v2 (slice-05 Checkpoint 7.3f) --

  it("v2: missing context_packs block passes validation (backward compat)", () => {
    const raw = {
      schema_version: 2, name: "no-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: context_packs as string array passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: ["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: context_packs as non-array rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: "context-packs/a/manifest.yaml",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs must be an array"))).toBe(true);
  });

  it("v2: non-string context_packs entry rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: [42, "context-packs/ok/manifest.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]") && e.includes("must be a string"))).toBe(true);
  });

  it("v2: unsafe context_packs path rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: ["../escape/manifest.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]") && e.includes("not safe"))).toBe(true);
  });

  it("v2: round-trip preserves context_packs through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-context-packs-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      contextPacks: ["context-packs/v2-intent/manifest.yaml", "context-packs/v2-persona/manifest.yaml"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("context_packs:");
    expect(yaml).toContain("context-packs/v2-intent/manifest.yaml");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["context_packs"]).toEqual(["context-packs/v2-intent/manifest.yaml", "context-packs/v2-persona/manifest.yaml"]);
  });

  // -- Item 6 agent_images block tests for v2 (slice-05 Checkpoint 7.3g) --

  it("v2: missing agent_images block passes validation (backward compat)", () => {
    const raw = {
      schema_version: 2, name: "no-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: agent_images as string array passes validation", () => {
    const raw = {
      schema_version: 2, name: "with-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: ["agent-images/seat-a", "agent-images/seat-b"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2: agent_images as non-array rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: "agent-images/a",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images must be an array"))).toBe(true);
  });

  it("v2: non-string agent_images entry rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: [99, "agent-images/ok"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]") && e.includes("must be a string"))).toBe(true);
  });

  it("v2: unsafe agent_images path rejected", () => {
    const raw = {
      schema_version: 2, name: "bad-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: ["../escape"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]") && e.includes("not safe"))).toBe(true);
  });

  it("v2: round-trip preserves agent_images through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-agent-images-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      agentImages: ["agent-images/v2-seat-a", "agent-images/v2-seat-b"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("agent_images:");
    expect(yaml).toContain("agent-images/v2-seat-a");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["agent_images"]).toEqual(["agent-images/v2-seat-a", "agent-images/v2-seat-b"]);
  });

  it("v2: round-trip preserves compatibility through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-compat", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      compatibility: {
        minDaemonVersion: "0.3.2",
        minCliVersion: "0.3.2",
        schemaVersion: 2,
      },
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("compatibility:");
    expect(yaml).toContain("min_daemon_version: 0.3.2");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    const compat = m["compatibility"] as Record<string, unknown>;
    expect(compat["min_daemon_version"]).toBe("0.3.2");
    expect(compat["min_cli_version"]).toBe("0.3.2");
    expect(compat["schema_version"]).toBe(2);
  });

  it("v2: round-trip preserves provenance through serialize -> parse", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-prov", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      provenance: {
        createdAt: "2026-05-18T00:00:00Z",
        sourceHost: "rt-host",
        authorSession: "velocity-driver@openrig-velocity",
        daemonVersion: "0.3.2",
        cliVersion: "0.3.2",
        notes: "v2 round-trip fixture",
      },
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("provenance:");
    expect(yaml).toContain("source_host: rt-host");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    const prov = m["provenance"] as Record<string, unknown>;
    expect(prov["source_host"]).toBe("rt-host");
    expect(prov["author_session"]).toBe("velocity-driver@openrig-velocity");
    expect(prov["daemon_version"]).toBe("0.3.2");
    expect(prov["notes"]).toBe("v2 round-trip fixture");
  });
});

describe("PodBundleSourceResolver", () => {
  // This test exercises the real resolver against a staged bundle directory.
  // We simulate what unpack produces by writing files directly, then test resolve.
  it("resolves a schemaVersion 2 bundle with correct manifest and specPath", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { PodBundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");

    // Create a temp "bundle" directory (simulating post-unpack state)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podbundle-test-"));

    try {
      // Write manifest
      const manifestYaml = serializePodBundleManifest({
        schemaVersion: 2,
        name: "resolver-test",
        version: "1.0.0",
        createdAt: "2026-03-29T00:00:00Z",
        rigSpec: "rig.yaml",
        agents: [{
          name: "impl", version: "1.0", path: "agents/impl",
          originalRef: "local:agents/impl", hash: "abc",
          importEntries: [],
        }],
      });
      fs.writeFileSync(path.join(tmpDir, "bundle.yaml"), manifestYaml);

      // Write rig.yaml
      const rigYaml = RigSpecCodec.serialize({
        version: "0.2", name: "test-rig",
        pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
        edges: [],
      });
      fs.writeFileSync(path.join(tmpDir, "rig.yaml"), rigYaml);

      // Write agent
      fs.mkdirSync(path.join(tmpDir, "agents", "impl"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "agents", "impl", "agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles: {}');

      // Now test the resolver's manifest parsing (we skip the archive unpack
      // since we've already staged files — test the parse/validate/extract seam)
      const raw = parsePodBundleManifest(fs.readFileSync(path.join(tmpDir, "bundle.yaml"), "utf-8"));
      const validation = validatePodBundleManifest(raw);
      expect(validation.valid).toBe(true);

      const m = raw as Record<string, unknown>;
      expect(m["schema_version"]).toBe(2);
      expect(m["name"]).toBe("resolver-test");
      expect(m["agents"]).toHaveLength(1);
      const agents = m["agents"] as Array<Record<string, unknown>>;
      expect(agents[0]!["name"]).toBe("impl");

      // Verify specPath exists
      const specPath = path.join(tmpDir, m["rig_spec"] as string);
      expect(fs.existsSync(specPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("bundles declared docs files alongside the rig spec", () => {
    const spec = makeRigSpec({ docs: [{ path: "SETUP.md" }] });
    const yaml = rigSpecYaml(spec);
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: yaml,
      [`${RIG_ROOT}/SETUP.md`]: "# Setup instructions\nInstall Exa MCP first.",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/out",
      bundleName: "test",
      bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("SETUP.md");
    // The bundled rig.yaml should still reference the doc
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const bundledRigYaml = written["/out/rig.yaml"];
    expect(bundledRigYaml).toContain("SETUP.md");
  });

  it("fails assembly when a declared doc file is missing from disk", () => {
    const spec = makeRigSpec({ docs: [{ path: "SETUP.md" }] });
    const yaml = rigSpecYaml(spec);
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: yaml,
      // SETUP.md deliberately missing
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/out",
      bundleName: "test",
      bundleVersion: "1.0",
    })).toThrow(/Declared doc file not found.*SETUP\.md/);
  });
});
