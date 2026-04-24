import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatCommand, analyzeHeartbeat } from "../src/commands/heartbeat.js";

const NOW = new Date("2026-04-24T12:00:00Z");

function writeQueue(root: string, rig: string, pod: string, member: string, body: string): string {
  const dir = join(root, "rigs", rig, "state", pod);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${member}.queue.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

function queue(entries: string[]): string {
  return [
    "---",
    "doc: test queue",
    "---",
    "",
    "# queue",
    "",
    ...entries,
  ].join("\n");
}

function entry(input: {
  id: string;
  state: string;
  tsCreated?: string;
  tsUpdated?: string;
  blockedOn?: string;
  title?: string;
  body: string;
}): string {
  return [
    "---",
    `id: ${input.id}`,
    `ts-created: ${input.tsCreated ?? "2026-04-24T08:00:00Z"}`,
    `ts-updated: ${input.tsUpdated ?? input.tsCreated ?? "2026-04-24T08:00:00Z"}`,
    `state: ${input.state}`,
    `blocked-on: ${input.blockedOn ?? "null"}`,
    "handed-off-to: null",
    "---",
    "",
    `### ${input.title ?? input.id}`,
    "",
    input.body,
  ].join("\n");
}

async function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const exitCode = process.exitCode;
  process.exitCode = originalExitCode;
  return { logs, errors, exitCode };
}

