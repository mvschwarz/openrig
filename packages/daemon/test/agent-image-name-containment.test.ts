// An agent image name is one path segment, because it becomes a directory name.
//
// `install()` joins the name to the library root and creates that directory. The captured file paths
// beside it were already checked for `..` and a leading `/`; these cases pin the same rule for the
// directory itself, and pin that nothing is created when a name is refused.

import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { agentImageNameRefusal } from "../src/domain/agent-images/agent-image-name.js";
import type { AgentImageManifest } from "../src/domain/agent-images/agent-image-types.js";

function manifest(name: string): AgentImageManifest {
  return {
    name,
    version: "1",
    runtime: "claude-code",
    sourceSeat: "dev@fixture",
    sourceSessionId: "conversation",
    sourceResumeToken: "conversation",
    createdAt: new Date().toISOString(),
    files: [],
  };
}

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const refused: Array<[string, string]> = [
  ["a parent-directory segment", ".."],
  ["a traversal", "../../escaped"],
  ["a nested path", "nested/image"],
  ["a backslash separator", "nested\\image"],
  ["an absolute path", "/tmp/escaped"],
  ["a windows drive", "C:escaped"],
  ["a control character", "snap\u0000shot"],
];

it.each(refused)("refuses %s as an image name", (_label, name) => {
  expect(agentImageNameRefusal(name)).not.toBeNull();
});

it.each(["snapshot", "reviewer-baseline", "dev baseline 2026", "image.v2", "ünïcode-name"])(
  "accepts the ordinary name %s",
  (name) => {
    expect(agentImageNameRefusal(name)).toBeNull();
  },
);

it.each(refused)("install() refuses %s and creates nothing", (_label, name) => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-name-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  const outside = join(root, "..", "escaped");

  let thrown: unknown;
  try {
    library.install(root, manifest(name), new Map());
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ name: "AgentImageError", code: "manifest_invalid" });
  // Nothing is published, and nothing appeared beside the library either.
  library.scan();
  expect.soft(library.list()).toEqual([]);
  expect.soft(existsSync(outside)).toBe(false);
});

it("install() still writes an ordinary name", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-name-ok-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  const dir = library.install(root, manifest("snapshot"), new Map());
  expect(dir).toBe(join(root, "snapshot"));
  expect(existsSync(join(dir, "manifest.yaml"))).toBe(true);
});