import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { routeWorkflowSpecs, type WorkflowSpecsRouterFsOps, type RouteWorkflowSpecsInput } from "../src/domain/bundle-workflow-specs-router.js";

// Item 6 / slice-05 Checkpoint 7.3e step 2: bundle-workflow-specs-router
// pure-function tests. Mirrors the bundle-skills-router test pattern with
// "workflows/" prefix and YAML file content shapes.

function mockFs(initialFiles: Record<string, string> = {}): WorkflowSpecsRouterFsOps & { _written: Map<string, string>; _mkdirpCalls: string[] } {
  const written = new Map<string, string>(Object.entries(initialFiles));
  const mkdirpCalls: string[] = [];
  return {
    _written: written,
    _mkdirpCalls: mkdirpCalls,
    exists: (p: string) => written.has(p),
    readFile: (p: string) => {
      const v = written.get(p);
      if (v === undefined) throw new Error(`File not found in mock: ${p}`);
      return v;
    },
    writeFile: (p: string, c: string) => { written.set(p, c); },
    mkdirp: (p: string) => { mkdirpCalls.push(p); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/workflow-specs";

function makeInput(overrides?: Partial<RouteWorkflowSpecsInput>): RouteWorkflowSpecsInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredWorkflowSpecs: [],
    targetWorkflowSpecsDir: TARGET,
    ...overrides,
  };
}

describe("routeWorkflowSpecs", () => {
  // W1: empty list → empty records + target dir mkdirp'd
  it("empty declaredWorkflowSpecs produces empty records but still mkdirp's target", () => {
    const fs = mockFs();
    const result = routeWorkflowSpecs(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // W2: routes one spec end-to-end
  it("routes one workflow_spec: source YAML copied to target with installedAt populated", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/onboarding.yaml`]: "name: onboarding\nversion: 1.0",
    });
    const result = routeWorkflowSpecs(makeInput({ declaredWorkflowSpecs: ["workflows/onboarding.yaml"] }), fs);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/onboarding.yaml`);
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("name: onboarding\nversion: 1.0");
  });

  // W3: routes multiple specs; preserves directory layout
  it("routes multiple workflow_specs preserving the directory layout under target", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/onboarding.yaml`]: "yaml-1",
      [`${BUNDLE_ROOT}/workflows/release.yaml`]: "yaml-2",
      [`${BUNDLE_ROOT}/workflows/sub/maintenance.yaml`]: "yaml-3",
    });
    const result = routeWorkflowSpecs(
      makeInput({
        declaredWorkflowSpecs: ["workflows/onboarding.yaml", "workflows/release.yaml", "workflows/sub/maintenance.yaml"],
      }),
      fs,
    );
    expect(result.routedCount).toBe(3);
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("yaml-1");
    expect(fs._written.get(`${TARGET}/release.yaml`)).toBe("yaml-2");
    expect(fs._written.get(`${TARGET}/sub/maintenance.yaml`)).toBe("yaml-3");
  });

  // W4: missing source file → "missing" record (skipped, not error)
  it("missing source file is skipped with status=missing (honest-scoping)", () => {
    const fs = mockFs();
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/absent.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
  });

  // W5: unsafe source path escaping bundle workspace rejected
  it("unsafe declared path (../traversal) escapes bundle workspace and is rejected", () => {
    const fs = mockFs();
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["../escape/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
  });

  // W6: mixed list — routed + missing + unsafe in one call
  it("mixed declared list aggregates correctly across routed/missing/unsafe", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/ok.yaml`]: "ok",
    });
    const result = routeWorkflowSpecs(
      makeInput({
        declaredWorkflowSpecs: ["workflows/ok.yaml", "workflows/absent.yaml", "../escape/spec.yaml"],
      }),
      fs,
    );
    expect(result.records).toHaveLength(3);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(2);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
  });

  // W7-B1: target-side path containment (banked both-sides-trust-boundary).
  // Declared path "workflows/../outside/spec.yaml" passes SOURCE containment
  // (resolves under bundleRoot since the leading "workflows/" segment is
  // consumed before ../) but after the leading "workflows/" strip becomes
  // "../outside/spec.yaml" which would escape targetWorkflowSpecsDir.
  it("declared path that would escape target workflow-specs dir after prefix strip is rejected", () => {
    const fs = mockFs({
      // Source is reachable from bundleRoot via "workflows/../outside/spec.yaml"
      // which resolves to "<bundleRoot>/outside/spec.yaml" — passes source check.
      [`${BUNDLE_ROOT}/outside/spec.yaml`]: "would-escape-target",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/../outside/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes target workflow-specs library");
    // Crucially: no write happened outside target.
    expect(fs._written.has(`${TARGET}/../outside/spec.yaml`)).toBe(false);
    expect(fs._written.has(nodePath.resolve(`${TARGET}/../outside/spec.yaml`))).toBe(false);
  });

  // W8: non-"workflows/" prefixed declared path is honored as-is (no leading strip)
  it("declared path without leading workflows/ prefix routes verbatim", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/custom/path/spec.yaml`]: "custom",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["custom/path/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/custom/path/spec.yaml`);
  });
});
