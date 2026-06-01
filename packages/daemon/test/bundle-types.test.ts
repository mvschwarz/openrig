import { describe, it, expect } from "vitest";
// TODO: AS-T12 — migrate to pod-aware bundle types
import {
  validateLegacyBundleManifest as validateBundleManifest,
  parseLegacyBundleManifest as parseBundleManifest,
  normalizeLegacyBundleManifest as normalizeBundleManifest,
  serializeLegacyBundleManifest as serializeBundleManifest,
  isRelativeSafePath,
  type LegacyBundleManifest as BundleManifest,
  type BundleProvenance,
  type BundleCompatibility,
  type BundlePluginReference,
} from "../src/domain/bundle-types.js";

const VALID_RAW = {
  schema_version: 1,
  name: "my-bundle",
  version: "0.1.0",
  created_at: "2026-03-26T00:00:00Z",
  rig_spec: "rig.yaml",
  packages: [
    { name: "review-kit", version: "0.1.0", path: "packages/review-kit", original_source: "github:example/review-kit@v1" },
  ],
  integrity: {
    algorithm: "sha256",
    files: {
      "rig.yaml": "a".repeat(64),
      "packages/review-kit/package.yaml": "b".repeat(64),
    },
  },
};

describe("Bundle types", () => {
  // T1: Valid manifest passes validation
  it("valid manifest with integrity passes validation", () => {
    const result = validateBundleManifest(VALID_RAW);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // T2: Package entries validated
  it("package entries require name, version, path", () => {
    const raw = { ...VALID_RAW, packages: [{ name: "", version: "1.0", path: "pkg" }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  // T3: Integrity section validated
  it("integrity requires algorithm=sha256 and non-empty files", () => {
    const raw = { ...VALID_RAW, integrity: { algorithm: "md5", files: {} } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("algorithm"))).toBe(true);
    expect(result.errors.some((e) => e.includes("files"))).toBe(true);
  });

  // T4: Missing rig_spec rejected
  it("missing rig_spec path rejected", () => {
    const raw = { ...VALID_RAW, rig_spec: undefined };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rig_spec"))).toBe(true);
  });

  // T5: Empty packages rejected
  it("empty packages array rejected", () => {
    const raw = { ...VALID_RAW, packages: [] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("packages"))).toBe(true);
  });

  // T6: Round-trip
  it("round-trip: create → serialize → parse → validate", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "test-bundle",
      version: "1.0.0",
      createdAt: "2026-03-26T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [
        { name: "pkg-a", version: "1.0.0", path: "packages/pkg-a", originalSource: "local:./pkg-a" },
      ],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "c".repeat(64), "packages/pkg-a/package.yaml": "d".repeat(64) },
      },
    };

    const yaml = serializeBundleManifest(manifest);
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.name).toBe("test-bundle");
    expect(normalized.packages).toHaveLength(1);
    expect(normalized.integrity?.files["rig.yaml"]).toBe("c".repeat(64));
  });

  // T7: Absolute rig_spec path rejected
  it("absolute rig_spec path rejected", () => {
    const raw = { ...VALID_RAW, rig_spec: "/etc/passwd" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("safe relative path"))).toBe(true);
  });

  // T8: ../ in package path rejected
  it("path traversal in package path rejected", () => {
    const raw = { ...VALID_RAW, packages: [{ name: "evil", version: "1.0", path: "../outside", original_source: "" }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("safe relative path"))).toBe(true);
  });

  // T9: ../ in integrity file key rejected
  it("path traversal in integrity file key rejected", () => {
    const raw = { ...VALID_RAW, integrity: { algorithm: "sha256", files: { "../etc/passwd": "hash" } } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("safe relative path"))).toBe(true);
  });

  // T10: ./rig.yaml rejected (dot segment)
  it("dot segment in rig_spec rejected", () => {
    const raw = { ...VALID_RAW, rig_spec: "./rig.yaml" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("safe relative path"))).toBe(true);
  });

  // T11: packages//review-kit rejected (empty segment)
  it("empty segment in package path rejected", () => {
    const raw = { ...VALID_RAW, packages: [{ name: "pkg", version: "1.0", path: "packages//review-kit", original_source: "" }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("safe relative path"))).toBe(true);
  });

  // T12: missing provenance is valid (backward compat — pre-Item-1 bundles install)
  it("missing provenance block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T13: full provenance block passes validation
  it("full provenance block passes validation", () => {
    const raw = {
      ...VALID_RAW,
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
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T14: partial provenance (only notes) passes validation — all fields optional
  it("partial provenance block (only notes) passes validation", () => {
    const raw = { ...VALID_RAW, provenance: { notes: "ad-hoc" } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T15: provenance must be an object when present (not null, not array, not string)
  it("provenance present but not an object rejected", () => {
    const raw1 = { ...VALID_RAW, provenance: "not-an-object" };
    const result1 = validateBundleManifest(raw1);
    expect(result1.valid).toBe(false);
    expect(result1.errors.some((e) => e.includes("provenance"))).toBe(true);

    const raw2 = { ...VALID_RAW, provenance: [] };
    const result2 = validateBundleManifest(raw2);
    expect(result2.valid).toBe(false);
    expect(result2.errors.some((e) => e.includes("provenance"))).toBe(true);
  });

  // T16: malformed provenance field type rejected (numeric created_at)
  it("provenance field with wrong type rejected", () => {
    const raw = { ...VALID_RAW, provenance: { created_at: 12345, source_host: "h" } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provenance.created_at"))).toBe(true);
  });

  // T17: round-trip preserves provenance through serialize → parse → normalize
  it("round-trip preserves provenance through serialize → parse → normalize", () => {
    const provenance: BundleProvenance = {
      createdAt: "2026-05-18T12:00:00Z",
      sourceHost: "rt-host",
      authorSession: "velocity-driver@openrig-velocity",
      daemonVersion: "0.3.2",
      cliVersion: "0.3.2",
      notes: "round-trip fixture",
    };
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-bundle",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [
        { name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" },
      ],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "e".repeat(64), "packages/pkg/package.yaml": "f".repeat(64) },
      },
      provenance,
    };

    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("provenance:");
    expect(yaml).toContain("source_host: rt-host");
    expect(yaml).toContain("notes: round-trip fixture");

    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.provenance).toBeDefined();
    expect(normalized.provenance?.sourceHost).toBe("rt-host");
    expect(normalized.provenance?.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(normalized.provenance?.daemonVersion).toBe("0.3.2");
    expect(normalized.provenance?.cliVersion).toBe("0.3.2");
    expect(normalized.provenance?.notes).toBe("round-trip fixture");
  });

  // T18: missing provenance round-trips as undefined (no field in YAML)
  it("missing provenance round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-prov",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("provenance:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.provenance).toBeUndefined();
  });

  // -- Item 2 compatibility block tests (slice-05 Checkpoint 3.1) --

  // C1: missing compatibility is valid (backward compat)
  it("missing compatibility block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // C2: full compatibility block passes validation
  it("full compatibility block passes validation", () => {
    const raw = {
      ...VALID_RAW,
      compatibility: {
        min_daemon_version: "0.3.2",
        min_cli_version: "0.3.2",
        schema_version: 1,
      },
    };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // C3: partial compatibility (only min_daemon_version) passes — all fields optional
  it("partial compatibility block (only min_daemon_version) passes validation", () => {
    const raw = { ...VALID_RAW, compatibility: { min_daemon_version: "0.3.2" } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // C4: compatibility present but not an object rejected
  it("compatibility present but not an object rejected", () => {
    const raw1 = { ...VALID_RAW, compatibility: "0.3.2" };
    const r1 = validateBundleManifest(raw1);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes("compatibility"))).toBe(true);

    const raw2 = { ...VALID_RAW, compatibility: [] };
    const r2 = validateBundleManifest(raw2);
    expect(r2.valid).toBe(false);
    expect(r2.errors.some((e) => e.includes("compatibility"))).toBe(true);
  });

  // C5: compatibility field with wrong type rejected
  it("compatibility field with wrong type rejected", () => {
    const raw1 = { ...VALID_RAW, compatibility: { min_daemon_version: 0.3 } };
    const r1 = validateBundleManifest(raw1);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes("compatibility.min_daemon_version"))).toBe(true);

    const raw2 = { ...VALID_RAW, compatibility: { schema_version: "1" } };
    const r2 = validateBundleManifest(raw2);
    expect(r2.valid).toBe(false);
    expect(r2.errors.some((e) => e.includes("compatibility.schema_version"))).toBe(true);
  });

  // C6: round-trip preserves compatibility through serialize → parse → normalize
  it("round-trip preserves compatibility through serialize → parse → normalize", () => {
    const compatibility: BundleCompatibility = {
      minDaemonVersion: "0.3.2",
      minCliVersion: "0.3.2",
      schemaVersion: 1,
    };
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-compat",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "1".repeat(64), "packages/pkg/package.yaml": "2".repeat(64) },
      },
      compatibility,
    };

    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("compatibility:");
    expect(yaml).toContain("min_daemon_version: 0.3.2");

    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.compatibility).toBeDefined();
    expect(normalized.compatibility?.minDaemonVersion).toBe("0.3.2");
    expect(normalized.compatibility?.minCliVersion).toBe("0.3.2");
    expect(normalized.compatibility?.schemaVersion).toBe(1);
  });

  // C7: missing compatibility round-trips cleanly (no field emitted in YAML)
  it("missing compatibility round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-compat",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("compatibility:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.compatibility).toBeUndefined();
  });

  // -- Item 6 skills block tests (slice-05 Checkpoint 7.1) --

  it("missing skills block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("skills as a string array of safe relative paths passes validation", () => {
    const raw = { ...VALID_RAW, skills: ["skills/review-kit/SKILL.md", "skills/test-runner/SKILL.md"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("skills as a non-array rejected", () => {
    const raw = { ...VALID_RAW, skills: "skills/a.md" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills must be an array"))).toBe(true);
  });

  it("non-string skill entry rejected", () => {
    const raw = { ...VALID_RAW, skills: [123, "skills/ok.md"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
  });

  it("unsafe skill path (dot-dot traversal) rejected", () => {
    const raw = { ...VALID_RAW, skills: ["../escape/skill.md"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("not safe"))).toBe(true);
  });

  it("round-trip preserves skills through serialize → parse → normalize", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-skills",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "9".repeat(64), "packages/pkg/package.yaml": "a".repeat(64) },
      },
      skills: ["skills/foo/SKILL.md", "skills/bar/SKILL.md"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("skills:");
    expect(yaml).toContain("skills/foo/SKILL.md");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.skills).toBeDefined();
    expect(normalized.skills).toEqual(["skills/foo/SKILL.md", "skills/bar/SKILL.md"]);
  });

  it("missing skills round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-skills",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("skills:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.skills).toBeUndefined();
  });

  // -- Item 6 plugins block tests (slice-05 Checkpoint 7.3b) --

  it("missing plugins block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("plugins as array of valid {id, source} entries passes validation", () => {
    const raw = {
      ...VALID_RAW,
      plugins: [
        { id: "gstack", source: { kind: "local", path: "plugins/gstack" } },
        { id: "obra-superpowers", source: { kind: "local", path: "plugins/obra-superpowers" } },
      ],
    };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("plugins as non-array rejected", () => {
    const raw = { ...VALID_RAW, plugins: "gstack" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins must be an array"))).toBe(true);
  });

  it("plugin entry missing id is rejected", () => {
    const raw = { ...VALID_RAW, plugins: [{ source: { kind: "local", path: "plugins/gstack" } }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].id"))).toBe(true);
  });

  it("plugin entry with non-local source.kind rejected", () => {
    const raw = { ...VALID_RAW, plugins: [{ id: "x", source: { kind: "remote", path: "plugins/x" } }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("source.kind must be 'local'"))).toBe(true);
  });

  it("plugin entry with unsafe source.path rejected", () => {
    const raw = { ...VALID_RAW, plugins: [{ id: "x", source: { kind: "local", path: "../escape" } }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source.path"))).toBe(true);
    expect(result.errors.some((e) => e.includes("not safe"))).toBe(true);
  });

  it("round-trip preserves plugins through serialize → parse → normalize", () => {
    const plugins: BundlePluginReference[] = [
      { id: "gstack", source: { kind: "local", path: "plugins/gstack" } },
    ];
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-plugins",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "5".repeat(64), "packages/pkg/package.yaml": "6".repeat(64) },
      },
      plugins,
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("plugins:");
    expect(yaml).toContain("id: gstack");
    expect(yaml).toContain("plugins/gstack");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.plugins).toBeDefined();
    expect(normalized.plugins).toEqual(plugins);
  });

  it("missing plugins round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-plugins",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("plugins:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.plugins).toBeUndefined();
  });

  // -- Item 6 workflow_specs block tests (slice-05 Checkpoint 7.3e) --

  it("missing workflow_specs block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("workflow_specs as a string array of safe relative paths passes validation", () => {
    const raw = { ...VALID_RAW, workflow_specs: ["workflows/onboarding.yaml", "workflows/release.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("workflow_specs as a non-array rejected", () => {
    const raw = { ...VALID_RAW, workflow_specs: "workflows/a.yaml" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs must be an array"))).toBe(true);
  });

  it("non-string workflow_specs entry rejected", () => {
    const raw = { ...VALID_RAW, workflow_specs: [123, "workflows/ok.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]"))).toBe(true);
  });

  it("unsafe workflow_specs path (dot-dot traversal) rejected", () => {
    const raw = { ...VALID_RAW, workflow_specs: ["../escape/spec.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("not safe"))).toBe(true);
  });

  it("round-trip preserves workflow_specs through serialize → parse → normalize", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-workflow-specs",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "7".repeat(64), "packages/pkg/package.yaml": "8".repeat(64) },
      },
      workflowSpecs: ["workflows/onboarding.yaml", "workflows/release.yaml"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("workflow_specs:");
    expect(yaml).toContain("workflows/onboarding.yaml");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.workflowSpecs).toBeDefined();
    expect(normalized.workflowSpecs).toEqual(["workflows/onboarding.yaml", "workflows/release.yaml"]);
  });

  it("missing workflow_specs round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-workflow-specs",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("workflow_specs:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.workflowSpecs).toBeUndefined();
  });

  // -- Item 6 context_packs block tests (slice-05 Checkpoint 7.3f) --

  it("missing context_packs block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("context_packs as a string array of safe relative paths passes validation", () => {
    const raw = { ...VALID_RAW, context_packs: ["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("context_packs as a non-array rejected", () => {
    const raw = { ...VALID_RAW, context_packs: "context-packs/intent/manifest.yaml" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs must be an array"))).toBe(true);
  });

  it("non-string context_packs entry rejected", () => {
    const raw = { ...VALID_RAW, context_packs: [42, "context-packs/ok/manifest.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]") && e.includes("must be a string"))).toBe(true);
  });

  it("unsafe context_packs path (dot-dot traversal) rejected", () => {
    const raw = { ...VALID_RAW, context_packs: ["../escape/manifest.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("not safe"))).toBe(true);
  });

  it("round-trip preserves context_packs through serialize → parse → normalize", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-context-packs",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "c".repeat(64), "packages/pkg/package.yaml": "d".repeat(64) },
      },
      contextPacks: ["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("context_packs:");
    expect(yaml).toContain("context-packs/intent/manifest.yaml");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.contextPacks).toBeDefined();
    expect(normalized.contextPacks).toEqual(["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"]);
  });

  it("missing context_packs round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-context-packs",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("context_packs:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.contextPacks).toBeUndefined();
  });

  // -- Item 6 agent_images block tests (slice-05 Checkpoint 7.3g) --

  it("missing agent_images block passes validation (backward compat)", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("agent_images as a string array of safe relative paths passes validation", () => {
    const raw = { ...VALID_RAW, agent_images: ["agent-images/seat-a", "agent-images/seat-b"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("agent_images as a non-array rejected", () => {
    const raw = { ...VALID_RAW, agent_images: "agent-images/x" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images must be an array"))).toBe(true);
  });

  it("non-string agent_images entry rejected", () => {
    const raw = { ...VALID_RAW, agent_images: [99, "agent-images/ok"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]") && e.includes("must be a string"))).toBe(true);
  });

  it("unsafe agent_images path (dot-dot traversal) rejected", () => {
    const raw = { ...VALID_RAW, agent_images: ["../escape"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("not safe"))).toBe(true);
  });

  it("round-trip preserves agent_images through serialize → parse → normalize", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-agent-images",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "e".repeat(64), "packages/pkg/package.yaml": "f".repeat(64) },
      },
      agentImages: ["agent-images/seat-a", "agent-images/seat-b"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("agent_images:");
    expect(yaml).toContain("agent-images/seat-a");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.agentImages).toBeDefined();
    expect(normalized.agentImages).toEqual(["agent-images/seat-a", "agent-images/seat-b"]);
  });

  it("missing agent_images round-trips cleanly (no field emitted in YAML)", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-agent-images",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("agent_images:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.agentImages).toBeUndefined();
  });
});

describe("isRelativeSafePath", () => {
  it("accepts simple relative paths including names with dots", () => {
    expect(isRelativeSafePath("rig.yaml")).toBe(true);
    expect(isRelativeSafePath("packages/review-kit/package.yaml")).toBe(true);
    expect(isRelativeSafePath("packages/my-package.v2")).toBe(true);
    expect(isRelativeSafePath("skills/deep..review/SKILL.md")).toBe(true);
  });

  it("rejects unsafe paths", () => {
    expect(isRelativeSafePath("")).toBe(false);
    expect(isRelativeSafePath("/absolute")).toBe(false);
    expect(isRelativeSafePath("../traversal")).toBe(false);
    expect(isRelativeSafePath("foo\\bar")).toBe(false);
    expect(isRelativeSafePath("./dotted")).toBe(false);
    expect(isRelativeSafePath("foo//bar")).toBe(false);
    expect(isRelativeSafePath(".")).toBe(false);
  });
});
