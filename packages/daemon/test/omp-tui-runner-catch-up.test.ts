import { describe, expect, it } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const SESSION = "omp-tui-worker@rig";
const SESSION_FILE = "/openrig/state/omp/omp-tui-worker@rig/sessions/2026_1.jsonl";
const HEADER = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-10-21T12:00:00.000Z", cwd: "/work" });
const USAGE_ENTRY = {
  type: "message",
  id: "entry-newest",
  parentId: null,
  timestamp: "2026-10-21T12:00:01.000Z",
  message: {
    role: "assistant",
    provider: "openrouter",
    model: "test-model",
    usage: {
      input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason: "stop",
  },
};

function runner(runtime: "omp" | "pi" = "pi", bridgeUi = false) {
  const mirror: string[] = [];
  const sidecars: PiRunnerState[] = [];
  const usageFacts: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  const io: RunnerIo = {
    sendRpc: (request) => { requests.push(request); },
    mirrorLine: (line) => { mirror.push(line); },
    mirrorAppend: () => {},
    postActivity: () => {},
    writeSidecar: (state) => { sidecars.push(state); },
    postUsageFacts: async (payload) => { usageFacts.push(payload); return true; },
    readFirstLine: () => HEADER,
    sessionFileExists: () => true,
    now: () => "2026-10-21T12:00:00.000Z",
  };
  const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1", launchId: "attempt-1" }, {
    catchUpSince: "entry-old", usageFacts: true, runtime, bridgeUi,
  });
  core.start();
  core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state",
    data: { sessionFile: SESSION_FILE, sessionId: "session-1" },
  }));
  return { core, mirror, sidecars, usageFacts, requests };
}

function catchUp(core: RunnerCore, data: Record<string, unknown>): void {
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-catch-up", data }));
}

describe("OMP TUI runner catch-up replies", () => {
  it("warns on truncated catch-up and advances only to last enumerated entry", () => {
    const { core, mirror, sidecars } = runner();
    catchUp(core, { entries: [{ id: "entry-new" }, { id: "entry-newest" }], newestId: "entry-latest", truncated: true });

    expect(mirror).toContain("[omp-runner] the bridge reply did not enumerate every entry after the cursor; the cursor stayed at the last enumerated entry");
    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "entry-newest" });
  });
});

describe("OMP TUI runner catch-up replies", () => {
  it("rejects catch-up replies without an entries array", () => {
    for (const data of [{}, { entries: "not-an-array" }]) {
      const { core, mirror, sidecars, usageFacts } = runner();
      const sidecarCount = sidecars.length;
      catchUp(core, data);
      expect(mirror).toContain("[omp-runner] the bridge reply carried no entries; catch-up could not be verified");
      expect(sidecars).toHaveLength(sidecarCount);
      expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "entry-old" });
      expect(usageFacts).toEqual([]);
    }
  });


  it("complete reply advances cursor to last enumerated entry", () => {
    const { core, sidecars } = runner();
    catchUp(core, { entries: [{ id: "entry-mid" }, { id: "entry-last" }], newestId: "entry-latest", truncated: false });
    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "entry-last" });
  });

  it("native refresh carries current cursor; Pi RPC refresh omits since", () => {
    const native = runner("omp", true);
    native.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(native.requests.at(-1)).toEqual({ type: "get_entries", since: "entry-old", id: "pi-runner-cursor-refresh" });
    const pi = runner("pi");
    pi.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(pi.requests.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
  });
  it("reports unavailable session entries without advancing cursor or reporting usage", () => {
    const { core, mirror, sidecars, usageFacts } = runner();
    const sidecarCount = sidecars.length;
    catchUp(core, { entries: [USAGE_ENTRY], truncated: false, available: false });

    expect(mirror).toContain("[omp-runner] could not read the session entries from the bridge; catch-up did not complete");
    expect(sidecars).toHaveLength(sidecarCount);
    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "entry-old" });
    expect(usageFacts).toEqual([]);
  });

  it("treats a reply without available as readable, advances cursor, and reports usage facts", async () => {
    const { core, sidecars, usageFacts } = runner();
    catchUp(core, { entries: [USAGE_ENTRY] });
    await Promise.resolve();

    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "entry-newest" });
    expect(usageFacts).toHaveLength(1);
    expect(usageFacts[0]).toMatchObject({ facts: [expect.objectContaining({ entryId: "entry-newest" })] });
  });

  it("does not move the durable cursor onto a command acknowledgement id", () => {
    const { core, sidecars } = runner();
    core.handlePiLine(JSON.stringify({ type: "command_ack", id: "pi-runner-get-state", success: true }));

    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "entry-old" });
  });
});
