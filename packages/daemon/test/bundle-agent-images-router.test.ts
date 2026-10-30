import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { routeAgentImages, type AgentImagesRouterFsOps, type RouteAgentImagesInput } from "../src/domain/bundle-agent-images-router.js";

// Item 6 / slice-05 Checkpoint 7.3g step 2: bundle-agent-images-router
// pure-function tests. PRD line 197: declared paths are agent-image
// DIRECTORIES (not manifest paths — distinct from context_packs).
// All 4 banked router-level catches (file-existence, isDirectory check
// on manifest, declared-path-must-be-dir, basename collision) built in
// from the first commit per banked discipline.

function mockFs(initial: { dirs?: string[]; files?: string[] } = {}): AgentImagesRouterFsOps & {
  _copyCalls: Array<{ src: string; dest: string }>;
  _mkdirpCalls: string[];
  _dirs: Set<string>;
  _files: Set<string>;
} {
  const dirs = new Set<string>((initial.dirs ?? []).map(p => resolve(p)));
  const files = new Set<string>((initial.files ?? []).map(p => resolve(p)));
  const copyCalls: Array<{ src: string; dest: string }> = [];
  const mkdirpCalls: string[] = [];
  return {
    _copyCalls: copyCalls,
    _mkdirpCalls: mkdirpCalls,
    _dirs: dirs,
    _files: files,
    exists: (p: string) => dirs.has(p) || files.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
  };
}

/** Convenience: build a complete agent-image fixture (image dir + manifest.yaml file inside). */
function imageFixture(imageDir: string): { dirs: string[]; files: string[] } {
  return { dirs: [imageDir], files: [`${imageDir}/manifest.yaml`] };
}

const BUNDLE_ROOT = resolve("/bundle/root");
const TARGET = resolve("/operator/.openrig/agent-images");

function makeInput(overrides?: Partial<RouteAgentImagesInput>): RouteAgentImagesInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredAgentImages: [],
    targetAgentImagesDir: TARGET,
    ...overrides,
  };
}

describe("routeAgentImages", () => {
  // A1: empty list → empty records + target dir mkdirp'd
  it("empty declaredAgentImages produces empty records but still mkdirp's target", () => {
    const fs = mockFs();
    const result = routeAgentImages(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // A2: routes one image: copyDir from sourceAbs (declared dir) to target/<basename>
  it("routes one agent_image: declared dir copied to target/<basename>", () => {
    const fs = mockFs(imageFixture(`${BUNDLE_ROOT}/agent-images/seat-a`));
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/seat-a"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(join(TARGET, "seat-a"));
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: join(BUNDLE_ROOT, "agent-images/seat-a"),
      dest: join(TARGET, "seat-a"),
    });
  });

  // A3: multiple distinct images route correctly
  it("routes multiple distinct agent_images each to target/<basename>", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/agent-images/seat-a`, `${BUNDLE_ROOT}/agent-images/seat-b`],
      files: [
        `${BUNDLE_ROOT}/agent-images/seat-a/manifest.yaml`,
        `${BUNDLE_ROOT}/agent-images/seat-b/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({
        declaredAgentImages: [
          "agent-images/seat-a",
          "agent-images/seat-b",
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // A4: declared source dir absent → status=missing
  it("missing declared image dir → status=missing (honest-scoping)", () => {
    const fs = mockFs();
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/absent"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A5: unsafe source path escaping bundle workspace rejected
  it("unsafe source path escaping bundle workspace → status=unsafe", () => {
    const fs = mockFs();
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["../escape"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A6 (PRD-coherent discrimination): declared path exists but is a FILE
  // not a directory. PRD line 197 says declared path is an agent-image
  // DIRECTORY; if operator-declared path is a file, reject.
  it("declared path exists but is a file (not directory) → status=not_directory", () => {
    const fs = mockFs({ files: [`${BUNDLE_ROOT}/agent-images/seat-as-file`] });
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/seat-as-file"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(result.records[0]!.detail).toContain("not a directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A7 (banked d491eca9 lesson): image dir exists but manifest.yaml inside
  // is absent. Consumer skips the image — false-positive routedCount class.
  it("image dir exists but manifest.yaml inside is absent → status=not_manifest", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/agent-images/halfimage`],
      // NO manifest.yaml file
    });
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/halfimage"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("missing manifest.yaml");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A8 (banked 3cd581e3 lesson): image dir exists, manifest.yaml inside is
  // itself a DIRECTORY (not file). Consumer's readFileSync throws — false-
  // positive class. Reject.
  it("image dir exists but manifest.yaml inside is itself a directory → status=not_manifest", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/agent-images/dirmanifest`,
        `${BUNDLE_ROOT}/agent-images/dirmanifest/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/dirmanifest"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A9 (banked 16ebb8af lesson): two declared images sharing basename →
  // first wins (status=routed), second flagged status=conflict.
  it("two declared images sharing basename → first routed, second conflict (truthful routedCount)", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/a/seat-a`,
        `${BUNDLE_ROOT}/b/seat-a`,
      ],
      files: [
        `${BUNDLE_ROOT}/a/seat-a/manifest.yaml`,
        `${BUNDLE_ROOT}/b/seat-a/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({
        declaredAgentImages: ["a/seat-a", "b/seat-a"],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(join(TARGET, "seat-a"));
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("seat-a");
    expect(result.records[1]!.detail).toContain("collides");
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]!.src).toBe(join(BUNDLE_ROOT, "a/seat-a"));
  });

  // A10: mixed list — routed + missing + unsafe + not_directory +
  // not_manifest + conflict aggregate
  it("mixed declared list aggregates correctly across all rejection classes", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/agent-images/ok`,
        `${BUNDLE_ROOT}/agent-images/halfimage`, // no manifest.yaml inside
        `${BUNDLE_ROOT}/agent-images/dup`,
        `${BUNDLE_ROOT}/elsewhere/dup`,
      ],
      files: [
        `${BUNDLE_ROOT}/agent-images/ok/manifest.yaml`,
        `${BUNDLE_ROOT}/agent-images/seat-as-file`, // file at declared location
        `${BUNDLE_ROOT}/agent-images/dup/manifest.yaml`,
        `${BUNDLE_ROOT}/elsewhere/dup/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({
        declaredAgentImages: [
          "agent-images/ok",                  // routed
          "agent-images/absent",              // missing
          "../escape",                         // unsafe
          "agent-images/seat-as-file",        // not_directory
          "agent-images/halfimage",           // not_manifest (no manifest.yaml inside)
          "agent-images/dup",                 // routed (1st dup)
          "elsewhere/dup",                    // conflict (basename dup)
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(7);
    expect(result.routedCount).toBe(2);
    expect(result.rejectedCount).toBe(5);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_directory");
    expect(result.records[4]!.status).toBe("not_manifest");
    expect(result.records[5]!.status).toBe("routed");
    expect(result.records[6]!.status).toBe("conflict");
  });
});
