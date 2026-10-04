// `rig bundle create --context-pack <dir>`: a pack whose manifest sits at a
// repository root (outside the rig folder) is carried by manifest name, with
// only its manifest and declared files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { vendorContextPackDir } from "../src/domain/bundle-carried-context-pack.js";

const MANIFEST = `name: demo-world
version: 0.1.0
taxonomy: world
files:
  - path: identity/who.md
    role: identity
  - path: craft/how.md
    role: craft
`;

function walk(dir: string): string[] {
  const out: string[] = [];
  (function w(d: string, pre: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) w(path.join(d, e.name), rel); else out.push(rel);
    }
  })(dir, "");
  return out.sort();
}

describe("vendorContextPackDir", () => {
  let work: string;
  let repo: string;
  let staging: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "carried-pack-"));
    repo = path.join(work, "world-repo");
    staging = path.join(work, "staging");
    fs.mkdirSync(path.join(repo, "identity"), { recursive: true });
    fs.mkdirSync(path.join(repo, "craft"), { recursive: true });
    fs.mkdirSync(path.join(repo, "rigs", "dev"), { recursive: true });
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(repo, "manifest.yaml"), MANIFEST);
    fs.writeFileSync(path.join(repo, "identity", "who.md"), "# Who\n");
    fs.writeFileSync(path.join(repo, "craft", "how.md"), "# How\n");
    fs.writeFileSync(path.join(repo, "rigs", "dev", "rig.yaml"), "name: dev\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# Not part of the pack\n");
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("carries a repository-root pack by manifest name, with only its manifest and declared files", () => {
    const declared = vendorContextPackDir(repo, staging);

    expect(declared).toBe("context-packs/demo-world/manifest.yaml");
    expect(walk(staging)).toEqual([
      "context-packs/demo-world/craft/how.md",
      "context-packs/demo-world/identity/who.md",
      "context-packs/demo-world/manifest.yaml",
    ]);
    expect(fs.readFileSync(path.join(staging, "context-packs/demo-world/manifest.yaml"), "utf-8")).toBe(MANIFEST);
  });

  it("refuses a declared file that is a symlink out of the pack directory", () => {
    const outside = path.join(work, "outside.md");
    fs.writeFileSync(outside, "# outside\n");
    fs.rmSync(path.join(repo, "craft", "how.md"));
    fs.symlinkSync(outside, path.join(repo, "craft", "how.md"));

    expect(() => vendorContextPackDir(repo, staging)).toThrow(/resolves outside the pack directory/);
    expect(walk(staging)).toEqual([]);
  });

  it("refuses a declared file that does not exist", () => {
    fs.rmSync(path.join(repo, "craft", "how.md"));
    expect(() => vendorContextPackDir(repo, staging)).toThrow(/declares 'craft\/how.md', which does not exist/);
  });

  it("refuses a second pack with the same manifest name", () => {
    vendorContextPackDir(repo, staging);
    expect(() => vendorContextPackDir(repo, staging)).toThrow(/already in the bundle/);
  });

  it("refuses a directory without a manifest", () => {
    expect(() => vendorContextPackDir(path.join(repo, "rigs"), staging)).toThrow(/has no manifest.yaml/);
  });
});
