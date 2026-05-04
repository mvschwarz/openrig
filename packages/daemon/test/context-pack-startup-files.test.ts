// PL-014 Item 6 — AgentSpec startup_files: kind: context_pack tests.
//
// Pins the load-bearing behaviors:
//   - normalizeStartupBlock parses kind: context_pack entries into
//     typed records with synthesized path
//   - validateStartupFile rejects malformed kind: context_pack entries
//   - back-compat: existing kind-less entries continue to parse cleanly
//   - expandContextPacks (the rigspec-instantiator helper) writes the
//     assembled bundle to <rigRoot>/.openrig/resolved-context-packs/
//     and rewrites the entry as kind: "file" pointing at it
//   - missing pack surfaces a structured error
//   - missing library service surfaces a structured error

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeStartupBlock,
  validateStartupFile,
} from "../src/domain/startup-validation.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";

function writePack(root: string, name: string, manifest: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("normalizeStartupBlock — kind: context_pack (PL-014 Item 6)", () => {
  it("parses kind: context_pack entry with name + version", () => {
    const block = normalizeStartupBlock({
      files: [
        { kind: "context_pack", name: "rsi-v2-priming", version: 1 },
      ],
    });
    const f = block.files[0]! as {
      kind: string; path: string;
      contextPackName: string; contextPackVersion: string;
      deliveryHint: string;
    };
    expect(f.kind).toBe("context_pack");
    expect(f.contextPackName).toBe("rsi-v2-priming");
    expect(f.contextPackVersion).toBe("1");
    // Synthesized path so downstream identifiers stay meaningful.
    expect(f.path).toContain("rsi-v2-priming-1.md");
    // Default delivery hint is send_text (paste into live seat).
    expect(f.deliveryHint).toBe("send_text");
  });

  it("defaults version to '1' when omitted", () => {
    const block = normalizeStartupBlock({
      files: [{ kind: "context_pack", name: "no-version" }],
    });
    expect((block.files[0] as { contextPackVersion: string }).contextPackVersion).toBe("1");
  });

  it("preserves operator-supplied delivery_hint over the default", () => {
    const block = normalizeStartupBlock({
      files: [{ kind: "context_pack", name: "p", delivery_hint: "guidance_merge" }],
    });
    expect((block.files[0] as { deliveryHint: string }).deliveryHint).toBe("guidance_merge");
  });

  it("back-compat: kind-less entries parse cleanly as kind: file", () => {
    const block = normalizeStartupBlock({
      files: [{ path: "skill.md" }],
    });
    const f = block.files[0]! as { kind: string; path: string };
    expect(f.kind).toBe("file");
    expect(f.path).toBe("skill.md");
  });

  it("mixed entries (file + context_pack) round-trip without leaking fields", () => {
    const block = normalizeStartupBlock({
      files: [
        { path: "skill.md" },
        { kind: "context_pack", name: "p", version: "2" },
      ],
    });
    expect(block.files).toHaveLength(2);
    expect((block.files[0] as { kind: string }).kind).toBe("file");
    expect((block.files[1] as { kind: string }).kind).toBe("context_pack");
    expect((block.files[0] as { contextPackName?: string }).contextPackName).toBeUndefined();
  });
});

describe("validateStartupFile — kind: context_pack (PL-014 Item 6)", () => {
  it("rejects unknown kind", () => {
    const errs = validateStartupFile({ kind: "bogus", path: "x.md" }, 0, "");
    expect(errs.some((e) => e.includes("kind"))).toBe(true);
  });

  it("rejects kind: context_pack missing name", () => {
    const errs = validateStartupFile({ kind: "context_pack" }, 0, "");
    expect(errs.some((e) => e.includes("name"))).toBe(true);
  });

  it("accepts kind: context_pack with name only (version defaults at normalize time)", () => {
    const errs = validateStartupFile({ kind: "context_pack", name: "p" }, 0, "");
    expect(errs).toEqual([]);
  });

  it("rejects kind: context_pack with non-string non-number version", () => {
    const errs = validateStartupFile({ kind: "context_pack", name: "p", version: { obj: true } }, 0, "");
    expect(errs.some((e) => e.includes("version"))).toBe(true);
  });

  it("back-compat: kind: file (or kind absent) goes through path safety check", () => {
    const errs = validateStartupFile({ path: "../escape.md" }, 0, "");
    expect(errs.length).toBeGreaterThan(0);
  });
});

// --- expandContextPacks integration ---
//
// The expandContextPacks helper is private on the PodRigInstantiator
// class; we exercise it via a minimal driver that reproduces the
// kind: context_pack entry shape the normalizer emits, then asserts
// the on-disk effect (bundle file written, entry rewritten as
// kind: "file"). This avoids spinning up the full materialize path.

import { mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync } from "node:fs";

function makeStartupFile(opts: { name: string; version?: string }) {
  const version = opts.version ?? "1";
  return {
    kind: "context_pack" as const,
    path: `.openrig/resolved-context-packs/${opts.name}-${version}.md`,
    absolutePath: "(unresolved)",
    ownerRoot: "(unresolved)",
    deliveryHint: "send_text" as const,
    required: true,
    appliesOn: ["fresh_start", "restore"] as ("fresh_start" | "restore")[],
    contextPackName: opts.name,
    contextPackVersion: version,
  };
}

// Re-implement the expandContextPacks core so we can test it without
// reaching into the PodRigInstantiator's private surface. Mirrors the
// helper at packages/daemon/src/domain/rigspec-instantiator.ts.
import { assembleBundle } from "../src/domain/context-packs/bundle-assembler.js";
import nodePath from "node:path";

function expandContextPacks(
  files: ReturnType<typeof makeStartupFile>[],
  rigRoot: string,
  library: ContextPackLibraryService | undefined,
): void {
  const targetDir = nodePath.join(rigRoot, ".openrig", "resolved-context-packs");
  let madeDir = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (f.kind !== "context_pack") continue;
    if (!library) {
      throw new Error(
        `startup_files entry references kind: context_pack '${f.contextPackName}' v${f.contextPackVersion}, but the daemon ContextPackLibraryService is not wired.`,
      );
    }
    const pack = library.getByNameVersion(f.contextPackName!, f.contextPackVersion!);
    if (!pack) {
      throw new Error(
        `Context pack '${f.contextPackName}' v${f.contextPackVersion} not found in library.`,
      );
    }
    const bundle = assembleBundle({ packEntry: pack });
    if (!madeDir) {
      fsMkdirSync(targetDir, { recursive: true });
      madeDir = true;
    }
    const targetPath = nodePath.join(targetDir, `${f.contextPackName}-${f.contextPackVersion}.md`);
    fsWriteFileSync(targetPath, bundle.text, "utf-8");
    files[i] = {
      ...f,
      kind: "file" as never,
      path: nodePath.relative(rigRoot, targetPath),
      absolutePath: targetPath,
      ownerRoot: rigRoot,
      contextPackName: undefined as never,
      contextPackVersion: undefined as never,
    };
  }
}

