// Daemon-side SPEC.md work-node resolution.
//
// The daemon cannot import packages/cli, so it carries its own resolver over the same contract:
// SPEC.md is the authored node file, README.md is the legacy name and stays valid forever. These
// pin the daemon half of that contract, including the surface that refuses a plan-lock — the whole
// SDLC flow dead-ends there if `rig scope slice approve` cannot see a SPEC-backed slice.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveNodeFile, withSpecFirst, isNodeFile, resolveNodeFileVia } from "../src/domain/scope/node-file.js";
import { projectSliceScope, type ScopeFsDeps } from "../src/domain/scope/scope-view-projection.js";

const SLICE_BODY = `---
id: OPR.9.9.9.1
slice: 01-spec-backed
mission: release-9.9.9
status: spec
---

# Slice 01 — spec-backed

## Intent

Prove the daemon reads a SPEC.md-backed slice.

## Proof contract

- [ ] Something provable.
`;

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-spec-md-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function nodeDir(name: string, fileName: string, body = SLICE_BODY): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), body, "utf8");
  return dir;
}

describe("daemon node-file resolution", () => {
  it("resolves SPEC.md, falls back to README.md, and reports null for neither", () => {
    expect(resolveNodeFile(nodeDir("a", "SPEC.md"))).toBe(path.join(root, "a", "SPEC.md"));
    expect(resolveNodeFile(nodeDir("b", "README.md"))).toBe(path.join(root, "b", "README.md"));
    const both = nodeDir("c", "SPEC.md");
    fs.writeFileSync(path.join(both, "README.md"), "legacy", "utf8");
    expect(resolveNodeFile(both)).toBe(path.join(both, "SPEC.md"));
    fs.mkdirSync(path.join(root, "d"), { recursive: true });
    expect(resolveNodeFile(path.join(root, "d"))).toBeNull();
  });

  // Several readers already searched multiple authored filenames in an order chosen for that
  // surface. SPEC.md goes in FRONT of each list; it must not reorder what was already there.
  it("prepends SPEC.md while preserving each existing precedence order", () => {
    expect(withSpecFirst(["IMPLEMENTATION-PRD.md", "README.md", "PROGRESS.md"]))
      .toEqual(["SPEC.md", "IMPLEMENTATION-PRD.md", "README.md", "PROGRESS.md"]);
    expect(withSpecFirst(["README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"]))
      .toEqual(["SPEC.md", "README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"]);
    // Idempotent — a list that already leads with SPEC.md does not grow a duplicate.
    expect(withSpecFirst(["SPEC.md", "README.md"])).toEqual(["SPEC.md", "README.md"]);
  });

  it("treats both names as the node file and nothing else", () => {
    expect(isNodeFile("SPEC.md")).toBe(true);
    expect(isNodeFile("README.md")).toBe(true);
    expect(isNodeFile("IMPLEMENTATION-PRD.md")).toBe(false);
    expect(isNodeFile("PROGRESS.md")).toBe(false);
  });

  it("resolves through an injected reader for callers that do not touch fs directly", () => {
    const tree = new Map([["/m/01/SPEC.md", "spec body"], ["/m/02/README.md", "legacy body"]]);
    const read = (p: string) => tree.get(p) ?? null;
    expect(resolveNodeFileVia("/m/01", read)).toEqual({ path: "/m/01/SPEC.md", content: "spec body" });
    expect(resolveNodeFileVia("/m/02", read)).toEqual({ path: "/m/02/README.md", content: "legacy body" });
    expect(resolveNodeFileVia("/m/03", read)).toBeNull();
  });
});

describe("scope view projection — SPEC.md-backed slices", () => {
  function deps(): ScopeFsDeps {
    return {
      exists: (p) => fs.existsSync(p),
      readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
      listDir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
      isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    };
  }

  it("projects a SPEC.md-only slice instead of returning null", () => {
    const dir = nodeDir("01-spec-backed", "SPEC.md");
    const projected = projectSliceScope(deps(), dir);
    expect(projected).not.toBeNull();
    expect(projected!.id).toBe("OPR.9.9.9.1");
  });

  it("still projects a README-only slice", () => {
    const dir = nodeDir("02-legacy", "README.md");
    const projected = projectSliceScope(deps(), dir);
    expect(projected).not.toBeNull();
    expect(projected!.id).toBe("OPR.9.9.9.1");
  });
});
