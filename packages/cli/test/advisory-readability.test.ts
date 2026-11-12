import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBundleFolder } from "../src/lib/bundle-check.js";
import { capabilityDeltaExpiryFindings } from "../src/lib/scope/capability-delta.js";
import { denyFixtureFile } from "./helpers/file-permissions.js";

describe("advisory checks respect actual file readability", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-advisory-read-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it.skipIf(process.getuid?.() === 0)("reports an unreadable declared README instead of passing its presence", async () => {
    fs.writeFileSync(path.join(root, "rig.yaml"), `version: "0.2"
name: acl-fixture
docs: [{path: README.md}]
pods:
  - id: infra
    label: Infrastructure
    members:
      - {id: observer, runtime: terminal, agent_ref: "builtin:terminal", profile: none, cwd: "."}
    edges: []
edges: []
`);
    const readme = path.join(root, "README.md");
    fs.writeFileSync(readme, "# Owned fixture\n");
    const check = async () => (await checkBundleFolder(root)).checks.find(c => c.ruleId === "readme_in_docs")?.status;
    expect(await check()).toBe("pass");
    const restore = denyFixtureFile(readme, "read");
    try {
      expect(() => fs.readFileSync(readme)).toThrow();
      expect(await check()).toBe("finding");
    } finally { restore(); }
    expect(await check()).toBe("pass");
  });

  it.skipIf(process.getuid?.() === 0)("keeps a delta live when its successor cannot be read", () => {
    fs.writeFileSync(path.join(root, "CAPABILITY-DELTA-v1.md"), "---\ncapability_delta: delta-v1\nexpiry:\n  canon_path: canon.md\n  successor_path: successor.md\n---\n");
    fs.writeFileSync(path.join(root, "canon.md"), "# Canon\nAbsorbed: delta-v1\n## Body\n");
    const successor = path.join(root, "successor.md");
    fs.writeFileSync(successor, "successor\n");
    expect(capabilityDeltaExpiryFindings(root)).toHaveLength(1);
    const restore = denyFixtureFile(successor, "read");
    try {
      expect(() => fs.readFileSync(successor)).toThrow();
      expect(capabilityDeltaExpiryFindings(root)).toEqual([]);
    } finally { restore(); }
    expect(capabilityDeltaExpiryFindings(root)).toHaveLength(1);
  });
});
