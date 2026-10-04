import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { checkBundleFolder } from "../src/lib/bundle-check.js";
import { bundleCommand } from "../src/commands/bundle.js";
import type { StatusDeps } from "../src/commands/status.js";

const SPEC = `version: "0.2"
name: author-fixture
docs: [{path: README.md}]
pods:
  - id: infra
    members:
      - { id: observer, runtime: terminal, agent_ref: "builtin:terminal", profile: none, cwd: "." }
    edges: []
edges: []
`;

describe("advisory bundle check", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-check-test-"));
    fs.writeFileSync(path.join(root, "rig.yaml"), SPEC); fs.writeFileSync(path.join(root, "README.md"), "# Test team\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("checks mechanical rules while leaving prose and arbitrary secrets explicitly unverified", async () => {
    const result = await checkBundleFolder(root);
    expect(result.standardVersion).toBe("openrig.bundle-standard/v1");
    expect(result.checks.filter(c => c.status === "finding")).toEqual([]);
    expect(result.checks.filter(c => c.status === "not_checked").map(c => c.ruleId)).toEqual(["readme_coverage", "embedded_secrets"]);
    expect(fs.readFileSync(path.join(root, "rig.yaml"), "utf8")).toBe(SPEC);
  });

  it.each([
    ["pod_aware_rig", () => fs.writeFileSync(path.join(root, "rig.yaml"), "not: a rig\n")],
    ["readme_in_docs", () => fs.rmSync(path.join(root, "README.md"))],
    ["portable_agents", () => fs.writeFileSync(path.join(root, "rig.yaml"), SPEC.replace("builtin:terminal", "path:/outside/agent").replace("runtime: terminal", "runtime: codex"))],
    ["minimum_versions", () => fs.writeFileSync(path.join(root, "bundle.yaml"), "compatibility:\n  min_cli_version: false\n")],
    ["configurations", () => fs.writeFileSync(path.join(root, "configurations.yaml"), "schema: wrong\n")],
    ["credential_paths", () => fs.writeFileSync(path.join(root, ".env"), "FAKE_TEST_ONLY=placeholder\n")],
  ] as const)("reports a broken %s rule", async (rule, breakRule) => {
    breakRule();
    expect((await checkBundleFolder(root)).checks).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: rule, status: "finding" })]));
  });

  it("command does not resolve a daemon, create a bundle, or invoke preflight", async () => {
    const factory = vi.fn(() => { throw new Error("daemon must not be used"); });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const deps = { clientFactory: factory, lifecycleDeps: new Proxy({}, { get() { throw new Error("lifecycle must not be used"); } }) } as StatusDeps;
      await new Command().addCommand(bundleCommand(deps)).parseAsync(["bundle", "check", root, "--json"], { from: "user" });
      expect(factory).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]![0])).standardVersion).toBe("openrig.bundle-standard/v1");
    } finally { log.mockRestore(); }
  });
});
