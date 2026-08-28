import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { assemblePlainFiles, PLAIN_COMPOSE_SEPARATOR } from "../src/domain/context-packs/bundle-assembler.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

function writePack(root: string, ref: string, name = "existing"): void {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), `name: ${name}\nversion: 1\ntaxonomy: mission\nfiles:\n  - path: notes.md\n    role: source\n`);
  writeFileSync(join(dir, "notes.md"), "existing bytes");
}

function captureError(fn: () => unknown): ContextPackError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContextPackError);
    return err as ContextPackError;
  }
  throw new Error("expected ContextPackError");
}

describe("ATOM 3 — plain ordered file assembly", () => {
  it.each([
    ["A", "B", `A${PLAIN_COMPOSE_SEPARATOR}B`],
    ["A\n", "B", `A\n${PLAIN_COMPOSE_SEPARATOR}B`],
    ["A", "B\n", `A${PLAIN_COMPOSE_SEPARATOR}B\n`],
    ["A\n", "B\n", `A\n${PLAIN_COMPOSE_SEPARATOR}B\n`],
  ])("preserves EOF-newline bytes: %j + %j", (a, b, expected) => {
    const result = assemblePlainFiles({
      files: [
        { path: "a.md", content: a },
        { path: "b.md", content: b },
      ],
    });
    expect(result.text).toBe(expected);
    expect(result.text).not.toContain("# OpenRig Context Pack:");
    expect(result.text).not.toContain("## File:");
    expect(result.bytes).toBe(Buffer.byteLength(expected));
  });

  it("surfaces missing members instead of fabricating content", () => {
    const result = assemblePlainFiles({
      files: [
        { path: "present.md", content: "present" },
        { path: "absent.md", content: null },
      ],
    });
    expect(result.text).toBe("present");
    expect(result.missingFiles).toEqual([{ path: "absent.md" }]);
  });
});

