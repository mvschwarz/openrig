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
    label: Infrastructure
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
    ["portable_agents", () => fs.writeFileSync(path.join(root, "rig.yaml"), SPEC.replace("builtin:terminal", "path:/outside/agent").replace("runtime: terminal", "runtime: codex").replace("profile: none", "profile: default"))],
    ["minimum_versions", () => fs.writeFileSync(path.join(root, "bundle.yaml"), "compatibility:\n  min_cli_version: false\n")],
    ["configurations", () => fs.writeFileSync(path.join(root, "configurations.yaml"), "schema: wrong\n")],
    ["credential_paths", () => fs.writeFileSync(path.join(root, ".env"), "FAKE_TEST_ONLY=placeholder\n")],
  ] as const)("reports a broken %s rule", async (rule, breakRule) => {
    breakRule();
    expect((await checkBundleFolder(root)).checks).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: rule, status: "finding" })]));
  });


  it("reports a README directory instead of treating it as a readable document", async () => {
    fs.rmSync(path.join(root, "README.md")); fs.mkdirSync(path.join(root, "README.md"));
    const result = await checkBundleFolder(root);
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleId: "readme_in_docs", status: "finding" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleId: "referenced_files", status: "finding", path: "README.md" }));
  });

  it("checks startup paths relative to the declaring local agent", async () => {
    const dir = path.join(root, "agent"); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "rig.yaml"), SPEC.replace("builtin:terminal", "local:agent").replace("runtime: terminal", "runtime: codex").replace("profile: none", "profile: default"));
    fs.mkdirSync(path.join(dir, "skill"));
    fs.writeFileSync(path.join(dir, "agent.yaml"), 'name: fixture\nversion: "1.0"\nresources:\n  skills:\n    - {id: fixture, path: skill}\nstartup:\n  files:\n    - path: context.md\nprofiles:\n  default: {}\n');
    fs.writeFileSync(path.join(dir, "context.md"), "Context");
    expect((await checkBundleFolder(root)).checks.filter(c => c.status === "finding")).toEqual([]);
    fs.rmSync(path.join(dir, "context.md"));
    expect((await checkBundleFolder(root)).checks).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "referenced_files", status: "finding", path: "agent/context.md" })]));
    fs.mkdirSync(path.join(dir, "context.md"));
    expect((await checkBundleFolder(root)).checks).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "referenced_files", status: "finding", path: "agent/context.md" })]));
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

  it("human output names the file a finding is about", async () => {
    fs.writeFileSync(path.join(root, "rig.yaml"), SPEC.replace("docs: [{path: README.md}]", "docs: [{path: README.md}, {path: docs/missing.md}]"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      const deps = { clientFactory: vi.fn(), lifecycleDeps: {} } as unknown as StatusDeps;
      await new Command().addCommand(bundleCommand(deps)).parseAsync(["bundle", "check", root], { from: "user" });
      expect(log.mock.calls.map(c => String(c[0]))).toContain("finding: referenced_files: Declared file is missing, unreadable or outside the bundle folder. (docs/missing.md)");
      expect(process.exitCode).toBe(1);
    } finally { log.mockRestore(); process.exitCode = exitCode; }
  });

  it("checks that the recommended configuration is the authored team", async () => {
    const config = `schema: openrig.bundle-configurations/v1
recommended: authored
seats:
  infra.observer: { runtimes: { terminal: none, codex: default } }
presets:
  authored: { infra.observer: terminal }
  alternate: { infra.observer: codex }
`;
    fs.writeFileSync(path.join(root, "configurations.yaml"), config);
    expect((await checkBundleFolder(root)).checks).toContainEqual(expect.objectContaining({ ruleId: "configurations", status: "pass" }));
    fs.writeFileSync(path.join(root, "configurations.yaml"), config.replace("recommended: authored", "recommended: alternate"));
    expect((await checkBundleFolder(root)).checks).toContainEqual(expect.objectContaining({ ruleId: "configurations", status: "finding" }));
  });
});
