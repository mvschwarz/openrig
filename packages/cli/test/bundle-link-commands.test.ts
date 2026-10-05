import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import path from "node:path";
import { bundleCommand } from "../src/commands/bundle.js";
import { upCommand } from "../src/commands/up.js";
import type { StatusDeps } from "../src/commands/status.js";

const f = vi.hoisted(() => ({ imported: vi.fn(), post: vi.fn() }));
vi.mock("../src/lib/bundle-source.js", async original => ({ ...await original<object>(), importGitHubBundle: f.imported }));
const link = "https://github.com/example/team/tree/main/rig";
const identity = { source: { resolvedCommit: "a".repeat(40), canonicalUrl: link }, configurationId: "build.dev=codex", packageDigest: { value: "digest", coverage: "openrig.package-digest/v1" }, archiveHash: "archive", assembler: { openrigVersion: "0.6.6" } };

describe("bundle link command dispatch", () => {
  const deps = { lifecycleDeps: {}, clientFactory: vi.fn(() => { throw new Error("unexpected second client"); }) } as unknown as StatusDeps;
  let log: ReturnType<typeof vi.spyOn>;
  let oldExit: typeof process.exitCode;
  beforeEach(() => {
    oldExit = process.exitCode; process.exitCode = undefined;
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.post.mockReset(); f.imported.mockReset();
    f.imported.mockResolvedValue({ client: { post: f.post }, bundlePath: "/tmp/owned/bundle.rigbundle", res: { status: 201, data: identity } });
    f.post.mockResolvedValue({ status: 200, data: { ...identity, manifest: { name: "fixture", version: "1.0" }, digestValid: true, integrityResult: { passed: true }, status: "completed" } });
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = oldExit; });

  it.each(["create", "inspect", "install", "up"])("%s builds once and returns one JSON result", async verb => {
    const program = new Command();
    program.addCommand(verb === "up" ? upCommand(deps) : bundleCommand(deps));
    const argv = verb === "up" ? ["up", link, "--json"] : ["bundle", verb, link, ...(verb === "create" ? ["-o", "team.rigbundle"] : []), "--json"];
    await program.parseAsync(argv, { from: "user" });
    expect(f.imported).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject(identity);
    const expected = verb === "create" ? [] : verb === "inspect" ? ["/api/bundles/inspect"] : ["/api/bundles/inspect", "/api/bundles/install"];
    expect(f.post.mock.calls.map(c => c[0])).toEqual(expected);
    if (verb !== "create") expect(f.post.mock.calls[0]![1]).toMatchObject({ bundlePath: "/tmp/owned/bundle.rigbundle" });
    if (verb === "up" || verb === "install") expect(f.post.mock.calls.find(c => c[0] === "/api/bundles/install")![1].targetRoot).toBe(process.cwd());
  });

  it("passes configuration choices and up target/cwd to the one resolved archive", async () => {
    const program = new Command().addCommand(upCommand(deps));
    await program.parseAsync(["up", link, "--preset", "all-codex", "--seat", "build.dev=pi", "--target", "project", "--cwd", "work", "--plan", "--json"], { from: "user" });
    expect(f.imported.mock.calls[0]![2]).toMatchObject({ preset: "all-codex", seat: ["build.dev=pi"] });
    expect(f.post.mock.calls.find(c => c[0] === "/api/bundles/install")![1]).toMatchObject({ targetRoot: path.resolve("project"), cwdOverride: path.resolve("work"), plan: true });
  });

  it.each(["up", "install"])("%s forwards opt-in, explicit opt-out and omission distinctly", async verb => {
    for (const [flag, expected] of [["--non-interruptive", true], ["--no-non-interruptive", false], [undefined, undefined]] as const) {
      f.post.mockClear();
      const program = new Command().addCommand(verb === "up" ? upCommand(deps) : bundleCommand(deps));
      await program.parseAsync([...(verb === "up" ? ["up", link] : ["bundle", "install", link]), ...(flag ? [flag] : []), "--json"], { from: "user" });
      expect(f.post.mock.calls.find(c => c[0] === "/api/bundles/install")![1].nonInterruptive).toBe(expected);
    }
  });

  it("does not call install after create returns an error", async () => {
    f.imported.mockResolvedValueOnce({ res: { status: 400, data: { error: "invalid bundle" } } });
    await new Command().addCommand(upCommand(deps)).parseAsync(["up", link, "--json"], { from: "user" });
    expect(f.post).not.toHaveBeenCalled(); expect(process.exitCode).toBe(2);
  });

  it.each(["up", "install"])("%s prints target conflicts as readable lines and keeps JSON structured", async verb => {
    const errors = ["Install target already has different content at README.md.", "Nothing was written. Choose an empty --target directory."];
    f.post.mockImplementation(async (url: string) => url === "/api/bundles/install"
      ? { status: 400, data: { status: "failed", code: "target_conflict", errors } }
      : { status: 200, data: { manifest: { name: "fixture", version: "1.0" } } });
    const argv = verb === "up" ? ["up", link] : ["bundle", "install", link];
    const command = () => new Command().addCommand(verb === "up" ? upCommand(deps) : bundleCommand(deps));
    await command().parseAsync(argv, { from: "user" });
    expect(console.error).toHaveBeenCalledWith(errors.join("\n"));
    expect(process.exitCode).toBe(2);
    log.mockClear();
    await command().parseAsync([...argv, "--json"], { from: "user" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ code: "target_conflict", errors });
    expect(f.imported).toHaveBeenCalledTimes(2);
  });

  it("names GitHub links in the up source argument help", () => {
    const help = upCommand(deps).helpInformation();
    expect(help).toMatch(/source\s+[^\n]*GitHub/);
  });

  it.each(["up", "install"])("%s shows pending startup guidance without changing its JSON or exit", async verb => {
    const attentionNodes = ["owner", "checker"].map(member => ({
      logicalId: `dev.${member}`, sessionName: `dev-${member}@fixture`,
      reason: `Permission consent needs attention; After resolving it in dev-${member}@fixture, run: rig seat continue 'dev-${member}@fixture'`,
    }));
    const data = { status: "partial", rigId: "fixture", stages: [{ stage: "import_rig", status: "blocked", detail: { attentionNodes } }] };
    // An unavailable optional inspection keeps the install result unaugmented.
    f.post.mockImplementation(async (url: string) => url === "/api/bundles/install"
      ? { status: 200, data }
      : { status: 500, data: { error: "view unavailable" } });
    const argv = verb === "up" ? ["up", link] : ["bundle", "install", link];
    const command = () => new Command().addCommand(verb === "up" ? upCommand(deps) : bundleCommand(deps));
    await command().parseAsync(argv, { from: "user" });
    const output = log.mock.calls.map(c => String(c[0]));
    expect(output).toContain("Status: partial");
    for (const node of attentionNodes) expect(output).toContain(`Startup attention (${node.sessionName}): ${node.reason}`);
    expect(process.exitCode).toBe(2);
    log.mockClear(); f.post.mockClear();
    await command().parseAsync([...argv, "--json"], { from: "user" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ ...data, ...identity });
    expect(process.exitCode).toBe(2);
    expect(f.post.mock.calls.map(c => c[0])).toEqual(["/api/bundles/inspect", "/api/bundles/install"]);
  });

  it("reports unknown install outcome, retains the path, and never retries", async () => {
    f.post.mockImplementation(async (url: string) => {
      if (url === "/api/bundles/inspect") return { status: 500, data: { error: "view unavailable" } };
      throw new Error("lost response");
    });
    await new Command().addCommand(bundleCommand(deps)).parseAsync(["bundle", "install", link, "--json"], { from: "user" });
    expect(f.post.mock.calls.map(c => c[0])).toEqual(["/api/bundles/inspect", "/api/bundles/install"]);
    expect(String(log.mock.calls[0]![0])).toContain("outcome is unknown");
    expect(String(log.mock.calls[0]![0])).toContain("/tmp/owned/bundle.rigbundle");
  });
});
