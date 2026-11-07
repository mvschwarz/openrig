import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import { probePiRecovery, startPiRecoveryServer } from "../src/adapters/pi-recovery-rpc.js";

const FILE = "/scratch/history.jsonl";

function fixture(runtime: "pi" | "omp") {
  const sendRpc = vi.fn();
  const postActivity = vi.fn(async () => ({ tokenPersisted: true }));
  const io: RunnerIo = { sendRpc, postActivity, writeSidecar: vi.fn(), mirrorLine: vi.fn(), mirrorAppend: vi.fn(),
    sessionFileExists: () => true, now: () => new Date().toISOString() };
  const core = new RunnerCore(io, { sessionName: "worker@demo", nodeId: "worker", launchId: "launch", generation: "generation" }, { runtime });
  core.start();
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true,
    data: { sessionFile: FILE, sessionId: "session" } }));
  postActivity.mockClear(); sendRpc.mockClear();
  const reply = (patch: Record<string, unknown> = {}) => core.handlePiLine(JSON.stringify({
    type: "response", id: sendRpc.mock.lastCall![0].id, command: "get_state", success: true,
    data: { sessionFile: FILE, sessionId: "session" }, ...patch,
  }));
  return { core, sendRpc, postActivity, reply };
}

afterEach(() => vi.useRealTimers());

describe.each(["pi", "omp"] as const)("%s recovery RPC", (runtime) => {
  it("requires a new RPC response and a new daemon identity acknowledgement", async () => {
    const f = fixture(runtime);
    const pending = f.core.verifyRecovery(FILE);
    expect(f.sendRpc).toHaveBeenCalledExactlyOnceWith({ type: "get_state", id: expect.stringMatching(/^recovery-/) });
    expect(f.postActivity).not.toHaveBeenCalled();
    f.reply();
    await expect(pending).resolves.toEqual({ ok: true, sessionFile: FILE, sessionId: "session" });
    expect(f.postActivity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      eventFamily: "session_identity", runtime, sessionName: "worker@demo", generation: "generation", sessionFile: FILE,
    }));
  });

  it("does not use cached readiness when the child is silent", async () => {
    vi.useFakeTimers();
    const f = fixture(runtime);
    const pending = f.core.verifyRecovery(FILE);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "runner_rpc_unavailable" });
    expect(f.postActivity).not.toHaveBeenCalled();
    f.reply();
    expect(f.postActivity).not.toHaveBeenCalled();
  });

  it("does not publish a different session returned by the child", async () => {
    const f = fixture(runtime);
    const pending = f.core.verifyRecovery(FILE);
    f.reply({ data: { sessionFile: "/scratch/other.jsonl", sessionId: "other" } });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "runner_session_mismatch" });
    expect(f.postActivity).not.toHaveBeenCalled();
  });

  it("keeps attention when the daemon does not confirm identity", async () => {
    const f = fixture(runtime);
    f.postActivity.mockResolvedValue({ tokenPersisted: false });
    const pending = f.core.verifyRecovery(FILE);
    f.reply();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "runner_identity_unconfirmed" });
  });

  it("keeps attention raised while the daemon acknowledgement is pending", async () => {
    const f = fixture(runtime);
    let acknowledge!: (reply: { tokenPersisted: boolean }) => void;
    f.postActivity.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const pending = f.core.verifyRecovery(FILE);
    f.reply();
    f.core.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "approval", method: "confirm", title: "Approve?" }));
    acknowledge({ tokenPersisted: true });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "runner_identity_unconfirmed" });
  });

  it("refuses a failed get_state and a child that exits during the probe", async () => {
    const f = fixture(runtime);
    const rejected = f.core.verifyRecovery(FILE);
    f.reply({ success: false, error: "transport down" });
    await expect(rejected).resolves.toMatchObject({ ok: false, code: "runner_rpc_unavailable" });
    const exited = f.core.verifyRecovery(FILE);
    f.core.handlePiExit(1);
    await expect(exited).resolves.toMatchObject({ ok: false, code: "runner_rpc_unavailable" });
    expect(f.sendRpc.mock.calls.every(([command]) => command.type === "get_state")).toBe(true);
  });

  it("exercises the loopback endpoint without typing into the pane", async () => {
    const f = fixture(runtime);
    f.sendRpc.mockImplementation(() => { queueMicrotask(() => f.reply()); });
    const server = await startPiRecoveryServer("launch", (file) => f.core.verifyRecovery(file));
    try {
      await expect(probePiRecovery(server.port, "wrong-launch", FILE)).resolves.toMatchObject({ ok: false, code: "runner_rpc_unavailable" });
      expect(f.sendRpc).not.toHaveBeenCalled();
      await expect(probePiRecovery(server.port, "launch", FILE)).resolves.toEqual({ ok: true, sessionFile: FILE, sessionId: "session" });
    } finally { server.close(); }
  });
});
