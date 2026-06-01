import { describe, it, expect } from "vitest";
import { routeContextPacks, type ContextPacksRouterFsOps, type RouteContextPacksInput } from "../src/domain/bundle-context-packs-router.js";

// Item 6 / slice-05 Checkpoint 7.3f step 2: bundle-context-packs-router
// pure-function tests. Mirrors plugins router (dir-based) with the
// context-pack-specific degenerate-input handling per the consumer
// contract (context-pack-library-service.scan walks pack dirs whose
// immediate child is manifest.yaml).

function mockFs(initial: { dirs?: string[]; files?: string[] } = {}): ContextPacksRouterFsOps & {
  _copyCalls: Array<{ src: string; dest: string }>;
  _mkdirpCalls: string[];
  _dirs: Set<string>;
  _files: Set<string>;
} {
  const dirs = new Set<string>(initial.dirs ?? []);
  const files = new Set<string>(initial.files ?? []);
  const copyCalls: Array<{ src: string; dest: string }> = [];
  const mkdirpCalls: string[] = [];
  return {
    _copyCalls: copyCalls,
    _mkdirpCalls: mkdirpCalls,
    _dirs: dirs,
    _files: files,
    // exists() respects both dirs and files (matches node:fs.existsSync semantics)
    exists: (p: string) => dirs.has(p) || files.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
  };
}

/** Convenience: build a complete pack fixture (parent dir + manifest.yaml file). */
function packFixture(packParentDir: string): { dirs: string[]; files: string[] } {
  return { dirs: [packParentDir], files: [`${packParentDir}/manifest.yaml`] };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/context-packs";

function makeInput(overrides?: Partial<RouteContextPacksInput>): RouteContextPacksInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredContextPacks: [],
    targetContextPacksDir: TARGET,
    ...overrides,
  };
}

