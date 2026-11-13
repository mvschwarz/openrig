import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { DaemonClient } from "../src/client.js";

function makeDeps(nodePayload: Record<string, unknown>) {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) =>
      p === STATE_FILE ? JSON.stringify({ pid: 4242, port: 9999, host: "127.0.0.1" }) : null,
    ),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
  const client = {
    get: vi.fn(async (url: string) => {
      if (url.startsWith("/api/ps")) {
        return {
          status: 200,
          data: [{ rigId: "rig-1", rigName: "demo", name: "demo", status: "running", lifecycleState: "running" }],
        };
      }
      if (url.startsWith("/api/rigs/rig-1/nodes")) {
        return { status: 200, data: [nodePayload] };
      }
      return { status: 404, data: { error: "not found" } };
    }),
  } as unknown as DaemonClient;
  return { lifecycleDeps, clientFactory: () => client };
}

async function runPs(args: string[], nodePayload: Record<string, unknown>) {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    const program = new Command();
    program.addCommand(psCommand(makeDeps(nodePayload)));
    await program.parseAsync(["node", "rig", "ps", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, errs, exitCode };
}

describe("rig ps --nodes resumeCommandLabel field projection and compact redaction", () => {
  const node = {
    rigId: "rig-1",
    rigName: "demo",
    logicalId: "dev.codex",
    canonicalSessionName: "dev-codex@demo",
    nodeKind: "agent",
    runtime: "codex",
    sessionStatus: "running",
    startupStatus: "ready",
    restoreOutcome: "n-a",
    lifecycleState: "running",
    tmuxAttachCommand: "tmux attach -t dev-codex@demo",
    resumeCommand: "codex -s workspace-write '-c' 'check_for_update_on_startup=false' resume 'tok-1'",
    resumeCommandLabel: "launched with -s danger-full-access -a never; a resume now uses -s workspace-write",
    resumeType: "codex_id",
    resumeToken: "tok-1",
    latestError: null,
  };

  it("projects resumeCommandLabel alongside resumeCommand when requested via --fields", async () => {
    const { logs, errs, exitCode } = await runPs(
      ["--nodes", "--rig", "demo", "--json", "--fields", "logicalId,resumeCommand,resumeCommandLabel"],
      node,
    );
    expect(exitCode).toBeUndefined();
    expect(errs).toEqual([]);
    const parsed = JSON.parse(logs[0]!) as { entries: Array<Record<string, unknown>> };
    expect(parsed.entries).toEqual([
      {
        logicalId: "dev.codex",
        resumeCommand: node.resumeCommand,
        resumeCommandLabel: node.resumeCommandLabel,
      },
    ]);
  });

  it("redacts both resumeCommand and resumeCommandLabel in compact --nodes --json mode while keeping both in --full", async () => {
    const compactRes = await runPs(["--nodes", "--rig", "demo", "--json"], node);
    const compactRows = JSON.parse(compactRes.logs[0]!) as Array<Record<string, unknown>>;
    expect(compactRows[0]).not.toHaveProperty("resumeCommand");
    expect(compactRows[0]).not.toHaveProperty("resumeCommandLabel");

    const fullRes = await runPs(["--nodes", "--rig", "demo", "--full", "--json"], node);
    const fullRows = JSON.parse(fullRes.logs[0]!) as Array<Record<string, unknown>>;
    expect(fullRows[0]?.resumeCommand).toBe(node.resumeCommand);
    expect(fullRows[0]?.resumeCommandLabel).toBe(node.resumeCommandLabel);
  });
});
