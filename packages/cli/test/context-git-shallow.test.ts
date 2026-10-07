import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGitContext, inspectGitContext, updateGitContext } from "../src/lib/context-git.js";

const transport = vi.hoisted(() => ({
  refusal: null as string | null,
  hideHeadSymref: false,
  afterAdvertisement: null as (() => void) | null,
  calls: [] as string[][],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args: readonly string[], options: import("node:child_process").ExecFileSyncOptionsWithStringEncoding) => {
      if (command === "git") {
        transport.calls.push([...args]);
        if (args.includes("fetch") && args.includes("--depth=1") && transport.refusal) {
          throw Object.assign(new Error("fixture transport failure"), { status: 128, stderr: transport.refusal });
        }
      }
      let result = actual.execFileSync(command, args, options);
      if (command === "git" && args.includes("ls-remote") && transport.hideHeadSymref) {
        result = result.replace(/^ref: .*\tHEAD\r?\n/m, "");
      }
      if (command === "git" && args.includes("ls-remote") && transport.afterAdvertisement) {
        const advance = transport.afterAdvertisement;
        transport.afterAdvertisement = null;
        advance();
      }
      return result;
    },
  };
});

const homes: string[] = [];
afterEach(() => {
  transport.refusal = null;
  transport.hideHeadSymref = false;
  transport.afterAdvertisement = null;
  transport.calls = [];
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(root: string, message: string) {
  git(root, "add", ".");
  git(root, "-c", "user.name=Context Test", "-c", "user.email=context@example.invalid", "commit", "-m", message);
}
function fixture(format = "sha1") {
  const home = mkdtempSync(join(tmpdir(), "openrig-context-shallow-")); homes.push(home);
  const upstream = join(home, "upstream"); mkdirSync(upstream);
  git(upstream, "init", `--object-format=${format}`, "-b", "main");
  mkdirSync(join(upstream, "registry", "views"), { recursive: true });
  writeFileSync(join(upstream, "registry", "views", "old-diagram.json"), JSON.stringify({ diagram: "historical-only".repeat(10_000) }));
  writeFileSync(join(upstream, "manifest.yaml"), "name: guide\nversion: 1\ntaxonomy: world\nfiles:\n  - path: guide.md\n    role: reference\n");
  writeFileSync(join(upstream, "guide.md"), "Current guide\n"); commit(upstream, "catalog before move");
  const old = git(upstream, "rev-parse", "HEAD");
  const oldBlob = git(upstream, "rev-parse", "HEAD:registry/views/old-diagram.json");
  git(upstream, "tag", "before-move");
  rmSync(join(upstream, "registry"), { recursive: true }); commit(upstream, "catalog moved");
  return { home, upstream, old, oldBlob, head: git(upstream, "rev-parse", "HEAD"), root: join(home, "context") };
}

describe("Git context initial download", () => {
  it("fetches only the advertised commit, without deleted catalog objects or tags", () => {
    const f = fixture();
    const added = addGitContext(f.upstream, {}, f.root);
    expect(added.selected.revision).toBe(f.head);
    expect(git(added.selected.checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(added.selected.checkout, "rev-list", "--count", "HEAD")).toBe("1");
    expect(() => git(added.selected.checkout, "cat-file", "-e", f.old)).toThrow();
    expect(() => git(added.selected.checkout, "cat-file", "-e", f.oldBlob)).toThrow();
    expect(git(added.selected.checkout, "tag", "--list")).toBe("");
    expect(existsSync(join(added.selected.checkout, "registry"))).toBe(false);
    expect(inspectGitContext(added.installedAt).checkout).toMatchObject({ branch: "main", upstream: "origin/main" });
    expect(transport.calls.filter(a => a.includes("fetch"))).toHaveLength(1);
    expect(transport.calls.find(a => a.includes("fetch"))).toContain(f.head);
  });

  it("pins the advertised commit when the branch moves before fetching, then retains ordinary update", () => {
    const f = fixture();
    transport.afterAdvertisement = () => { writeFileSync(join(f.upstream, "guide.md"), "Next guide\n"); commit(f.upstream, "next"); };
    const added = addGitContext(f.upstream, {}, f.root);
    expect(git(f.upstream, "rev-parse", "HEAD")).not.toBe(f.head);
    expect(added.selected.revision).toBe(f.head);
    const updated = updateGitContext(added.installedAt);
    expect(updated.served.revision).toBe(git(f.upstream, "rev-parse", "HEAD"));
  });

  it.each([
    "fatal: dumb http transport does not support shallow capabilities",
    "fatal: Server does not support shallow clients",
    "fatal: Server does not support shallow requests",
  ])("announces a full-clone fallback only for a shallow refusal: %s", (refusal) => {
    const f = fixture(); transport.refusal = refusal;
    transport.hideHeadSymref = refusal.includes("dumb http");
    transport.afterAdvertisement = () => { writeFileSync(join(f.upstream, "guide.md"), "Later guide\n"); commit(f.upstream, "later"); };
    const warnings: string[] = [];
    const added = addGitContext(f.upstream, { onWarning: (message) => {
      expect(transport.calls.some(a => a.includes("clone"))).toBe(false);
      warnings.push(message);
    } }, f.root);
    expect(added).toHaveProperty("warning", expect.stringMatching(/shallow.*full clone/i));
    expect(warnings).toEqual([added.warning]);
    expect(added.selected.revision).toBe(f.head);
    expect(git(added.selected.checkout, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(added.selected.checkout, "cat-file", "-t", f.oldBlob)).toBe("blob");
    expect(transport.calls.filter(a => a.includes("clone"))).toHaveLength(1);
    expect(inspectGitContext(added.installedAt).checkout).toMatchObject({ upstream: "origin/main" });
  });

  it("does not retry an ordinary fetch failure with a full clone or expose its stderr", () => {
    const f = fixture(); transport.refusal = "fatal: Authentication failed for https://user:private-value@example.invalid/";
    let failure: unknown;
    try { addGitContext(f.upstream, {}, f.root); } catch (err) { failure = err; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/git fetch failed/);
    expect((failure as Error).message).not.toContain("private-value");
    expect(transport.calls.some(a => a.includes("clone"))).toBe(false);
    expect(existsSync(join(f.root, "guide"))).toBe(false);
  });

  it("leaves an explicitly supplied checkout and its history unchanged", () => {
    const f = fixture(); transport.calls = [];
    const added = addGitContext(f.upstream, { checkout: true }, f.root);
    expect(added.selected.checkout).toBe(f.upstream);
    expect(git(f.upstream, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(f.upstream, "cat-file", "-t", f.oldBlob)).toBe("blob");
    expect(transport.calls.some(a => a.includes("fetch") || a.includes("clone"))).toBe(false);
  });

  it("preserves the source object format for a SHA-256 repository", () => {
    const f = fixture("sha256");
    const added = addGitContext(f.upstream, {}, f.root);
    expect(added.selected.revision).toBe(f.head);
    expect(git(added.selected.checkout, "rev-parse", "--show-object-format")).toBe("sha256");
    expect(git(added.selected.checkout, "rev-list", "--count", "HEAD")).toBe("1");
  });
});
