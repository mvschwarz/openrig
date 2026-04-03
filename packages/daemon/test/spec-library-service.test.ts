import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";

const VALID_RIG_YAML = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: claude-code
        profile: default
        cwd: /tmp
    edges: []
edges: []
`;

const VALID_AGENT_YAML = `
name: test-agent
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses: []
resources:
  skills: []
startup:
  files: []
  actions: []
`;

const INVALID_YAML = `
this is not: a valid spec
at all:
  - just random keys
`;

describe("SpecLibraryService", () => {
  let tmpDir: string;
  let specReviewService: SpecReviewService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spec-lib-"));
    specReviewService = new SpecReviewService();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLibrary(roots?: Array<{ path: string; sourceType: "builtin" | "user_file" }>) {
    return new SpecLibraryService({
      roots: roots ?? [{ path: tmpDir, sourceType: "user_file" }],
      specReviewService,
    });
  }

  it("scan discovers rig specs validated by SpecReviewService", () => {
    writeFileSync(join(tmpDir, "my-rig.yaml"), VALID_RIG_YAML);

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("rig");
    expect(entries[0]!.name).toBe("test-rig");
    expect(entries[0]!.sourceType).toBe("user_file");
    expect(entries[0]!.sourcePath).toContain("my-rig.yaml");
  });

  it("scan discovers agent specs validated by SpecReviewService", () => {
    writeFileSync(join(tmpDir, "my-agent.yaml"), VALID_AGENT_YAML);

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("agent");
    expect(entries[0]!.name).toBe("test-agent");
  });

  it("scan skips files that fail both rig and agent validation", () => {
    writeFileSync(join(tmpDir, "valid.yaml"), VALID_RIG_YAML);
    writeFileSync(join(tmpDir, "invalid.yaml"), INVALID_YAML);
    writeFileSync(join(tmpDir, "not-yaml.txt"), "just text");

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("test-rig");
  });

  it("list with kind filter returns only matching entries", () => {
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);
    writeFileSync(join(tmpDir, "agent.yaml"), VALID_AGENT_YAML);

    const lib = createLibrary();
    lib.scan();

    expect(lib.list({ kind: "rig" })).toHaveLength(1);
    expect(lib.list({ kind: "agent" })).toHaveLength(1);
    expect(lib.list()).toHaveLength(2);
  });

  it("get returns entry with YAML content from disk", () => {
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    const result = lib.get(entries[0]!.id);
    expect(result).not.toBeNull();
    expect(result!.entry.name).toBe("test-rig");
    expect(result!.yaml).toContain("test-rig");
  });

  it("IDs are deterministic across rescans", () => {
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);

    const lib = createLibrary();
    lib.scan();
    const id1 = lib.list()[0]!.id;
    lib.scan();
    const id2 = lib.list()[0]!.id;
    expect(id1).toBe(id2);
  });

  it("scan discovers nested specs and preserves relative paths in IDs", () => {
    mkdirSync(join(tmpDir, "agents", "impl"), { recursive: true });
    writeFileSync(join(tmpDir, "agents", "impl", "agent.yaml"), VALID_AGENT_YAML);

    const lib = createLibrary([{ path: tmpDir, sourceType: "builtin" }]);
    lib.scan();

    const entries = lib.list({ kind: "agent" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("test-agent");
    expect(entries[0]!.relativePath).toBe("agents/impl/agent.yaml");

    lib.scan();
    expect(lib.list({ kind: "agent" })[0]!.id).toBe(entries[0]!.id);
  });
});
