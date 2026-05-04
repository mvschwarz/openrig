// PL-016 Item 6 — evidence-preservation guard tests. CATASTROPHIC
// BOUNCE if dropped per PRD; this file pins the load-bearing
// behaviors:
//   - pinned image protected
//   - image referenced by an agent.yaml protected
//   - image referenced by a rig.yaml protected
//   - lineage descendants of protected images transitively protected
//   - non-referenced + non-pinned + non-descendant images are evictable
//   - the YAML scanner tolerates unrelated/large files

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateProtection } from "../src/domain/agent-images/evidence-guard.js";
import type { AgentImageEntry } from "../src/domain/agent-images/agent-image-types.js";

function makeImage(opts: {
  name: string;
  version?: string;
  pinned?: boolean;
  lineage?: string[];
  sourcePath?: string;
}): AgentImageEntry {
  return {
    id: `agent-image:${opts.name}:${opts.version ?? "1"}`,
    kind: "agent-image",
    name: opts.name,
    version: opts.version ?? "1",
    runtime: "claude-code",
    sourceSeat: "x@y",
    sourceSessionId: "sid",
    sourceResumeToken: "tok",
    notes: null,
    createdAt: "2026-05-04T19:00:00Z",
    sourceType: "user_file",
    sourcePath: opts.sourcePath ?? `/tmp/${opts.name}`,
    relativePath: opts.name,
    updatedAt: "2026-05-04T19:00:00Z",
    manifestEstimatedTokens: null,
    derivedEstimatedTokens: 0,
    files: [],
    stats: {
      forkCount: 0,
      lastUsedAt: null,
      estimatedSizeBytes: 0,
      lineage: opts.lineage ?? [],
    },
    lineage: opts.lineage ?? [],
    pinned: opts.pinned ?? false,
  };
}

describe("evaluateProtection (PL-016 Item 6)", () => {
  let tmp: string;
  let specRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-guard-"));
    specRoot = join(tmp, "specs");
    mkdirSync(specRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("protects pinned images", () => {
    const result = evaluateProtection({
      images: [makeImage({ name: "pinned", pinned: true })],
      specRoots: [],
    });
    expect(result[0]!.protected).toBe(true);
    expect(result[0]!.reasons).toContain("pinned");
  });

  it("protects images referenced by an agent.yaml", () => {
    mkdirSync(join(specRoot, "agents", "x"), { recursive: true });
    writeFileSync(join(specRoot, "agents", "x", "agent.yaml"), `
name: x
runtime: claude-code
session_source:
  mode: agent_image
  ref:
    kind: image_name
    value: critical-image
`);
    const result = evaluateProtection({
      images: [makeImage({ name: "critical-image" }), makeImage({ name: "evictable" })],
      specRoots: [specRoot],
    });
    const critical = result.find((r) => r.imageName === "critical-image")!;
    const evictable = result.find((r) => r.imageName === "evictable")!;
    expect(critical.protected).toBe(true);
    expect(critical.reasons).toContain("referenced_by_agent_spec");
    expect(evictable.protected).toBe(false);
  });

  it("protects images referenced by a rig.yaml", () => {
    writeFileSync(join(specRoot, "rig.yaml"), `
name: my-rig
pods:
  - id: dev
    members:
      - id: impl
        runtime: claude-code
        session_source:
          mode: agent_image
          ref:
            kind: image_name
            value: rig-referenced
`);
    const result = evaluateProtection({
      images: [makeImage({ name: "rig-referenced" })],
      specRoots: [specRoot],
    });
    expect(result[0]!.protected).toBe(true);
    expect(result[0]!.reasons).toContain("referenced_by_rig_spec");
  });

  it("transitively protects lineage descendants of protected images", () => {
    const result = evaluateProtection({
      images: [
        makeImage({ name: "ancestor", pinned: true }),
        makeImage({ name: "child", lineage: ["ancestor"] }),
        makeImage({ name: "grandchild", lineage: ["ancestor", "child"] }),
        makeImage({ name: "unrelated" }),
      ],
      specRoots: [],
    });
    const child = result.find((r) => r.imageName === "child")!;
    const grand = result.find((r) => r.imageName === "grandchild")!;
    const unrelated = result.find((r) => r.imageName === "unrelated")!;
    expect(child.protected).toBe(true);
    expect(child.reasons).toContain("lineage_descendant_of_protected");
    expect(grand.protected).toBe(true);
    expect(unrelated.protected).toBe(false);
  });

  it("handles missing/inaccessible spec roots gracefully (returns no references)", () => {
    const result = evaluateProtection({
      images: [makeImage({ name: "x" })],
      specRoots: ["/nonexistent/path"],
    });
    expect(result[0]!.protected).toBe(false);
  });

  it("ignores YAML that doesn't reference agent_image", () => {
    writeFileSync(join(specRoot, "rig.yaml"), `
name: my-rig
pods:
  - id: dev
    members:
      - id: impl
        runtime: claude-code
`);
    const result = evaluateProtection({
      images: [makeImage({ name: "x" })],
      specRoots: [specRoot],
    });
    expect(result[0]!.protected).toBe(false);
  });

  it("evictable image surfaces no reasons + empty references", () => {
    const result = evaluateProtection({
      images: [makeImage({ name: "lonely" })],
      specRoots: [specRoot],
    });
    expect(result[0]!.reasons).toEqual([]);
    expect(result[0]!.references).toEqual([]);
  });
});