describe("rig heartbeat", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openrig-heartbeat-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("classifies checked-out, proven-active, stalled, unproven, blocked, parked, and done states", () => {
    writeQueue(root, "alpha", "dev", "impl", queue([
      entry({
        id: "checked",
        state: "in-progress",
        tsCreated: "2026-04-24T11:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T11:00:00Z - in-progress (accepted)",
      }),
      entry({
        id: "unproven",
        state: "in-progress",
        tsCreated: "2026-04-24T08:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T08:00:00Z - in-progress (accepted)",
      }),
      entry({
        id: "proven",
        state: "in-progress",
        tsCreated: "2026-04-24T08:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T08:00:00Z - in-progress\n- 2026-04-24T11:30:00Z - in-progress; proof: wrote `openrig-work/artifact.md`",
      }),
      entry({
        id: "stalled",
        state: "in-progress",
        tsCreated: "2026-04-24T06:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T06:00:00Z - in-progress\n- 2026-04-24T09:30:00Z - in-progress; proof: changed `packages/cli/src/commands/heartbeat.ts`",
      }),
      entry({
        id: "not-proof",
        state: "in-progress",
        tsCreated: "2026-04-24T07:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T07:00:00Z - in-progress\n- 2026-04-24T11:30:00Z - in-progress; proof: read the spec carefully",
      }),
      entry({
        id: "blocked",
        state: "blocked",
        blockedOn: "missing credentials",
        body: "**State transitions:**\n- 2026-04-24T09:00:00Z - blocked (missing credentials)",
      }),
      entry({
        id: "parked",
        state: "deferred",
        body: "**State transitions:**\n- 2026-04-24T09:00:00Z - deferred (waiting for review)",
      }),
      entry({
        id: "done",
        state: "done",
        body: "**State transitions:**\n- 2026-04-24T09:00:00Z - done (landed artifact at `out.md`)",
      }),
    ]));

    const result = analyzeHeartbeat({
      sharedDocsRoot: root,
      rig: "alpha",
      now: NOW,
      includeDone: true,
    });
    const byId = new Map(result.items.map((item) => [item.id, item]));

    expect(byId.get("checked")?.executionState).toBe("checked-out");
    expect(byId.get("unproven")?.executionState).toBe("unproven");
    expect(byId.get("proven")?.executionState).toBe("proven-active");
    expect(byId.get("stalled")?.executionState).toBe("stalled");
    expect(byId.get("not-proof")?.executionState).toBe("unproven");
    expect(byId.get("blocked")?.executionState).toBe("blocked");
    expect(byId.get("blocked")?.blockedOn).toBe("missing credentials");
    expect(byId.get("parked")?.executionState).toBe("parked");
    expect(byId.get("done")?.executionState).toBe("done");
    expect(result.summary).toMatchObject({
      total: 8,
      checkedOut: 1,
      provenActive: 1,
      stalled: 1,
      unproven: 2,
      blocked: 1,
      parked: 1,
      done: 1,
    });
  });

  it("JSON output is stable and excludes done items by default", async () => {
    writeQueue(root, "alpha", "dev", "impl", queue([
      entry({
        id: "active",
        state: "in-progress",
        body: "**State transitions:**\n- 2026-04-24T11:00:00Z - in-progress",
      }),
      entry({
        id: "done",
        state: "done",
        body: "**State transitions:**\n- 2026-04-24T11:00:00Z - done",
      }),
    ]));

    const cmd = heartbeatCommand({ sharedDocsRoot: root, now: () => NOW });
    const { logs, exitCode } = await captureLogs(async () => {
      await cmd.parseAsync(["node", "rig", "--rig", "alpha", "--json"]);
    });

    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.windows).toEqual({ firstProofSeconds: 7200, heartbeatSeconds: 7200 });
    expect(parsed.summary.total).toBe(1);
    expect(parsed.summary.done).toBe(0);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      id: "active",
      rig: "alpha",
      owner: "dev.impl",
      session: "dev-impl@alpha",
      executionState: "checked-out",
    });
  });

  it("--include-done includes terminal done items", async () => {
    writeQueue(root, "alpha", "dev", "impl", queue([
      entry({
        id: "done",
        state: "done",
        body: "**State transitions:**\n- 2026-04-24T11:00:00Z - done",
      }),
    ]));

    const cmd = heartbeatCommand({ sharedDocsRoot: root, now: () => NOW });
    const { logs } = await captureLogs(async () => {
      await cmd.parseAsync(["node", "rig", "--rig", "alpha", "--json", "--include-done"]);
    });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.summary.done).toBe(1);
    expect(parsed.items[0].executionState).toBe("done");
  });

  it("does not label pending or unknown queue states as checked out", () => {
    writeQueue(root, "alpha", "dev", "impl", queue([
      entry({
        id: "pending",
        state: "pending",
        tsCreated: "2026-04-24T08:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T08:00:00Z - pending",
      }),
      entry({
        id: "unknown",
        state: "triage",
        tsCreated: "2026-04-24T08:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T08:00:00Z - triage",
      }),
      entry({
        id: "checked",
        state: "in-progress",
        tsCreated: "2026-04-24T11:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T11:00:00Z - in-progress",
      }),
    ]));

    const result = analyzeHeartbeat({
      sharedDocsRoot: root,
      rig: "alpha",
      now: NOW,
    });

    expect(result.items.map((item) => item.id)).toEqual(["checked"]);
    expect(result.items[0]?.executionState).toBe("checked-out");
  });

  it("uses checkout transition then ts-created, not ts-updated churn, for first-proof age", () => {
    writeQueue(root, "alpha", "dev", "impl", queue([
      entry({
        id: "metadata-churn",
        state: "in-progress",
        tsCreated: "2026-04-24T08:00:00Z",
        tsUpdated: "2026-04-24T11:50:00Z",
        body: "No in-progress transition was recorded.",
      }),
    ]));

    const result = analyzeHeartbeat({
      sharedDocsRoot: root,
      rig: "alpha",
      now: NOW,
    });

    expect(result.items[0]?.id).toBe("metadata-churn");
    expect(result.items[0]?.checkoutAt).toBe("2026-04-24T08:00:00Z");
    expect(result.items[0]?.executionState).toBe("unproven");
  });

  it("--nudge sends informational messages only to stalled and unproven owners", async () => {
    writeQueue(root, "alpha", "dev", "impl", queue([
      entry({
        id: "unproven",
        state: "in-progress",
        tsCreated: "2026-04-24T08:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T08:00:00Z - in-progress",
      }),
      entry({
        id: "stalled",
        state: "in-progress",
        tsCreated: "2026-04-24T06:00:00Z",
        body: "**State transitions:**\n- 2026-04-24T06:00:00Z - in-progress\n- 2026-04-24T09:00:00Z - in-progress; proof: wrote `artifact.md`",
      }),
      entry({
        id: "blocked",
        state: "blocked",
        body: "**State transitions:**\n- 2026-04-24T09:00:00Z - blocked",
      }),
    ]));
    const sends: Array<{ session: string; text: string }> = [];
    const cmd = heartbeatCommand({
      sharedDocsRoot: root,
      now: () => NOW,
      send: async (session, text) => {
        sends.push({ session, text });
        return { ok: true, message: "sent" };
      },
    });

    const { logs } = await captureLogs(async () => {
      await cmd.parseAsync(["node", "rig", "--rig", "alpha", "--json", "--nudge"]);
    });

    expect(sends.map((send) => send.session)).toEqual(["dev-impl@alpha", "dev-impl@alpha"]);
    expect(sends.map((send) => send.text).join("\n")).toContain("add a task-specific proof note");
    expect(sends.map((send) => send.text).join("\n")).toContain("If blocked, transition to blocked");
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.nudgeResults).toHaveLength(2);
    expect(parsed.nudgeResults.map((result: { id: string }) => result.id).sort()).toEqual(["stalled", "unproven"]);
  });
});