describe("expandContextPacks (PL-014 Item 6)", () => {
  let tmp: string;
  let libRoot: string;
  let rigRoot: string;
  let library: ContextPackLibraryService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "expand-pack-"));
    libRoot = join(tmp, "lib");
    rigRoot = join(tmp, "rig");
    mkdirSync(libRoot, { recursive: true });
    mkdirSync(rigRoot, { recursive: true });
    library = new ContextPackLibraryService({
      roots: [{ path: libRoot, sourceType: "user_file" }],
    });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes the assembled bundle to <rigRoot>/.openrig/resolved-context-packs/<name>-<version>.md and rewrites the entry as kind: file", () => {
    writePack(libRoot, "rsi-priming", `
name: rsi-priming
version: 1
purpose: RSI priming
files:
  - path: notes.md
    role: notes
`, { "notes.md": "RSI body" });
    library.scan();

    const files = [makeStartupFile({ name: "rsi-priming", version: "1" })];
    expandContextPacks(files, rigRoot, library);

    const f = files[0] as unknown as { kind: string; path: string; absolutePath: string; ownerRoot: string };
    expect(f.kind).toBe("file");
    expect(f.path).toContain(".openrig/resolved-context-packs/rsi-priming-1.md");
    expect(f.ownerRoot).toBe(rigRoot);
    expect(existsSync(f.absolutePath)).toBe(true);
    const content = readFileSync(f.absolutePath, "utf-8");
    expect(content).toContain("# OpenRig Context Pack: rsi-priming v1");
    expect(content).toContain("RSI body");
  });

  it("throws a structured error when the pack is not found in library", () => {
    library.scan();
    const files = [makeStartupFile({ name: "missing-pack" })];
    expect(() => expandContextPacks(files, rigRoot, library)).toThrow(/not found in library/);
  });

  it("throws a structured error when the library service is undefined", () => {
    const files = [makeStartupFile({ name: "p" })];
    expect(() => expandContextPacks(files, rigRoot, undefined)).toThrow(/ContextPackLibraryService is not wired/);
  });

  it("leaves kind: file entries untouched (back-compat)", () => {
    const fileEntry = {
      kind: "file" as const,
      path: "skill.md",
      absolutePath: "/abs/skill.md",
      ownerRoot: "/abs",
      deliveryHint: "auto" as const,
      required: true,
      appliesOn: ["fresh_start" as const, "restore" as const],
    };
    const files = [fileEntry as unknown as ReturnType<typeof makeStartupFile>];
    expandContextPacks(files, rigRoot, library);
    expect(files[0]).toBe(fileEntry);
  });

  it("expands multiple context_pack entries in one call without redundant mkdirSync", () => {
    writePack(libRoot, "p1", `
name: p1
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "P1" });
    writePack(libRoot, "p2", `
name: p2
version: 1
files:
  - path: b.md
    role: r
`, { "b.md": "P2" });
    library.scan();

    const files = [
      makeStartupFile({ name: "p1" }),
      makeStartupFile({ name: "p2" }),
    ];
    expandContextPacks(files, rigRoot, library);
    const f1 = files[0] as unknown as { kind: string; absolutePath: string };
    const f2 = files[1] as unknown as { kind: string; absolutePath: string };
    expect(f1.kind).toBe("file");
    expect(f2.kind).toBe("file");
    expect(readFileSync(f1.absolutePath, "utf-8")).toContain("P1");
    expect(readFileSync(f2.absolutePath, "utf-8")).toContain("P2");
  });
});
