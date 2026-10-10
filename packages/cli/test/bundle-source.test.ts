import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { StatusDeps } from "../src/commands/status.js";
import { DaemonClient } from "../src/client.js";
import { PodBundleAssembler } from "../../daemon/src/domain/pod-bundle-assembler.js";
import { parseGitHubBundleLink, selectGitHubBundleSource, prepareGitHubBundle, importGitHubBundle, bundleIdentityLines, bundleGit, authoredCompatibility } from "../src/lib/bundle-source.js";

const state = vi.hoisted(() => ({ host: undefined as string | undefined, origin: "local-instance", remote: "local-instance" }));
vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => state.origin }));
vi.mock("../src/host-selection.js", () => ({ resolveEffectiveHost: (explicit?: string) => explicit ?? state.host }));
vi.mock("../src/daemon-lifecycle.js", () => ({ getDaemonStatus: async () => ({ state: "running", healthy: true }), getDaemonUrl: () => "http://localhost:17895" }));

const A = "a".repeat(40), B = "b".repeat(40);
const URL = "https://github.com/example/teams/tree/main/rigs/dev";
const refs = `${A}\tHEAD\n${A}\trefs/heads/main\n${B}\trefs/heads/feature/team\n${B}\trefs/tags/v1\n${A}\trefs/tags/v1^{}\n`;

