// A busy daemon now gets the real request, so a write's request can time out where the old precheck
// refused before sending. A command that catches its own errors must still say what a timeout means:
// the outcome is unknown, so check the effect before any retry. The request is made once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonTimeoutError } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: false, reason: "unresponsive", host: "127.0.0.1", port: 7433 })),
  };
});

const { contextCommand } = await import("../src/commands/context.js");
const { agentImageCommand } = await import("../src/commands/agent-image.js");
const { forkCommand } = await import("../src/commands/fork.js");

describe("a write that times out against a busy daemon", () => {
  let stderr: string[];
  let dir: string;

  beforeEach(() => {
    stderr = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "busy-write-"));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.join(" ")); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const timeout = (route: string) => new DaemonTimeoutError(`Request to ${route} timed out after 5000ms`);

  it("rig context compose says the outcome is unknown and to check before any retry", async () => {
    const source = path.join(dir, "a.md");
    fs.writeFileSync(source, "x\n");
    const post = vi.fn(async () => { throw timeout("/api/context-packs/library/compose"); });
    const cmd = contextCommand({ lifecycleDeps: {} as never, clientFactory: (() => ({ post })) as never });
    await cmd.parseAsync(["node", "context", "compose", "--out", "packs/x", "--from", source]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(stderr.join("\n")).toContain("outcome is UNKNOWN");
    expect(stderr.join("\n")).toContain("before any retry");
    expect(process.exitCode).toBe(1);
  });

  it("rig agent-image delete says the outcome is unknown and to check before any retry", async () => {
    const del = vi.fn(async () => { throw timeout("/api/agent-images/library/agent-image:abc"); });
    const get = vi.fn(async () => ({ status: 200, data: { id: "agent-image:abc", name: "abc" } }));
    const cmd = agentImageCommand({ lifecycleDeps: {} as never, clientFactory: (() => ({ get, delete: del })) as never });
    await cmd.parseAsync(["node", "agent-image", "delete", "agent-image:abc"]);
    expect(del).toHaveBeenCalledTimes(1);
    expect(stderr.join("\n")).toContain("outcome is UNKNOWN");
    expect(stderr.join("\n")).toContain("before any retry");
    expect(process.exitCode).toBe(1);
  });

  it("rig fork says the outcome is unknown and to check before any retry", async () => {
    const post = vi.fn(async () => { throw timeout("/api/agent-images/fork"); });
    const cmd = forkCommand({ lifecycleDeps: {} as never, clientFactory: (() => ({ post })) as never });
    await cmd.parseAsync(["node", "fork", "dev-impl@r", "--rig", "r", "--pod", "dev", "--member", "dev-impl-2"]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(stderr.join("\n")).toContain("outcome is UNKNOWN");
    expect(stderr.join("\n")).toContain("before any retry");
    expect(process.exitCode).toBe(1);
  });
});
