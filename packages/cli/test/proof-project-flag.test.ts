// #132 — rig proof show/judge carry a catalog project to the daemon (--project or a <project>: prefix).
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
let readExtra: Record<string, unknown> = {};
vi.mock("../src/client.js", () => ({
  DaemonClient: class {
    async get(url: string) {
      calls.push({ method: "GET", url });
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
beforeEach(() => { calls.length = 0; readExtra = {}; vi.spyOn(console, "log").mockImplementation(() => {}); });

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
