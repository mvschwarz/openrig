import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { seatCommand } from "../src/commands/seat.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const rigId = "01M5FH6C2XEGA4B56J40RF9Q2G";
const nodeId = "01M5FH6ZV4C0S3JW1AGM5YNRQ4";
const snapshotId = "01M5FH6F8XV2FEEQDHCGKF3TFA";
const historySessionId = "01M5FH6EW20ZB9HFA3QWQT577B";

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "fixture.sqlite", startedAt: "2026-10-21T00:00:00Z" }) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
}

describe("rig seat history", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });
  async function run(args: string[], client: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }) {
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "test-terminal-token");
    const deps: StatusDeps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => client as unknown as DaemonClient };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { lines.push(parts.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command(); program.exitOverride(); program.addCommand(seatCommand(deps));
    await program.parseAsync(["node", "rig", "seat", "history", "--rig", rigId, "--node-id", nodeId, "--json", ...args]);
    return lines;
  }

  it("reads the server list with terminal auth and no local filtering", async () => {
    const body = { ok: true, snapshotId, histories: [{ snapshotId, historySessionId, resumeType: "codex_id", tokenState: "unverified" }] };
    const client = { get: vi.fn(async () => ({ status: 200, data: body })), post: vi.fn() };
    const lines = await run([], client);
    expect(client.get).toHaveBeenCalledWith(`/api/startup/${rigId}/nodes/${nodeId}/history`, { headers: { Authorization: "Bearer test-terminal-token" } });
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.parse(lines.join("\n"))).toEqual(body);
  });

  it("sends both exact references back for server validation", async () => {
    const body = { ok: true, snapshotId, history: { historySessionId }, eligibleForAttempt: true, mutated: false };
    const client = { get: vi.fn(), post: vi.fn(async () => ({ status: 200, data: body })) };
    const lines = await run(["--snapshot-id", snapshotId, "--history-session-id", historySessionId], client);
    expect(client.post).toHaveBeenCalledWith(`/api/startup/${rigId}/nodes/${nodeId}/history/validate`,
      { snapshotId, historySessionId }, { headers: { Authorization: "Bearer test-terminal-token" } });
    expect(client.get).not.toHaveBeenCalled();
    expect(JSON.parse(lines.join("\n"))).toEqual(body);
  });

  it("refuses an incomplete reference without a request", async () => {
    const client = { get: vi.fn(), post: vi.fn() };
    await run(["--snapshot-id", snapshotId], client);
    expect(client.get).not.toHaveBeenCalled(); expect(client.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
