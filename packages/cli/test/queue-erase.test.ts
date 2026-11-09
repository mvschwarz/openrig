import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

// `rig queue erase`: the file it reads, the request it sends, and what it refuses before sending anything.
vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

function makeDeps(response: { status: number; data: unknown } = { status: 200, data: { ok: true } }) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const deps = {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: vi.fn(async (urlPath: string, body: unknown) => {
        posts.push({ path: urlPath, body });
        return response;
      }),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  } as QueueDeps;
  return { deps, posts };
}

describe("rig queue erase", () => {
  let dir: string;
  let errors: string[];
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "ops-admin@n-ops");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-erase-"));
    errors = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });
  const run = (deps: QueueDeps, ...args: string[]) => createProgram({ queueDeps: deps }).parseAsync(["node", "rig", "queue", "erase", ...args]);

  it("reads a members file (one per line, comments skipped) and sends a dry run unless --apply", async () => {
    const file = path.join(dir, "members.txt");
    fs.writeFileSync(file, "# account n-acct\na-one@n-acct\n\n  b-two@n-acct  \n");
    const { deps, posts } = makeDeps();
    await run(deps, "--members", file);
    await run(deps, "--members", file, "--apply");
    expect(posts).toEqual([
      { path: "/api/queue/erase", body: { apply: false, members: ["a-one@n-acct", "b-two@n-acct"] } },
      { path: "/api/queue/erase", body: { apply: true, members: ["a-one@n-acct", "b-two@n-acct"] } },
    ]);
  });

  it("reads ids as a JSON array and passes the action", async () => {
    const file = path.join(dir, "ids.json");
    fs.writeFileSync(file, JSON.stringify(["qitem-1", "qitem-2"]));
    const { deps, posts } = makeDeps();
    await run(deps, "--ids", file, "--action", "scrub", "--apply");
    expect(posts).toEqual([{ path: "/api/queue/erase", body: { apply: true, ids: ["qitem-1", "qitem-2"], action: "scrub" } }]);
  });

  it("passes the account rig with the members, and a ledger of report entries as given", async () => {
    const members = path.join(dir, "members.json");
    fs.writeFileSync(members, JSON.stringify(["a-one@n-acct"]));
    const ledger = path.join(dir, "ledger.json");
    const entries = [{ qitemId: "qitem-1", action: "scrub", state: "done" }, "qitem-2"];
    fs.writeFileSync(ledger, JSON.stringify(entries));
    const { deps, posts } = makeDeps();
    await run(deps, "--members", members, "--rig", "rig-acct-id", "--apply");
    await run(deps, "--ids", ledger, "--apply");
    expect(posts).toEqual([
      { path: "/api/queue/erase", body: { apply: true, members: ["a-one@n-acct"], rig: "rig-acct-id" } },
      { path: "/api/queue/erase", body: { apply: true, ids: entries } },
    ]);
  });

  it("reads an erasure ledger's JSON lines as given: entries that keep their action and batch, and commit lines", async () => {
    const ledger = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(ledger, '{"qitemId":"qitem-1","action":"scrub","reason":"retention-content","erasedAt":"t","batch":"b1"}\n{"batch":"b1","committed":true,"at":"t"}\n# a comment\n{"qitemId":"qitem-2","action":"delete"}\n');
    const { deps, posts } = makeDeps();
    await run(deps, "--ids", ledger, "--apply");
    expect(posts).toEqual([{ path: "/api/queue/erase", body: { apply: true, ids: [
      { qitemId: "qitem-1", action: "scrub", reason: "retention-content", erasedAt: "t", batch: "b1" }, { batch: "b1", committed: true, at: "t" },
      { qitemId: "qitem-2", action: "delete" },
    ] } }]);
    fs.writeFileSync(ledger, '{"qitemId": broken\n');
    process.exitCode = undefined;
    await run(deps, "--ids", ledger, "--apply");
    expect(process.exitCode).toBe(1);
    expect(posts).toHaveLength(1);
  });

  it("sends nothing when its file can't be read, or when there's no one to record as erasing", async () => {
    const { deps, posts } = makeDeps();
    await run(deps, "--members", path.join(dir, "missing.txt"));
    expect(process.exitCode).toBe(1);
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    process.exitCode = undefined;
    await run(deps, "--routine");
    expect(process.exitCode).toBe(1);
    expect(posts).toEqual([]);
    expect(errors.join("\n")).toMatch(/Nothing was erased/);
    await run(deps, "--routine", "--actor", "erase-runner@n-ops");
    expect(posts).toEqual([{ path: "/api/queue/erase", body: { apply: false, routine: true, actorSession: "erase-runner@n-ops" } }]);
  });

  it("a daemon refusal exits nonzero", async () => {
    const { deps } = makeDeps({ status: 400, data: { error: "erase_scope_required", message: "Name one scope" } });
    await run(deps);
    expect(process.exitCode).toBe(1);
  });
});
