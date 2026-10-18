// The real StagingDocker invoker's cleanup paths, with fake processes (no OS processes, no
// signals actually sent). The sh-based tests in staging-docker-invoker.test.ts cover the real
// pipe and group mechanics; these pin two paths those can't reach deterministically:
// - a side that has already CLOSED is never signalled again (its leader is reaped, so its pid
//   and process-group id can belong to an unrelated process by the time a timeout or a parent
//   signal fires);
// - a synchronous throw while setting up a step cleans up the side already started, and the
//   invoker still resolves instead of rejecting.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { makeRealStagingDocker } from "./helpers/staging-docker-invoker.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  constructor(readonly pid: number) {
    super();
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

const CONSUMER_PID = 41001;
const PRODUCER_PID = 41002;

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

/** process.kill stand-in: records every call; a group kill of the consumer closes it, as SIGKILL would. */
function fakeKill(consumer: FakeChild) {
  return vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    if (pid === -CONSUMER_PID) setImmediate(() => consumer.close(null, "SIGKILL"));
    return true;
  }) as typeof process.kill);
}

describe.skipIf(process.platform === "win32")("makeRealStagingDocker — cleanup paths (fake processes)", () => {
  it("a producer that has finished is not signalled by the step timeout while the consumer still runs", async () => {
    const consumer = new FakeChild(CONSUMER_PID);
    const producer = new FakeChild(PRODUCER_PID);
    spawnMock.mockReturnValueOnce(consumer).mockReturnValueOnce(producer);
    const kill = fakeKill(consumer);

    const step = makeRealStagingDocker({ command: "docker", tarCommand: "tar", stepTimeoutMs: 50 })(
      ["exec", "-i", "c", "tar", "-xf", "-"], ["-cf", "-", "."],
    );
    setImmediate(() => producer.close(0)); // the feed finishes; the consumer keeps running
    const res = await step;

    expect(res.code).toBe(124); // the consumer was stopped by the named timeout
    expect(kill).toHaveBeenCalledWith(-CONSUMER_PID, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(-PRODUCER_PID, expect.anything());
    expect(producer.kill).not.toHaveBeenCalled();
  });

  it("a producer that has finished is not signalled when the parent is signalled while the consumer still runs", async () => {
    const consumer = new FakeChild(CONSUMER_PID);
    const producer = new FakeChild(PRODUCER_PID);
    spawnMock.mockReturnValueOnce(consumer).mockReturnValueOnce(producer);
    const kill = fakeKill(consumer);

    const step = makeRealStagingDocker({ command: "docker", tarCommand: "tar", stepTimeoutMs: 60_000 })(
      ["exec", "-i", "c", "tar", "-xf", "-"], ["-cf", "-", "."],
    );
    producer.close(0);
    await new Promise((resolveTick) => setImmediate(resolveTick)); // let the producer's close settle

    // The invoker's parent-signal handler, as the process would run it on SIGTERM. process.kill is
    // faked, so its re-raise of the signal does nothing here.
    const handler = process.listeners("SIGTERM").find((listener) => listener.name === "onParentSignal");
    expect(handler, "the invoker's parent-signal handler is installed while a step runs").toBeDefined();
    (handler as (signal: NodeJS.Signals) => void)("SIGTERM");
    await step;

    expect(kill).toHaveBeenCalledWith(-CONSUMER_PID, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(-PRODUCER_PID, expect.anything());
  });

  it("a synchronous throw while starting the producer stops the consumer already started and resolves with a failure", async () => {
    const consumer = new FakeChild(CONSUMER_PID);
    spawnMock.mockReturnValueOnce(consumer).mockImplementationOnce(() => {
      throw new TypeError("The argument 'args' is invalid");
    });
    const kill = fakeKill(consumer);

    const res = await makeRealStagingDocker({ command: "docker", tarCommand: "tar", stepTimeoutMs: 60_000 })(
      ["exec", "-i", "c", "tar", "-xf", "-"], ["-cf", "-", "."],
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("step setup failed");
    expect(res.stderr).toContain("The argument 'args' is invalid");
    expect(kill).toHaveBeenCalledWith(-CONSUMER_PID, "SIGKILL");
    expect(consumer.stdin.destroyed).toBe(true);
    expect(process.listeners("SIGTERM").some((listener) => listener.name === "onParentSignal")).toBe(false);
  });

  it("a synchronous throw from the first spawn resolves with a failure instead of rejecting", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new TypeError("The argument 'file' cannot be empty");
    });
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const res = await makeRealStagingDocker({ command: "", stepTimeoutMs: 60_000 })(["anything"]);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("step setup failed");
    expect(kill).not.toHaveBeenCalled();
  });
});