describe("routeContextPacks", () => {
  // C1: empty list → empty records + target dir mkdirp'd
  it("empty declaredContextPacks produces empty records but still mkdirp's target", () => {
    const fs = mockFs();
    const result = routeContextPacks(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // C2: routes one pack: copyDir from sourceParentDir to target/<dirname>
  it("routes one context_pack: parent dir copied to target/<dirname>", () => {
    const fs = mockFs(packFixture(`${BUNDLE_ROOT}/context-packs/intent`));
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/intent/manifest.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/intent`);
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: `${BUNDLE_ROOT}/context-packs/intent`,
      dest: `${TARGET}/intent`,
    });
  });

  // C3: multiple distinct packs route correctly
  it("routes multiple distinct context_packs each to target/<dirname>", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/context-packs/intent`, `${BUNDLE_ROOT}/context-packs/persona`],
      files: [`${BUNDLE_ROOT}/context-packs/intent/manifest.yaml`, `${BUNDLE_ROOT}/context-packs/persona/manifest.yaml`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/intent/manifest.yaml",
          "context-packs/persona/manifest.yaml",
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // C4: missing source pack dir → status=missing (the manifest.yaml file
  // itself is absent because the parent isn't there either)
  it("missing source pack dir → status=missing (honest-scoping)", () => {
    const fs = mockFs();
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/absent/manifest.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C5: unsafe source path escaping bundle workspace rejected
  it("unsafe source path escaping bundle workspace → status=unsafe", () => {
    const fs = mockFs();
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["../escape/manifest.yaml"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C6 (degenerate-input): basename not manifest.yaml — consumer-invisible
  // class. Per banked PRE-handoff degenerate-input dogfood discipline.
  it("declared path with non-manifest.yaml basename → status=not_manifest", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/context-packs/oddpack`],
      files: [`${BUNDLE_ROOT}/context-packs/oddpack/pack.yaml`, `${BUNDLE_ROOT}/context-packs/oddpack/manifest.txt`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/oddpack/pack.yaml",
          "context-packs/oddpack/manifest.txt",
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("manifest.yaml");
    expect(result.records[1]!.status).toBe("not_manifest");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C7 (degenerate-input): parent-dir basename collision — first wins,
  // second flagged conflict. Banked workflow_specs B1 lesson applied.
  it("two declared packs sharing parent-dir basename → first routed, second conflict", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/a/intent`, `${BUNDLE_ROOT}/b/intent`],
      files: [`${BUNDLE_ROOT}/a/intent/manifest.yaml`, `${BUNDLE_ROOT}/b/intent/manifest.yaml`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "a/intent/manifest.yaml",
          "b/intent/manifest.yaml",
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/intent`);
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("intent");
    expect(result.records[1]!.detail).toContain("collides");
    // Only the first copyDir fires.
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]!.src).toBe(`${BUNDLE_ROOT}/a/intent`);
  });

  // C8: pack source path exists but is a file not a directory — edge case
  // (unusual; manifest.yaml dirname resolved to a file). Skipped honestly.
  it("source parent exists but is a file (not directory) → status=not_directory", () => {
    // Make manifest file exist (so the file-existence check passes) but the
    // parent is registered as a FILE not a directory.
    const fs = mockFs({ files: [`${BUNDLE_ROOT}/oddpath`, `${BUNDLE_ROOT}/oddpath/manifest.yaml`] });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["oddpath/manifest.yaml"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C9: mixed list — routed + missing + unsafe + not_manifest + conflict
  // aggregate correctly
  it("mixed declared list aggregates correctly across all rejection classes", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/context-packs/ok`,
        `${BUNDLE_ROOT}/context-packs/dup`,
        `${BUNDLE_ROOT}/elsewhere/dup`,
      ],
      files: [
        `${BUNDLE_ROOT}/context-packs/ok/manifest.yaml`,
        `${BUNDLE_ROOT}/context-packs/dup/manifest.yaml`,
        `${BUNDLE_ROOT}/elsewhere/dup/manifest.yaml`,
      ],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/ok/manifest.yaml",         // routed
          "context-packs/absent/manifest.yaml",      // missing
          "../escape/manifest.yaml",                  // unsafe
          "context-packs/odd/pack.yaml",              // not_manifest
          "context-packs/dup/manifest.yaml",         // routed (1st dup)
          "elsewhere/dup/manifest.yaml",             // conflict (basename dup with above)
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(6);
    expect(result.routedCount).toBe(2);
    expect(result.rejectedCount).toBe(4);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_manifest");
    expect(result.records[4]!.status).toBe("routed");
    expect(result.records[5]!.status).toBe("conflict");
  });

  // C11 (degenerate-input / banked guard catch on d491eca9):
  // manifest.yaml exists at the declared path but is a DIRECTORY, not a
  // file. fs.exists returns true for both shapes; the live consumer
  // (context-pack-library-service.ts:135 readFileSync) throws on a dir
  // path and scan() records an error diagnostic instead of indexing the
  // pack. Router must reject pre-write so routedCount stays truthful.
  it("manifest.yaml exists but is a directory → status=not_manifest (no false-positive routed)", () => {
    const fs = mockFs({
      // Parent dir IS a directory, AND manifest.yaml is ALSO a directory
      // (not a file). The bare exists check would pass; isDirectory check
      // catches this.
      dirs: [
        `${BUNDLE_ROOT}/context-packs/dirpack`,
        `${BUNDLE_ROOT}/context-packs/dirpack/manifest.yaml`,
      ],
    });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/dirpack/manifest.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(1);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("directory");
    // CRUCIAL: no copyDir fires (consumer-invisible pack must not route)
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C10 (degenerate-input / banked guard catch on a0e7e0e1):
  // parent dir exists but manifest.yaml file itself is absent —
  // ContextPackLibraryService.scan skips packs missing manifest.yaml
  // (context-pack-library-service.ts:76). The router must check the
  // manifest FILE existence, not just the parent dir, or routedCount
  // claims a consumer-invisible pack.
  it("parent dir exists but manifest.yaml file missing → status=missing (no false-positive routed)", () => {
    const fs = mockFs({
      // Parent dir is present + isDirectory, BUT manifest.yaml is NOT in
      // files (consumer requires the file itself).
      dirs: [`${BUNDLE_ROOT}/context-packs/halfpack`],
    });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/halfpack/manifest.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(1);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
    // CRUCIAL: no copyDir fires (operator-invisible pack must not route)
    expect(fs._copyCalls).toHaveLength(0);
  });
});
