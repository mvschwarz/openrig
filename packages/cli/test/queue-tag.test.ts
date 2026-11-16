import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

// `rig queue tag`: what it sends, and what the person reads back.
vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

function makeDeps(response: { status: number; data: unknown }) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const deps = {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: vi.fn(async (urlPath: string, body: unknown) => { posts.push({ path: urlPath, body }); return response; }),
      get: vi.fn(async () => ({ status: 200, data: {} })),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  } as QueueDeps;
  return { deps, posts };
}

describe("rig queue tag", () => {
  let out: string[];
  let errors: string[];
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "desk@rig");
    out = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });
  const run = (deps: QueueDeps, ...args: string[]) => createProgram({ queueDeps: deps }).parseAsync(["node", "rig", "queue", "tag", ...args]);

  it("sends each --add exactly, and says which tags were added", async () => {
    const { deps, posts } = makeDeps({ status: 200, data: { qitemId: "qitem-1", added: ["pr-3279", "ref:a,b"] } });
    await run(deps, "qitem-1", "--add", "pr-3279", "--add", "ref:a,b");
    expect(posts).toEqual([{ path: "/api/queue/qitem-1/tags", body: { add: ["pr-3279", "ref:a,b"] } }]);
    expect(out).toEqual(["Added to qitem-1: pr-3279, ref:a,b"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("says nothing was added when the row already has every tag", async () => {
    const { deps } = makeDeps({ status: 200, data: { qitemId: "qitem-1", added: [] } });
    await run(deps, "qitem-1", "--add", "pr-3279");
    expect(out).toEqual(["Nothing added: qitem-1 already has pr-3279"]);
  });

  it("fails with the daemon's error when the row isn't there", async () => {
    const { deps } = makeDeps({ status: 404, data: { error: "qitem_not_found", message: "qitem qitem-9 not found" } });
    await run(deps, "qitem-9", "--add", "pr-1");
    expect(process.exitCode).toBe(1);
    expect([...out, ...errors].join("\n")).toContain("qitem_not_found");
  });
});
