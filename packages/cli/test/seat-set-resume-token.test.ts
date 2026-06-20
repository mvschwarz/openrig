// OPR.0.4.0.22 FR-1 CLI — rig seat set-resume-token. Token is read from STDIN
// only (never argv), carried to the authed route, and never echoed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { seatCommand, type SeatDeps } from "../src/commands/seat.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface PostCall { path: string; body: unknown; options: unknown; }

function makeDeps(opts: {
  stdin: string;
  response?: { status: number; data: Record<string, unknown> };
  postCalls: PostCall[];
}): SeatDeps & { readStdin?: () => Promise<string> } {
  const response = opts.response ?? { status: 200, data: { ok: true, resumeType: "claude_id", provenance: "operator", redacted: true } };
  return {
    lifecycleDeps: {} as SeatDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: vi.fn(async (path: string, body: unknown, options: unknown) => {
        opts.postCalls.push({ path, body, options });
        return response;
      }),
    }) as unknown as ReturnType<SeatDeps["clientFactory"]>,
    readStdin: async () => opts.stdin,
  };
}

describe("rig seat set-resume-token", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("reads the token from stdin, posts it in the body with auth headers, and never echoes it", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({ stdin: "claude-stdin-tok-789\n", postCalls });
    await seatCommand(deps).parseAsync(["node", "rig", "set-resume-token", "dev-impl@my-rig", "--token-stdin", "--reason", "founder re-authed"]);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.path).toBe("/api/sessions/dev-impl%40my-rig/resume-token");
    expect(postCalls[0]!.body).toEqual({ token: "claude-stdin-tok-789", reason: "founder re-authed" });
    // Auth headers were passed (terminalAuthHeaders()).
    expect(postCalls[0]!.options).toHaveProperty("headers");
    // The token never appears in stdout.
    expect(logs.join("\n")).not.toContain("claude-stdin-tok-789");
    expect(logs.join("\n")).toContain("Token redacted");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses without --token-stdin (no positional/argv token path) and does NOT call the daemon", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({ stdin: "unused", postCalls });
    await seatCommand(deps).parseAsync(["node", "rig", "set-resume-token", "dev-impl@my-rig", "--reason", "x"]);
    expect(process.exitCode).toBe(2);
    expect(postCalls.length).toBe(0);
    expect(errors.join(" ")).toMatch(/--token-stdin/);
  });

  it("errors when stdin is empty", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({ stdin: "   \n", postCalls });
    await seatCommand(deps).parseAsync(["node", "rig", "set-resume-token", "dev-impl@my-rig", "--token-stdin", "--reason", "x"]);
    expect(process.exitCode).toBe(2);
    expect(postCalls.length).toBe(0);
  });

  it("surfaces a daemon rejection (422) without echoing the token", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({
      stdin: "bad tok",
      response: { status: 422, data: { error: "invalid_token", message: "Resume token contains disallowed characters (allowed: letters, digits, '.', '_', '-')." } },
      postCalls,
    });
    await seatCommand(deps).parseAsync(["node", "rig", "set-resume-token", "dev-impl@my-rig", "--token-stdin", "--reason", "x"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("disallowed characters");
    expect(errors.join("\n")).not.toContain("bad tok");
  });
});
