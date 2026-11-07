import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("RigSpec docs field", () => {
  function minimalSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: "0.2",
      name: "test-rig",
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            { id: "impl", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." },
          ],
          edges: [],
        },
      ],
      edges: [],
      ...overrides,
    };
  }

  it("accepts a spec with no docs field", () => {
    const result = RigSpecSchema.validate(minimalSpec());
    expect(result.valid).toBe(true);
  });

  it("accepts a spec with valid docs array", () => {
    const result = RigSpecSchema.validate(minimalSpec({
      docs: [{ path: "SETUP.md" }, { path: "README.md" }],
    }));
    expect(result.valid).toBe(true);
  });

  it("rejects docs that is not an array", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: "SETUP.md" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs: must be an array"))).toBe(true);
  });

  it("rejects doc entry without path", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [{}] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0].path: required"))).toBe(true);
  });

  it("rejects doc entry with path traversal", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [{ path: "../../../etc/passwd" }] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("path traversal"))).toBe(true);
  });

  it("normalizes docs into typed array", () => {
    const spec = RigSpecSchema.normalize(minimalSpec({
      docs: [{ path: "SETUP.md" }, { path: "README.md" }],
    }));
    expect(spec.docs).toEqual([{ path: "SETUP.md" }, { path: "README.md" }]);
  });

  it("normalizes to undefined when no docs field present", () => {
    const spec = RigSpecSchema.normalize(minimalSpec());
    expect(spec.docs).toBeUndefined();
  });

  it("rejects null entry in docs array without crashing", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [null] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0]: must be an object"))).toBe(true);
  });

  it("rejects primitive entry in docs array without crashing", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [42] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0]: must be an object"))).toBe(true);
  });

  it("rejects string entry in docs array without crashing", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: ["SETUP.md"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0]: must be an object"))).toBe(true);
  });
});

describe("RigSpec and startup guide launch_wrapper documentation (#2328)", () => {
  const rigSpecDoc = () => fs.readFileSync(path.join(REPO_ROOT, "docs/reference/rig-spec.md"), "utf-8");
  const startupGuideDoc = () => fs.readFileSync(path.join(REPO_ROOT, "docs/reference/agent-startup-guide.md"), "utf-8");

  it("documents canonical member field launch_wrapper, [] clear vs absent retain, recreate semantics, literal argv, daemon PATH, exec requirement, Pi runner wrapping, fail-closed behavior, and limits", () => {
    const doc = rigSpecDoc();
    expect(doc).toContain("launch_wrapper");
    expect(doc).toContain("launch-wrapper.ts");
    expect(doc).toMatch(/launch_wrapper:\s*\[\]/);
    expect(doc).toMatch(/omitting.*retains|absent.*retains|leaves an existing seat's stored/i);
    expect(doc).toMatch(/no live.*edit|no.*rig seat.*verb/i);
    expect(doc).toMatch(/literal/i);
    expect(doc).toMatch(/non-POSIX/i);
    expect(doc).toMatch(/daemon.*PATH/i);
    expect(doc).toMatch(/must prepare its environment and `exec`|must `exec`|execs the/i);
    expect(doc).toMatch(/host runner stays host-side and unwrapped|OpenRig's RPC runner|OpenRig's node runner|Pi runner/i);
    expect(doc).toMatch(/prefixes the resolved Pi child executable|inner `pi` binary/i);
    expect(doc).toMatch(/launch_path_too_long/);
    expect(doc).toMatch(/never runs unwrapped|never falls back to.*unwrapped|never retries or falls back/i);
    expect(doc).toMatch(/not(?:\*\*)?\s+proof of[\s\S]*isolation[\s\S]*tooling[\s\S]*memory[\s\S]*governance/i);
  });

  it("validates and normalizes the documented launch_wrapper YAML member examples", () => {
    const configured = {
      version: "0.2",
      name: "test-rig",
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            {
              id: "impl",
              agent_ref: "local:agents/impl",
              profile: "default",
              runtime: "pi",
              cwd: ".",
              launch_wrapper: ["mtn", "sandbox", "exec", "--seat", "synthetic", "--"],
            },
          ],
          edges: [],
        },
      ],
      edges: [],
    };
    expect(RigSpecSchema.validate(configured).valid).toBe(true);
    const normalizedConfigured = RigSpecSchema.normalize(configured);
    expect(normalizedConfigured.pods[0]?.members[0]?.launchWrapper).toEqual([
      "mtn",
      "sandbox",
      "exec",
      "--seat",
      "synthetic",
      "--",
    ]);

    const cleared = {
      ...configured,
      pods: [
        {
          ...configured.pods[0],
          members: [
            {
              ...configured.pods[0].members[0],
              launch_wrapper: [],
            },
          ],
        },
      ],
    };
    expect(RigSpecSchema.validate(cleared).valid).toBe(true);
    const normalizedCleared = RigSpecSchema.normalize(cleared);
    expect(normalizedCleared.pods[0]?.members[0]?.launchWrapper).toEqual([]);

    for (const runtime of ["pi", "codex"] as const) {
      const legacyConfigured = {
        schema_version: 1,
        name: "legacy-test-rig",
        version: "1.0.0",
        nodes: [
          {
            id: "impl",
            runtime,
            cwd: ".",
            launch_wrapper: ["mtn", "sandbox", "exec", "--seat", "synthetic", "--"],
          },
        ],
        edges: [],
      };
      expect(LegacyRigSpecSchema.validate(legacyConfigured).valid).toBe(true);
      expect(LegacyRigSpecSchema.normalize(legacyConfigured).nodes[0]?.launchWrapper).toEqual([
        "mtn",
        "sandbox",
        "exec",
        "--seat",
        "synthetic",
        "--",
      ]);

      const legacyCleared = {
        ...legacyConfigured,
        nodes: [{ ...legacyConfigured.nodes[0]!, launch_wrapper: [] }],
      };
      expect(LegacyRigSpecSchema.validate(legacyCleared).valid).toBe(true);
      expect(LegacyRigSpecSchema.normalize(legacyCleared).nodes[0]?.launchWrapper).toEqual([]);
    }
  });

  it("documents launch_wrapper in agent-startup-guide.md what-a-seat-is-set-to table", () => {
    const guide = startupGuideDoc();
    expect(guide).toContain("launch_wrapper");
    expect(guide).toContain("launchWrapper");
    expect(guide).toMatch(/OpenRig's host runner|OpenRig's Pi runner/i);
    expect(guide).toMatch(/not proof of isolation, tooling, memory or governance/i);
  });
});
