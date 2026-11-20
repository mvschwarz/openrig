// A dependency on a slice in another release mission resolves by its release version whatever the project's dot-ID
// prefix (2-3 uppercase letters), so a project with its own prefix (project.yaml scope.idPrefix) reads like OPR.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDep } from "../src/domain/execution-view.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each(["OPR", "OPS"])("resolves a %s dependency on a slice in another release mission", (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exec-dep-prefix-")); roots.push(root);
  const slice = path.join(root, "release-0.7.21", "slices", "01-dep");
  fs.mkdirSync(slice, { recursive: true });
  fs.writeFileSync(path.join(slice, "SPEC.md"), `---\nid: ${prefix}.0.7.21.1\n---\n\n# Dep\n`);
  expect(resolveDep(`${prefix}.0.7.21.1`, [], root, new Map())?.id).toBe(`${prefix}.0.7.21.1`);
});
