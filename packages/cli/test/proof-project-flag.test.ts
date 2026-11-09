// #132 — rig proof show/judge carry a catalog project to the daemon (--project or a <project>: prefix).
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
let readExtra: Record<string, unknown> = {};
let readFailure: { status: number; data: Record<string, unknown> } | null = null;
vi.mock("../src/client.js", () => ({
  DaemonClient: class {
    async get(url: string) {
      calls.push({ method: "GET", url });
      if (readFailure) return readFailure;
      return { status: 200, data: { items: [{ id: "i1", text: "Prove it.", index: 1, revision: "r1", judgment: null }], ...readExtra } };
    }
    async post(url: string, body: Record<string, unknown>) {
      calls.push({ method: "POST", url, body });
      return { status: 201, data: { ok: true } };
    }
  },
}));
const { proofCommand } = await import("../src/commands/proof.js");

const run = (args: string[]) => proofCommand().parseAsync(["node", "proof", ...args]);
beforeEach(() => { calls.length = 0; readExtra = {}; readFailure = null; vi.spyOn(console, "log").mockImplementation(() => {}); });

describe("rig proof --project (#132)", () => {
  it("show passes --project and the scope as query parameters", async () => {
    await run(["show", "m0/slices/01-t001", "--project", "alpha"]);
    expect(calls[0]!.url).toBe("/api/proof?project=alpha&scope=m0%2Fslices%2F01-t001");
  });
  it("show without a scope reads that project's readiness; without --project the request is unchanged", async () => {
    await run(["show", "--project", "beta"]);
    await run(["show", "m0/slices/01-t001"]);
    await run(["show"]);
    expect(calls.map(c => c.url)).toEqual(["/api/proof?project=beta", "/api/proof?scope=m0%2Fslices%2F01-t001", "/api/proof"]);
  });
  it("judge forwards --project on the preparation read and the judgment body", async () => {
    await run(["judge", "m0/slices/01-t001#i1", "--project", "alpha", "--verdict", "accept", "--reason", "seen", "--evidence", "proof/e.md"]);
    expect(calls[0]!.url).toBe("/api/proof?project=alpha&scope=m0%2Fslices%2F01-t001&evidence=proof%2Fe.md");
    expect(calls[1]!.body).toMatchObject({ scope: "m0/slices/01-t001", item: "i1", project: "alpha" });
  });
  it("judge passes a <project>: prefixed scope through verbatim and adds no project field", async () => {
    await run(["judge", "alpha:m0/slices/01-t001#i1", "--verdict", "reject", "--reason", "no"]);
    expect(calls[0]!.url).toBe("/api/proof?scope=alpha%3Am0%2Fslices%2F01-t001");
    expect(calls[1]!.body).toMatchObject({ scope: "alpha:m0/slices/01-t001" });
    expect(calls[1]!.body).not.toHaveProperty("project");
  });
  it("judge pins the project root its prepared read returned (projectRoot), and sends none for a workspace read", async () => {
    readExtra = { project: { id: "alpha", root: "/work/alpha" } };
    await run(["judge", "alpha:m0/slices/01-t001#i1", "--verdict", "accept", "--reason", "seen"]);
    expect(calls[1]!.body).toMatchObject({ scope: "alpha:m0/slices/01-t001", projectRoot: "/work/alpha" });
    readExtra = {};
    await run(["judge", "m0/slices/01-t001#i1", "--verdict", "accept", "--reason", "seen"]);
    expect(calls[3]!.body).not.toHaveProperty("projectRoot");
  });
});

describe("O2: a path_escape scope names the routes to another workspace", () => {
  const escape = { status: 400, data: { error: "path_escape", message: "Path escapes /w/missions; paths must stay within the selected workspace" } };
  const shown = async (args: string[]): Promise<string> => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((text: unknown) => { errors.push(String(text)); });
    readFailure = escape;
    await run(args);
    process.exitCode = undefined;
    return errors.join("\n");
  };

  it("without a project, names --project, the <project>: prefix and OPENRIG_URL, not rig scope", async () => {
    const text = await shown(["show", "/other/projects/alpha/missions/m1/slices/01-x"]);
    expect(text).toContain("path_escape: Path escapes /w/missions");
    expect(text).toContain("For a catalog project, pass --project <id> or prefix the scope with <project>:.");
    expect(text).toContain("To use another daemon's workspace, select that daemon with OPENRIG_URL.");
    expect(text).not.toContain("rig scope");
  });

  it("with --project or a <project>: prefix, says the scope is outside that project's tree", async () => {
    for (const args of [["show", "/x/slices/01-x", "--project", "alpha"], ["judge", "alpha:/x/slices/01-x#1", "--verdict", "accept", "--reason", "r"]]) {
      const text = await shown(args);
      expect(text).toContain("The scope is outside that project's missions root");
      expect(text).not.toContain("pass --project");
    }
  });

  it("another daemon error keeps its message without the hint", async () => {
    readFailure = null;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((text: unknown) => { errors.push(String(text)); });
    readFailure = { status: 404, data: { error: "scope_missing", message: "Select an existing mission or slice directory" } };
    await run(["show", "m0/slices/01-t001"]);
    process.exitCode = undefined;
    expect(errors.join("\n")).toBe("scope_missing: Select an existing mission or slice directory");
  });
});
