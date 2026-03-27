import { describe, it, expect } from "vitest";
import {
  validateBundleManifest,
  parseBundleManifest,
  normalizeBundleManifest,
  serializeBundleManifest,
  isRelativeSafePath,
  type BundleManifest,
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
