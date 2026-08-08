import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";

const COMMAND_MODULE = ["../src/commands", "compaction-control.js"].join("/");

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface TestDeps {
  lifecycleDeps: Record<string, never>;
  clientFactory: () => {
    get(path: string): Promise<{ status: number; data: unknown }>;
    post(path: string, body: unknown): Promise<{ status: number; data: unknown }>;
  };
}

type CommandFactory = (deps: TestDeps) => Command;

async function loadCommand(): Promise<CommandFactory> {
  let loaded: { compactionControlCommand?: CommandFactory } | null = null;
  try {
    loaded = await import(/* @vite-ignore */ COMMAND_MODULE);
  } catch {
    // Assertion below keeps the RED feature-shaped instead of surfacing a loader error.
  }
  expect(loaded, "compaction-control command module must exist").not.toBeNull();
  expect(loaded?.compactionControlCommand).toBeTypeOf("function");
  return loaded!.compactionControlCommand!;
}

function makeDeps() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const deps: TestDeps = {
    lifecycleDeps: {},
    clientFactory: () => ({
      get: vi.fn(async (path: string) => {
        calls.push({ method: "GET", path });
        return {
          status: 200,
          data: {
            ok: true,
            decisions: [{
              decisionId: "hold-1",
              sessionName: "claude-seat@rig",
              direction: "hold",
              lastObservedAt: "2026-08-08T18:00:30.000Z",
              lastObservedOutcome: "human_hold",
            }],
          },
        };
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        calls.push({ method: "POST", path, body });
        return { status: path.endsWith("/clear") ? 200 : 201, data: { ok: true, decisionId: "decision-1" } };
      }),
    }),
  };
  return { calls, deps };
}

describe("rig compaction-control", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it("is registered as one grouped command with hold, authorize, list, and clear", () => {
    const program = createProgram({ compactionControlDeps: makeDeps().deps } as never);
    const command = program.commands.find((candidate) => candidate.name() === "compaction-control");
    expect(command).toBeDefined();
    expect(command!.commands.map((child) => child.name()).sort()).toEqual([
      "authorize",
      "clear",
      "hold",
      "list",
    ]);
  });

  it("hold posts the target and required human reason without a body actor", async () => {
    const factory = await loadCommand();
    const { calls, deps } = makeDeps();
    const command = factory(deps);
    await command.parseAsync([
      "node", "rig", "hold", "claude-seat@rig",
      "--reason", "finish the atomic action",
      "--json",
    ]);
    expect(calls).toEqual([{
      method: "POST",
      path: "/api/compaction/control",
      body: {
        session: "claude-seat@rig",
        direction: "hold",
        reason: "finish the atomic action",
      },
    }]);
  });

  it("authorize posts exactly one named lift and no caller-controlled expiry", async () => {
    const factory = await loadCommand();
    const { calls, deps } = makeDeps();
    const command = factory(deps);
    await command.parseAsync([
      "node", "rig", "authorize", "claude-seat@rig",
      "--automatic-reason", "disabled",
      "--reason", "allow one attempt",
      "--json",
    ]);
    expect(calls).toEqual([{
      method: "POST",
      path: "/api/compaction/control",
      body: {
        session: "claude-seat@rig",
        direction: "authorize",
        automaticReason: "disabled",
        reason: "allow one attempt",
      },
    }]);
  });

  it("list uses the scoped read route and renders durable hold observation", async () => {
    const factory = await loadCommand();
    const { calls, deps } = makeDeps();
    const command = factory(deps);
    await command.parseAsync([
      "node", "rig", "list", "--session", "claude-seat@rig", "--json",
    ]);
    expect(calls).toEqual([{
      method: "GET",
      path: "/api/compaction/control?session=claude-seat%40rig",
    }]);
    expect(JSON.parse(logs.join(""))).toMatchObject({
      decisions: [{
        decisionId: "hold-1",
        lastObservedAt: "2026-08-08T18:00:30.000Z",
        lastObservedOutcome: "human_hold",
      }],
    });
  });

  it("human list output exposes decision identity and durable observation fields", async () => {
    const factory = await loadCommand();
    const { deps } = makeDeps();
    const command = factory(deps);
    await command.parseAsync([
      "node", "rig", "list", "--session", "claude-seat@rig",
    ]);
    const rendered = logs.join("\n");
    expect(rendered).toContain("hold-1");
    expect(rendered).toContain("claude-seat@rig");
    expect(rendered).toContain("2026-08-08T18:00:30.000Z");
    expect(rendered).toContain("human_hold");
  });

  it("clear records a human reason through the decision-specific route", async () => {
    const factory = await loadCommand();
    const { calls, deps } = makeDeps();
    const command = factory(deps);
    await command.parseAsync([
      "node", "rig", "clear", "hold-1", "--reason", "atomic action completed", "--json",
    ]);
    expect(calls).toEqual([{
      method: "POST",
      path: "/api/compaction/control/hold-1/clear",
      body: { reason: "atomic action completed" },
    }]);
  });
});