describe("GitHub bundle source", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-source-test-"));
    state.host = undefined; state.origin = "local-instance"; state.remote = "local-instance";
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    [URL, A, "main", "rigs/dev"],
    ["https://github.com/example/teams/tree/v1", A, "v1", "."],
    ["https://github.com/example/teams/tree/feature/team/rig", B, "feature/team", "rig"],
    [`https://github.com/example/teams/tree/${B}/rig`, B, B, "rig"],
    ["https://github.com/example/teams", A, "HEAD", "."],
  ])("pins branch/tag/commit/folder %s", (url, commit, ref, folder) => {
    const s = selectGitHubBundleSource(url, refs);
    expect(s).toMatchObject({ resolvedCommit: commit, requestedRef: ref, folder });
    expect(s.canonicalUrl).toContain(`/tree/${commit}`);
  });

  it("never changes an already pinned link when a branch moves", () => {
    const first = selectGitHubBundleSource(URL, refs);
    const moved = refs.replace(`${A}\trefs/heads/main`, `${B}\trefs/heads/main`);
    expect(selectGitHubBundleSource(URL, moved).resolvedCommit).toBe(B);
    expect(selectGitHubBundleSource(first.canonicalUrl, moved)).toMatchObject({ resolvedCommit: A, folder: "rigs/dev" });
  });

  it.each(["https://SECRET@github.com/example/teams/tree/main", "https://github.com/example/teams/tree/main?token=SECRET", "http://github.com/example/teams/tree/main", "https://github.com/example/teams/blob/main/rig.yaml"])("rejects unsupported input without echoing it", input => {
    try { parseGitHubBundleLink(input); throw new Error("unexpected acceptance"); }
    catch (err) { expect((err as Error).message).toContain("credential-free"); expect((err as Error).message).not.toContain("SECRET"); }
  });

  it("fetches only the resolved commit and owns one retained archive/receipt", async () => {
    const calls: string[][] = [];
    const git = async (cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "ls-remote") return refs;
      if (args[0] === "rev-parse") return A;
      if (args[0] === "checkout") {
        fs.mkdirSync(path.join(cwd, "rigs/dev"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "rigs/dev/rig.yaml"), "name: team\n");
      }
      return "";
    };
    const prepared = await prepareGitHubBundle(URL, git, root);
    expect(calls.filter(c => c[0] === "fetch")).toEqual([["fetch", "--depth=1", "--no-tags", "--", "https://github.com/example/teams", A]]);
    expect(JSON.parse(fs.readFileSync(prepared.receiptPath, "utf8"))).toEqual(prepared.source);
    expect(prepared.archivePath).toBe(path.join(path.dirname(prepared.receiptPath), "bundle.rigbundle"));
  });

  it("does not substitute another fetched commit or a missing source folder", async () => {
    const wrong = async (_cwd: string, args: string[]) => args[0] === "ls-remote" ? refs : args[0] === "rev-parse" ? B : "";
    await expect(prepareGitHubBundle(URL, wrong, root)).rejects.toThrow(/did not match/);
    expect(fs.readdirSync(root)).toEqual([]);
    const missing = async (_cwd: string, args: string[]) => args[0] === "ls-remote" ? refs : args[0] === "rev-parse" ? A : "";
    await expect(prepareGitHubBundle(URL, missing, root)).rejects.toThrow(/must contain rig.yaml/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  function checkoutWith(populate: (checkout: string, folder: string) => void) {
    return async (cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") return refs;
      if (args[0] === "rev-parse") return A;
      if (args[0] === "checkout") {
        const folder = path.join(cwd, "rigs/dev");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "rig.yaml"), "name: team\n");
        populate(cwd, folder);
      }
      return "";
    };
  }

  function rigWithAgent(folder: string, ref: string) {
    fs.writeFileSync(path.join(folder, "rig.yaml"), `version: "0.2"\nname: team\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: helper\n        agent_ref: ${JSON.stringify(ref)}\n        profile: default\n        runtime: codex\n        cwd: .\n`);
  }

  function writeAgent(dir: string, name: string, imports: string[] = []) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.yaml"), `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n${imports.length ? "imports:\n" + imports.map(ref => `  - ref: ${JSON.stringify(ref)}\n`).join("") : ""}`);
    fs.writeFileSync(path.join(dir, "notes.txt"), `${name} repository fixture\n`);
  }

  it("rejects an outside-folder agent symlink and removes the import", async () => {
    const outside = path.join(root, "host-only.txt");
    fs.writeFileSync(outside, "synthetic host-only fixture\n");
    const imports = path.join(root, "imports");
    const git = checkoutWith((checkout, folder) => {
      rigWithAgent(folder, "local:../../agents/helper");
      const agent = path.join(checkout, "agents/helper");
      writeAgent(agent, "helper");
      fs.symlinkSync(outside, path.join(agent, "outside.txt"));
    });
    await expect(prepareGitHubBundle(URL, git, imports)).rejects.toThrow(/symlinks must resolve inside/);
    expect(fs.readdirSync(imports)).toEqual([]);
    expect(fs.readFileSync(outside, "utf8")).toBe("synthetic host-only fixture\n");
  });

  it.each(["member-local", "member-path", "import-local", "import-path"])("rejects outside agent references: %s", async kind => {
    const outside = path.join(root, "host-agent");
    writeAgent(outside, "host-fixture");
    const imports = path.join(root, "imports");
    const git = checkoutWith((checkout, folder) => {
      const helper = path.join(checkout, "agents/helper");
      const base = kind.startsWith("member") ? folder : helper;
      const ref = kind.endsWith("local") ? `local:${path.relative(base, outside)}` : `path:${outside}`;
      if (kind.startsWith("member")) rigWithAgent(folder, ref);
      else {
        rigWithAgent(folder, "local:../../agents/helper");
        writeAgent(helper, "helper", [ref]);
      }
    });
    await expect(prepareGitHubBundle(URL, git, imports)).rejects.toThrow(/refs must resolve inside/);
    expect(fs.readdirSync(imports)).toEqual([]);
    expect(fs.readFileSync(path.join(outside, "notes.txt"), "utf8")).toBe("host-fixture repository fixture\n");
  });

  it.each([[false, "local"], [true, "local"], [false, "path"], [true, "path"]] as const)("assembles shared agents and imports outside the selected folder (preset=%s, ref=%s)", async (preset, refKind) => {
    const git = checkoutWith((checkout, folder) => {
      rigWithAgent(folder, refKind === "local" ? "local:../../agents/helper" : `path:${path.join(checkout, "agents/helper")}`);
      writeAgent(path.join(checkout, "agents/helper"), "helper", ["local:../library"]);
      writeAgent(path.join(checkout, "agents/library"), "library");
      fs.writeFileSync(path.join(folder, "configurations.yaml"), 'schema: openrig.bundle-configurations/v1\nrecommended: authored\nseats:\n  dev.helper:\n    runtimes: { codex: default, claude-code: default }\npresets:\n  authored: { dev.helper: codex }\n  alternate: { dev.helper: claude-code }\n');
    });
    const prepared = await prepareGitHubBundle(URL, git, path.join(root, "imports"));
    const output = path.join(root, "assembled");
    const assembler = new PodBundleAssembler({ fsOps: {
      readFile: file => fs.readFileSync(file, "utf8"), readFileBuffer: fs.readFileSync,
      exists: fs.existsSync, realpath: fs.realpathSync,
      mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
      writeFile: (file, bytes) => fs.writeFileSync(file, bytes),
      copyDir: (from, to) => fs.cpSync(from, to, { recursive: true }),
      listFiles: dir => fs.readdirSync(dir, { recursive: true }).map(String).filter(file => fs.statSync(path.join(dir, file)).isFile()),
    } });
    const f = fixture();
    let assembledRigRoot = "";
    f.post.mockImplementation(async (_url, body) => {
      assembledRigRoot = body.rigRoot as string;
      expect(body.bundleName).toBe("team");
      const result = assembler.assemble({ rigRoot: assembledRigRoot, rigSpecPath: body.specPath as string,
        outputDir: output, bundleName: "fixture", bundleVersion: "1.0.0" });
      expect(result.manifest.agents.map(agent => agent.name)).toEqual(["helper"]);
      expect(fs.readFileSync(path.join(output, "agents/helper/notes.txt"), "utf8")).toBe("helper repository fixture\n");
      expect(fs.readFileSync(path.join(output, "agents/library/notes.txt"), "utf8")).toBe("library repository fixture\n");
      expect(fs.readFileSync(path.join(output, "rig.yaml"), "utf8")).toContain(`runtime: ${preset ? "claude-code" : "codex"}`);
      return { status: 201, data: { source: prepared.source, configurationId: "fixture", packageDigest: { value: "fixture", coverage: "openrig.package-digest/v1" }, assembler: { openrigVersion: "0.6.6" }, archiveHash: "fixture" } };
    });
    await importGitHubBundle(URL, f.deps, preset ? { preset: "alternate" } : {}, async () => prepared);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(prepared.checkoutDir)).toBe(false);
    expect(fs.existsSync(assembledRigRoot)).toBe(false);
  });

  it.each(["relative", "absolute", "dangling", "nested-directory"])("rejects unsafe repository symlinks: %s", async kind => {
    const outside = path.join(root, "host-only.txt");
    fs.writeFileSync(outside, "synthetic host-only fixture\n");
    const imports = path.join(root, "imports");
    const git = checkoutWith((checkout, folder) => {
      let linkDir = folder;
      if (kind === "nested-directory") {
        linkDir = path.join(checkout, "shared");
        fs.mkdirSync(linkDir);
        fs.symlinkSync("../../shared", path.join(folder, "linked-directory"));
      }
      const target = kind === "absolute" ? outside
        : kind === "dangling" ? "missing.txt"
        : path.relative(linkDir, outside);
      fs.symlinkSync(target, path.join(linkDir, "notes.txt"));
    });
    await expect(prepareGitHubBundle(URL, git, imports)).rejects.toThrow("GitHub bundle symlinks must resolve inside the fetched repository");
    expect(fs.readdirSync(imports)).toEqual([]);
    expect(fs.readFileSync(outside, "utf8")).toBe("synthetic host-only fixture\n");
  });

  it("preserves contained file and directory symlinks, including directory cycles", async () => {
    const git = checkoutWith((checkout, folder) => {
      fs.mkdirSync(path.join(checkout, "shared"));
      fs.writeFileSync(path.join(checkout, "shared/notes.txt"), "repository fixture\n");
      fs.symlinkSync("../../shared/notes.txt", path.join(folder, "notes.txt"));
      fs.symlinkSync("../../shared", path.join(folder, "linked-directory"));
      fs.symlinkSync(".", path.join(folder, "self"));
    });
    const prepared = await prepareGitHubBundle(URL, git, path.join(root, "imports"));
    expect(fs.lstatSync(path.join(prepared.folder, "notes.txt")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(prepared.folder, "notes.txt"), "utf8")).toBe("repository fixture\n");
    expect(fs.readFileSync(path.join(prepared.folder, "linked-directory/notes.txt"), "utf8")).toBe("repository fixture\n");
  });


  it("resolves and checks out an actual Git commit after its branch moves", async () => {
    const repository = path.join(root, "repository"); fs.mkdirSync(repository);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
    git(repository, ["init", "--template=", "-b", "main"]);
    fs.mkdirSync(path.join(repository, "rigs/dev"), { recursive: true });
    fs.writeFileSync(path.join(repository, "rigs/dev/rig.yaml"), "name: original\n");
    git(repository, ["add", "."]); git(repository, ["commit", "-m", "original"]);
    const original = git(repository, ["rev-parse", "HEAD"]);
    const adapter = async (cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") {
        const listed = git(cwd, ["ls-remote", repository]);
        fs.writeFileSync(path.join(repository, "rigs/dev/rig.yaml"), "name: moved\n");
        git(repository, ["commit", "-am", "moved"]);
        return listed;
      }
      return git(cwd, args.map(arg => arg === "https://github.com/example/teams" ? repository : arg));
    };
    const prepared = await prepareGitHubBundle(URL, adapter, path.join(root, "imports"));
    expect(prepared.source.resolvedCommit).toBe(original);
    expect(fs.readFileSync(path.join(prepared.folder, "rig.yaml"), "utf8")).toBe("name: original\n");
    expect(git(repository, ["rev-parse", "HEAD"])).not.toBe(original);
  });

  it("uses a credential-free Git environment and sanitizes actual Git errors", async () => {
    expect(await bundleGit(root, ["config", "--global", "--list"])).toBe("");
    await expect(bundleGit(root, ["not-a-command-SECRET"])).rejects.toThrow("GitHub bundle fetch failed or timed out.");
    try { await bundleGit(root, ["not-a-command-SECRET"]); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
  });

  it("names a missing git executable without exposing process details", async () => {
    vi.stubEnv("PATH", root);
    try { await expect(bundleGit(root, ["--version"])).rejects.toThrow("git is required for GitHub links."); }
    finally { vi.unstubAllEnvs(); }
  });

  function fixture() {
    const checkoutDir = path.join(root, "source"); fs.mkdirSync(checkoutDir);
    fs.writeFileSync(path.join(checkoutDir, "rig.yaml"), 'version: "0.2"\nname: sample\npods: []\n');
    fs.writeFileSync(path.join(checkoutDir, "bundle.yaml"), 'compatibility:\n  min_daemon_version: "0.6.6"\n  min_cli_version: "0.6.5"\n');
    const prepared = { source: selectGitHubBundleSource(URL, refs), folder: checkoutDir, checkoutDir, archivePath: path.join(root, "bundle.rigbundle"), receiptPath: path.join(root, "source.json") };
    const post = vi.fn(async (_url: string, body: Record<string, unknown>) => ({ status: 201, data: { source: (body.provenance as { source: unknown }).source, configurationId: "build.dev=codex", packageDigest: { value: "digest", coverage: "openrig.package-digest/v1" }, assembler: { openrigVersion: "0.6.6" }, archiveHash: "archive" } }));
    const client = { get: vi.fn(async () => ({ status: 200, data: { selfHostId: state.remote } })), post } as unknown as DaemonClient;
    const deps = { lifecycleDeps: {}, clientFactory: () => client } as StatusDeps;
    return { prepared, post, deps, prepare: vi.fn(async () => prepared) };
  }

  it.each(["persisted", "explicit", "forwarded", "unknown"])("%s remote/unverified target fetches and creates nothing", async mode => {
    const f = fixture();
    if (mode === "persisted") state.host = "other-host";
    if (mode === "forwarded") state.remote = "other-instance";
    if (mode === "unknown") state.origin = "";
    await expect(importGitHubBundle(URL, f.deps, { host: mode === "explicit" ? "other-host" : undefined }, f.prepare)).rejects.toThrow(/verified local daemon/);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });

  it("uses one create, passes authored minima and source, then cleans only settled input", async () => {
    const f = fixture();
    const result = await importGitHubBundle(URL, f.deps, { minCliVersion: "0.6.6" }, f.prepare);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[0]![1]).toMatchObject({ compatibility: { minDaemonVersion: "0.6.6", minCliVersion: "0.6.6" }, provenance: { source: f.prepared.source } });
    expect(fs.existsSync(f.prepared.checkoutDir)).toBe(false);
    expect(fs.existsSync(path.join(root, "build.json"))).toBe(true);
    expect(result.bundlePath).toBe(f.prepared.archivePath);
    expect(bundleIdentityLines(result.res.data).join("\n")).toContain("excludes bundle.yaml");
    expect(bundleIdentityLines(result.res.data)).toContain("Assembler: OpenRig 0.6.6");
  });

  it("retains input after an unknown create outcome and never installs/retries", async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error("socket lost"));
    await expect(importGitHubBundle(URL, f.deps, {}, f.prepare)).rejects.toThrow(/outcome is unknown/);
    expect(fs.existsSync(f.prepared.checkoutDir)).toBe(true); expect(f.post).toHaveBeenCalledTimes(1);
  });

  it.each(["compatibility", "configuration"])("removes owned checkout on definite %s failure before create", async kind => {
    const f = fixture();
    fs.writeFileSync(f.prepared.receiptPath, "{}\n");
    if (kind === "compatibility") fs.writeFileSync(path.join(f.prepared.folder, "bundle.yaml"), "compatibility: false\n");
    await expect(importGitHubBundle(URL, f.deps, kind === "configuration" ? { preset: "missing" } : {}, f.prepare)).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
    expect(fs.existsSync(f.prepared.checkoutDir)).toBe(false);
    expect(fs.existsSync(f.prepared.receiptPath)).toBe(false);
  });

  it("reports malformed authored minima instead of dropping them", () => {
    fs.writeFileSync(path.join(root, "bundle.yaml"), "compatibility:\n  min_cli_version: 3\n");
    expect(() => authoredCompatibility(root)).toThrow(/version string/);
  });
});
