import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StatusDeps } from "../src/commands/status.js";
import { DaemonClient } from "../src/client.js";
import { parseGitHubBundleLink, selectGitHubBundleSource, prepareGitHubBundle, importGitHubBundle, bundleIdentityLines, localBundleClient, authoredCompatibility } from "../src/lib/bundle-source.js";

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
    const missing = async (_cwd: string, args: string[]) => args[0] === "ls-remote" ? refs : args[0] === "rev-parse" ? A : "";
    await expect(prepareGitHubBundle(URL, missing, root)).rejects.toThrow(/must contain rig.yaml/);
  });

  function fixture() {
    const checkoutDir = path.join(root, "source"); fs.mkdirSync(checkoutDir);
    fs.writeFileSync(path.join(checkoutDir, "rig.yaml"), 'version: "0.2"\nname: sample\npods: []\n');
    fs.writeFileSync(path.join(checkoutDir, "bundle.yaml"), 'compatibility:\n  min_daemon_version: "0.6.6"\n  min_cli_version: "0.6.5"\n');
    const prepared = { source: selectGitHubBundleSource(URL, refs), folder: checkoutDir, checkoutDir, archivePath: path.join(root, "bundle.rigbundle"), receiptPath: path.join(root, "source.json") };
    const post = vi.fn(async (_url: string, body: Record<string, unknown>) => ({ status: 201, data: { source: (body.provenance as { source: unknown }).source, configurationId: "build.dev=codex", packageDigest: { value: "digest", coverage: "openrig.package-digest/v1" } } }));
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
  });

  it("retains input after an unknown create outcome and never installs/retries", async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error("socket lost"));
    await expect(importGitHubBundle(URL, f.deps, {}, f.prepare)).rejects.toThrow(/outcome is unknown/);
    expect(fs.existsSync(f.prepared.checkoutDir)).toBe(true); expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("reports malformed authored minima instead of dropping them", () => {
    fs.writeFileSync(path.join(root, "bundle.yaml"), "compatibility:\n  min_cli_version: 3\n");
    expect(() => authoredCompatibility(root)).toThrow(/version string/);
  });
});
