import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import realFs from "node:fs";
import os from "node:os";
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
    copyFile: (src: string, dest: string) => {
      const v = written.get(src);
      if (v === undefined) throw new Error(`File not found in mock: ${src}`);
      written.set(dest, v);
    },
    mkdirp: (p: string) => { mkdirpCalls.push(p); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
// TARGET is an arbitrary fixture path — the router is parametric on
// targetWorkflowSpecsDir and the unit tests do not depend on any specific
// operator-host layout. The CALLER CONTRACT documented in
// bundle-workflow-specs-router.ts RouteWorkflowSpecsInput.targetWorkflowSpecsDir
// requires step 3 integration to resolve this via
// `nodePath.join(ContextPackSettingsStore.resolveConfig().workspaceSpecsRoot,
// "workflows")` — SettingsStore is the sole authority. Hardcoding the
// scanner-default path here would be a drift hazard if SettingsStore
// changes its default; the integration-level dogfood proves the wiring.
const TARGET = "/test/workflow-specs-target";

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

  // W2: routes one spec end-to-end at top-level basename
  it("routes one workflow_spec: source YAML copied to target/<basename> with installedAt populated", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/onboarding.yaml`]: "name: onboarding\nversion: 1.0",
    });
    const result = routeWorkflowSpecs(makeInput({ declaredWorkflowSpecs: ["workflows/onboarding.yaml"] }), fs);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    // Basename-only: declared "workflows/onboarding.yaml" → target/onboarding.yaml
    // (scanner-reachability contract: spec-library-workflow-scanner reads only
    // top-level YAML; nested paths would be invisible).
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/onboarding.yaml`);
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("name: onboarding\nversion: 1.0");
  });

  // W3: routes multiple specs ALL FLAT at top level (basename collapses layout)
  it("routes multiple workflow_specs all flat at top level (basename collapses directory layout)", () => {
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
    // All land at top-level basename — the "sub/" prefix on entry 3 is stripped
    // by basename(). This matches scanner-reachability (readdirSync + isFile only).
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("yaml-1");
    expect(fs._written.get(`${TARGET}/release.yaml`)).toBe("yaml-2");
    expect(fs._written.get(`${TARGET}/maintenance.yaml`)).toBe("yaml-3");
    // Confirm the would-be-nested path is NOT created (basename flattened it).
    expect(fs._written.has(`${TARGET}/sub/maintenance.yaml`)).toBe(false);
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

  // W7: target-side escape attempt lands SAFELY at basename (structural
  // containment via basename — replaces the prior prefix-strip target-escape
  // hazard from the skills router; basename guarantees no traversal).
  it("target-escape attempt via traversal still lands safely at basename (structural containment)", () => {
    const fs = mockFs({
      // Source is reachable from bundleRoot via "workflows/../outside/spec.yaml"
      // which resolves to "<bundleRoot>/outside/spec.yaml" — passes source check.
      [`${BUNDLE_ROOT}/outside/spec.yaml`]: "would-have-escaped-target",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/../outside/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    // basename("workflows/../outside/spec.yaml") = "spec.yaml" → lands safely.
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/spec.yaml`);
    expect(fs._written.get(`${TARGET}/spec.yaml`)).toBe("would-have-escaped-target");
    // Confirm: no write outside target dir.
    expect(fs._written.has(`${TARGET}/../outside/spec.yaml`)).toBe(false);
    expect(fs._written.has(nodePath.resolve(`${TARGET}/../outside/spec.yaml`))).toBe(false);
  });

  // W8: non-prefixed declared path lands at its basename (prefix-strip is
  // obsoleted by basename — the rule is uniform).
  it("declared path without any leading prefix routes to target/<basename>", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/custom/path/spec.yaml`]: "custom",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["custom/path/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    // basename("custom/path/spec.yaml") = "spec.yaml" → top-level under target.
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/spec.yaml`);
    expect(fs._written.has(`${TARGET}/custom/path/spec.yaml`)).toBe(false);
  });

  // W9: duplicate basenames — first wins (status=routed), later flagged
  // status=conflict so routedCount stays truthful at the scanner-visible
  // boundary (banked B1 guard catch d81456dc → this commit).
  it("duplicate basenames: first routes, later flagged status=conflict (truthful routedCount)", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/a/onboarding.yaml`]: "a-content",
      [`${BUNDLE_ROOT}/b/onboarding.yaml`]: "b-content",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["a/onboarding.yaml", "b/onboarding.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/onboarding.yaml`);
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("basename");
    expect(result.records[1]!.detail).toContain("collides");
    // Crucially: first content survives (no silent overwrite).
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("a-content");
  });

  // W10: non-YAML suffix — scanner is YAML-only, route would be invisible.
  // Reject pre-write so routedCount stays truthful (banked B2 guard catch
  // d81456dc → this commit).
  it("non-YAML suffix declared path rejected status=unsafe (scanner-invisible class)", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/readme.txt`]: "not a workflow spec",
      [`${BUNDLE_ROOT}/workflows/good.yaml`]: "yaml-good",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/readme.txt", "workflows/good.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("not a .yaml/.yml");
    expect(result.records[1]!.status).toBe("routed");
    expect(result.records[1]!.installedAt).toBe(`${TARGET}/good.yaml`);
    // .txt file never written even though source exists in bundle
    expect(fs._written.has(`${TARGET}/readme.txt`)).toBe(false);
    // Also covers .yml as accepted suffix
    const fs2 = mockFs({ [`${BUNDLE_ROOT}/workflows/short.yml`]: "yml-too" });
    const r2 = routeWorkflowSpecs(makeInput({ declaredWorkflowSpecs: ["workflows/short.yml"] }), fs2);
    expect(r2.routedCount).toBe(1);
    expect(r2.records[0]!.status).toBe("routed");
  });
});

describe("routeWorkflowSpecs copies bytes through the real filesystem", () => {
  it("a non-UTF-8 file arrives byte-identical", () => {
    const root = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-workflow-specs-router-bytes-"));
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x80, 0x00, 0xc3, 0x28, 0xff, 0xfe]);
      const bundleRoot = nodePath.join(root, "bundle");
      realFs.mkdirSync(nodePath.join(bundleRoot, "workflows"), { recursive: true });
      realFs.writeFileSync(nodePath.join(bundleRoot, "workflows", "latin1.yaml"), bytes);
      const target = nodePath.join(root, "target");
      const result = routeWorkflowSpecs(
        { ...makeInput(), bundleRoot, declaredWorkflowSpecs: ["workflows/latin1.yaml"], targetWorkflowSpecsDir: target },
        { exists: realFs.existsSync, mkdirp: (p) => realFs.mkdirSync(p, { recursive: true }), copyFile: realFs.copyFileSync },
      );
      expect(result.routedCount).toBe(1);
      const installedAt = result.records[0]!.installedAt!;
      expect(realFs.readFileSync(installedAt).equals(bytes)).toBe(true);
    } finally {
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
