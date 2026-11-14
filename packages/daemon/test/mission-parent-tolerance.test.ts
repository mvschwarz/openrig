import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readParentScope, validateMissionParent } from "../src/domain/scope/mission-parent.js";

test("parent discovery skips malformed and unreadable documents and diagnoses bad chains", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-parent-"));
  try {
    for (const name of ["a", "b", "broken", "directory-manifest"]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, "a", "SPEC.md"), "---\nid: M.1\nparent: M.2\n---\n");
    fs.writeFileSync(path.join(root, "b", "SPEC.md"), "---\nid: M.2\nparent: M.1\n---\n");
    fs.writeFileSync(path.join(root, "broken", "SPEC.md"), "---\nid: [broken\n---\n");
    fs.writeFileSync(path.join(root, "directory-manifest", "SPEC.md"), "---\nid: M.3\n---\n");
    fs.mkdirSync(path.join(root, "directory-manifest", "mission.yaml"));
    const warnings: string[] = [];
    const nodes = readParentScope(root, { onInvalid: (message) => warnings.push(message) });
    assert.deepEqual(nodes.map((node) => node.id).sort(), ["M.1", "M.2"]);
    assert.equal(warnings.length, 2);
    validateMissionParent(nodes, "M.1", "M.2", (message) => warnings.push(message));
    assert.match(warnings.at(-1)!, /cycle/);
    assert.throws(() => validateMissionParent(nodes, "M.1", "M.99"), /resolves to 0 nodes/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
