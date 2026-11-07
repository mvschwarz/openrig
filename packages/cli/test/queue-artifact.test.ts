import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { CODE_RESULT_KIND, codeResultOf, planItemArtifact } from "../src/queue-artifact.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://selected-daemon:7433"),
}));

const BASE = "a".repeat(40);
const REVISION = "b".repeat(40);
const manifest = (fields: Record<string, unknown>) => ({ content: JSON.stringify({ kind: CODE_RESULT_KIND, repo: "/work/app", base: BASE, revision: REVISION, ...fields }) });

describe("a code result in an item's artifact", () => {
  it("is parsed only from a whole manifest of its kind whose base and revision are full commit ids", () => {
    expect(codeResultOf(manifest({ paths: ["src/a.ts"], branch: "feature/x", fetch: { remote: "https://example.test/app.git", ref: "feature/x" } }))).toEqual({ codeResult: {
      repo: "/work/app", base: BASE, revision: REVISION, paths: ["src/a.ts"], branch: "feature/x", fetch: { remote: "https://example.test/app.git", ref: "feature/x" },
    } });
    // SHA-256 repositories, and no paths: diff everything between the pair.
    expect(codeResultOf(manifest({ base: "c".repeat(64), revision: "d".repeat(64) }))).toEqual({ codeResult: { repo: "/work/app", base: "c".repeat(64), revision: "d".repeat(64), paths: [] } });
  });

  it("says why a manifest of the kind isn't exact, and never turns a branch or short id into a revision", () => {
    for (const [fields, why] of [
      [{ revision: "feature/x" }, "revision must be a full commit id"],
      [{ base: "abc1234" }, "base must be a full commit id"],
      [{ base: BASE.toUpperCase() }, "base must be a full commit id"],
      [{ repo: " " }, "repo must name the repository"],
      [{ paths: ["src/a.ts", ""] }, "paths must be a list"],
      [{ fetch: { remote: "origin" } }, "fetch must name a remote and a ref"],
    ] as const) {
      const parsed = codeResultOf(manifest(fields));
      expect(parsed, JSON.stringify(fields)).toMatchObject({ codeResultIssue: expect.stringContaining(why) });
    }
  });

  it("leaves every other file as it was: not this kind, not JSON, binary or cut", () => {
    expect(codeResultOf({ content: JSON.stringify({ kind: "something-else", base: BASE, revision: REVISION, repo: "/r" }) })).toBeNull();
    expect(codeResultOf({ content: "# A report\nNot JSON." })).toBeNull();
    expect(codeResultOf({ ...manifest({}), binary: true })).toBeNull();
    expect(codeResultOf({ ...manifest({}), truncated: true })).toBeNull();
  });

  it("reads an item's evidenceRef only from a shared root, with the reasons rig_artifact_read gives", () => {
    const roots = [{ name: "proof", path: "/shared/proof" }];
    expect(planItemArtifact("/shared/proof/run/result.json", roots)).toEqual({ read: { root: "proof", path: "run/result.json" } });
    expect(planItemArtifact("run/result.json", roots, "proof")).toEqual({ read: { root: "proof", path: "run/result.json" } });
    expect(planItemArtifact(null, roots)).toEqual({ unavailable: "This item names no artifact: it has no evidenceRef." });
    expect(planItemArtifact("https://example.test/pull/1", roots)).toMatchObject({ unavailable: expect.stringContaining("is a link") });
    expect(planItemArtifact("/shared/proof/a.md", [])).toMatchObject({ unavailable: expect.stringContaining("shares no roots") });
    expect(planItemArtifact("run/result.json", roots)).toMatchObject({ unavailable: expect.stringContaining("relative path") });
    expect(planItemArtifact("/elsewhere/a.md", roots)).toMatchObject({ unavailable: expect.stringContaining("outside every shared root") });
  });
});

describe("rig queue artifact", () => {
  const id = "qitem-20261107-result";
  let output: string[];
  let errors: string[];
  beforeEach(() => {
    output = []; errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    process.exitCode = undefined;
  });
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  function deps(evidenceRef: string | null, content: string): { deps: QueueDeps; paths: string[] } {
    const paths: string[] = [];
    const replies: Record<string, unknown> = {
      [`/api/queue/${id}`]: { qitemId: id, state: "done", evidenceRef },
      "/api/files/roots": { roots: [{ name: "proof", path: "/shared/proof" }] },
      "/api/files/read?root=proof&path=run%2Fresult.json": { root: "proof", path: "run/result.json", content, size: content.length, mtime: "2026-11-07T09:50:00.000Z" },
    };
    const client = {
      baseUrl: "http://selected-daemon:7433",
      get: vi.fn(async (path: string) => { paths.push(path); return path in replies ? { status: 200, data: replies[path] } : { status: 404, data: { error: "not_found" } }; }),
      post: vi.fn(),
    };
    return { paths, deps: { lifecycleDeps: {} as QueueDeps["lifecycleDeps"], clientFactory: () => client as unknown as ReturnType<QueueDeps["clientFactory"]> } };
  }

  it("prints the item's file with its code result, for a client that calls the CLI", async () => {
    const content = manifest({ paths: ["src/a.ts"] }).content;
    const { deps: d, paths } = deps("/shared/proof/run/result.json", content);
    await queueCommand(d).parseAsync(["node", "rig", "artifact", id, "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(output.join(""))).toEqual({ available: true, qitemId: id, root: "proof", path: "run/result.json", size: content.length,
      mtime: "2026-11-07T09:50:00.000Z", binary: false, text: content, truncated: false,
      codeResult: { repo: "/work/app", base: BASE, revision: REVISION, paths: ["src/a.ts"] } });
    // Read through the daemon's shared roots only.
    expect(paths).toEqual([`/api/queue/${id}`, "/api/files/roots", "/api/files/read?root=proof&path=run%2Fresult.json"]);

    output = []; errors = [];
    await queueCommand(d).parseAsync(["node", "rig", "artifact", id]);
    expect(output.join("")).toBe(content);
    expect(errors.join("\n")).toContain(`code result: /work/app ${BASE}..${REVISION} (1 paths)`);
  });

  it("says why there's no file to read, and exits 1", async () => {
    const { deps: d, paths } = deps("https://example.test/pull/1", "");
    await queueCommand(d).parseAsync(["node", "rig", "artifact", id, "--json"]);
    expect(JSON.parse(output.join(""))).toMatchObject({ available: false, qitemId: id, evidenceRef: "https://example.test/pull/1", roots: ["proof"],
      reason: expect.stringContaining("is a link") });
    expect(process.exitCode).toBe(1);
    expect(paths).not.toContain("/api/files/read?root=proof&path=run%2Fresult.json");
  });
});