describe("ATOM 3 — durable compose into the Atom-2 ref store", () => {
  let tmp: string;
  let userRoot: string;
  let sourceRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-compose-"));
    userRoot = join(tmp, "user-store");
    sourceRoot = join(tmp, "sources");
    mkdirSync(sourceRoot, { recursive: true });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function service(extra?: Record<string, unknown>): ContextPackLibraryService {
    return new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
      ...extra,
    });
  }

  function source(name: string, content: string): string {
    const path = join(sourceRoot, name);
    writeFileSync(path, content);
    return path;
  }

  it("writes one byte-identical member per source, deterministic manifest order, and a ref-resolvable pack", () => {
    const a = source("a.md", "---\naudience: dev\n---\nA\n");
    const c = source("c.yaml", "audience: dev\n");
    const b = source("b.data", "B-without-newline");
    const lib = service();
    const injectionShapedLabel = "a:\nfiles:\n  - path: forged.md";

    const result = lib.composeFromFiles({
      outRef: "packs/qitem-brief",
      sources: [
        { path: a, label: injectionShapedLabel },
        { path: c, label: "c.yaml" },
        { path: b, label: "b.data" },
      ],
    });

    const target = join(userRoot, "packs", "qitem-brief");
    const manifest = parseYaml(readFileSync(join(target, "manifest.yaml"), "utf-8")) as {
      name: string;
      version: string;
      files: Array<{ path: string; role: string; summary: string }>;
    };
    expect(manifest).toEqual({
      name: "qitem-brief",
      version: "1",
      purpose: "Composed from 3 ordered files",
      taxonomy: "mission",
      files: [
        { path: "source-0001.md", role: "source", summary: injectionShapedLabel },
        { path: "source-0002.yaml", role: "source", summary: "c.yaml" },
        { path: "source-0003.txt", role: "source", summary: "b.data" },
      ],
    });
    expect(readFileSync(join(target, "source-0001.md"))).toEqual(readFileSync(a));
    expect(readFileSync(join(target, "source-0002.yaml"))).toEqual(readFileSync(c));
    expect(readFileSync(join(target, "source-0003.txt"))).toEqual(readFileSync(b));
    expect(result.text).toBe(
      `${readFileSync(a, "utf-8")}${PLAIN_COMPOSE_SEPARATOR}` +
      `${readFileSync(c, "utf-8")}${PLAIN_COMPOSE_SEPARATOR}${readFileSync(b, "utf-8")}`,
    );
    expect(result.ref).toBe("packs/qitem-brief");
    expect(result.entry.relativePath).toBe("packs/qitem-brief");
    expect(lib.list().map((entry) => entry.relativePath)).toEqual(["packs/qitem-brief"]);
    expect(lib.getByRef("packs/qitem-brief")?.sourcePath).toBe(target);
  });

  it("rejects unsafe refs before creating the store root", () => {
    const a = source("a.md", "A");
    const err = captureError(() => service().composeFromFiles({
      outRef: "../escape",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("unsafe_ref");
    expect(existsSync(userRoot)).toBe(false);
  });

  it("surfaces missing sources and performs no store mutation", () => {
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/missing",
      sources: [{ path: join(sourceRoot, "absent.md"), label: "absent.md" }],
    }));
    expect(err.code).toBe("missing_files");
    expect(err.details?.["missingFiles"]).toEqual([join(sourceRoot, "absent.md")]);
    expect(existsSync(userRoot)).toBe(false);
  });

  it("uses missing_files for an empty source list before store inspection or mutation", () => {
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/empty",
      sources: [],
    }));
    expect(err.code).toBe("missing_files");
    expect(err.details?.["missingFiles"]).toEqual([]);
    expect(existsSync(userRoot)).toBe(false);
  });

  it("surfaces unreadable/non-file sources and performs no store mutation", () => {
    const dir = join(sourceRoot, "directory.md");
    mkdirSync(dir);
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/unreadable",
      sources: [{ path: dir, label: "directory.md" }],
    }));
    expect(err.code).toBe("file_read_failed");
    expect(existsSync(userRoot)).toBe(false);
  });

  it("rejects an exact-ref conflict in ANY discovery root before touching the user target", () => {
    const workspaceRoot = join(tmp, "workspace-store");
    writePack(workspaceRoot, "packs/taken", "workspace-pack");
    const a = source("a.md", "A");
    const lib = new ContextPackLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });
    const err = captureError(() => lib.composeFromFiles({
      outRef: "packs/taken",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("pack_exists");
    expect(existsSync(join(userRoot, "packs", "taken"))).toBe(false);
    expect(lib.getByRef("packs/taken")?.name).toBe("workspace-pack");
  });

  it("reports complete source preflight before an existing-ref conflict and mutates nothing", () => {
    const workspaceRoot = join(tmp, "workspace-store");
    writePack(workspaceRoot, "packs/taken", "workspace-pack");
    const existingManifest = readFileSync(join(workspaceRoot, "packs", "taken", "manifest.yaml"));
    const missing = join(sourceRoot, "absent.md");
    const lib = new ContextPackLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });

    const err = captureError(() => lib.composeFromFiles({
      outRef: "packs/taken",
      sources: [{ path: missing, label: "absent.md" }],
    }));

    expect(err.code).toBe("missing_files");
    expect(err.details?.["missingFiles"]).toEqual([missing]);
    expect(existsSync(join(userRoot, "packs", "taken"))).toBe(false);
    expect(readFileSync(join(workspaceRoot, "packs", "taken", "manifest.yaml"))).toEqual(existingManifest);
  });

  it("rejects a manifestless physical user target without overwriting it", () => {
    const target = join(userRoot, "packs", "taken");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel"), "keep-me");
    const a = source("a.md", "A");
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/taken",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("pack_exists");
    expect(readFileSync(join(target, "sentinel"), "utf-8")).toBe("keep-me");
    expect(existsSync(join(target, "manifest.yaml"))).toBe(false);
  });

  it("rejects a ref below a manifest-bearing leaf with zero mutation", () => {
    writePack(userRoot, "packs", "leaf-pack");
    const a = source("a.md", "A");
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/hidden-child",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("pack_ref_below_pack");
    expect(existsSync(join(userRoot, "packs", "hidden-child"))).toBe(false);
  });

  it("rejects symlink and non-directory namespace segments with zero mutation", () => {
    const a = source("a.md", "A");
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    mkdirSync(userRoot);
    symlinkSync(outside, join(userRoot, "linked"));
    let err = captureError(() => service().composeFromFiles({
      outRef: "linked/escape",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("unsafe_ref_namespace");
    expect(existsSync(join(outside, "escape"))).toBe(false);

    writeFileSync(join(userRoot, "blocked"), "not-a-directory");
    err = captureError(() => service().composeFromFiles({
      outRef: "blocked/child",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("unsafe_ref_namespace");
    expect(readFileSync(join(userRoot, "blocked"), "utf-8")).toBe("not-a-directory");
  });

  it("cleans a newly-created target when a member write fails; no manifest/ref survives", () => {
    const a = source("a.md", "A");
    const b = source("b.md", "B");
    let writes = 0;
    const lib = service({
      writeFile: (path: string, data: string | Buffer) => {
        writes += 1;
        if (writes === 2) throw new Error("injected write failure");
        writeFileSync(path, data);
      },
    });
    const err = captureError(() => lib.composeFromFiles({
      outRef: "packs/write-fails",
      sources: [{ path: a, label: "a.md" }, { path: b, label: "b.md" }],
    }));
    expect(err.code).toBe("pack_write_failed");
    expect(existsSync(join(userRoot, "packs", "write-fails"))).toBe(false);
    expect(lib.getByRef("packs/write-fails")).toBeNull();
  });
});
