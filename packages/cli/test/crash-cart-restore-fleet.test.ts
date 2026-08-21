// B1 Atom D — `rig crash-cart restore-fleet` drives the ASYNC daemon-side conductor:
// POST kicks the background fleet restore (202 + fleet-attempt id), then the CLI POLLS
// GET /api/crash-cart/restore-fleet/:id until done and renders the FleetRollup. The client
// is injected so the drive is tested without a live daemon; the full flow is door-tested.
import { describe, it, expect, vi } from "vitest";
import { crashCartCommand } from "../src/commands/crash-cart.js";
import type { DaemonClient } from "../src/client.js";

// A mock client: POST returns the kick handle; GET yields `statuses` in order (the last
// repeats). This lets a test assert the CLI POLLS to completion, not reads the kick body.
function pollingClient(statuses: Array<{ status: number; data: unknown }>): { client: DaemonClient; posts: string[]; gets: string[] } {
  const posts: string[] = [];
  const gets: string[] = [];
  let i = 0;
  const client = {
    post: async (path: string) => {
      posts.push(path);
      return { status: 202, data: { fleetAttemptId: "fleet-abc", status: "started" } };
    },
    get: async (path: string) => {
      gets.push(path);
      const s = statuses[Math.min(i, statuses.length - 1)]!;
      i++;
      return s;
    },
  } as unknown as DaemonClient;
  return { client, posts, gets };
}

describe("rig crash-cart restore-fleet (async poll)", () => {
  it("polls the status endpoint to completion, then renders verdict + outcomes + triage", async () => {
    const lines: string[] = [];
    const doneBody = {
      done: true,
      cancelled: false,
      verdict: "mixed",
      rollup: {
        counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 },
        sequence: [
          { rigId: "kernel", outcome: "fully_restored" },
          { rigId: "alpha", outcome: "not_attempted" },
        ],
        attention_required: [{ rigId: "alpha", seat: "dev.guard", need: "codex auth" }],
      },
    };
    // not-done TWICE before done — the CLI must keep polling (never read the kick as the rollup)
    const { client, posts, gets } = pollingClient([
      { status: 200, data: { done: false, cancelled: false, rollup: { counts: {}, sequence: [], attention_required: [] }, verdict: "none_attempted" } },
      { status: 200, data: { done: false, cancelled: false, rollup: { counts: {}, sequence: [], attention_required: [] }, verdict: "none_attempted" } },
      { status: 200, data: doneBody },
    ]);
    const cmd = crashCartCommand({
      emit: async () => ({ state: "up" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () => client,
      sleep: async () => {}, // no real delay in tests
    });
    await cmd.parseAsync(["restore-fleet"], { from: "user" });
    const out = lines.join("\n");
    expect(posts).toEqual(["/api/crash-cart/restore-fleet"]); // kicked ONCE
    expect(gets.length).toBe(3); // polled until done (2 not-done + 1 done)
    expect(out).toContain("Fleet restore: mixed");
    expect(out).toContain("kernel: fully_restored");
    expect(out).toContain("alpha: not_attempted");
    expect(out).toContain("dev.guard — codex auth");
  });

  it("--json emits the raw rollup + verdict after polling to done", async () => {
    const lines: string[] = [];
    const { client } = pollingClient([
      { status: 200, data: { done: true, cancelled: false, verdict: "all_fully_restored", rollup: { counts: {}, sequence: [], attention_required: [] } } },
    ]);
    const cmd = crashCartCommand({
      emit: async () => ({ state: "up" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () => client,
      sleep: async () => {},
    });
    await cmd.parseAsync(["restore-fleet", "--json"], { from: "user" });
    expect(JSON.parse(lines[0]!).verdict).toBe("all_fully_restored");
  });

  it("fail-closed: no client (daemon not up) → exit 1, no output", async () => {
    const lines: string[] = [];
    const cmd = crashCartCommand({
      emit: async () => ({ state: "down" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () => null,
    });
    process.exitCode = 0;
    await cmd.parseAsync(["restore-fleet"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
    process.exitCode = 0;
  });

  it("a thrown client error is caught and reported (r1: the sync action had none)", async () => {
    const lines: string[] = [];
    const throwingClient = { post: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) } as unknown as DaemonClient;
    const cmd = crashCartCommand({
      emit: async () => ({ state: "up" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () => throwingClient,
      sleep: async () => {},
    });
    process.exitCode = 0;
    await cmd.parseAsync(["restore-fleet"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("ECONNREFUSED");
    process.exitCode = 0;
  });
});
