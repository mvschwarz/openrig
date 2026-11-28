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

// The order a real pipe allows: the producer's EOF is forwarded to the consumer, the consumer reads to the end and
// closes, and its close can be seen here BEFORE the producer's own close. That order once read as "the producer was
// still writing" (a CI flake on Linux runners, staging-docker-invoker.test.ts DUAL-EXIT). These force it.
describe.skipIf(process.platform === "win32")("makeRealStagingDocker — the consumer's close seen before the producer's (fake processes)", () => {
  const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));
  const start = () => makeRealStagingDocker({ command: "docker", tarCommand: "tar", stepTimeoutMs: 60_000 })(
    ["exec", "-i", "c", "tar", "-xf", "-"], ["-cf", "-", "."],
  );

  it("a producer that ended its feed and then fails is reported by its own exit code, not as still writing", async () => {
    const consumer = new FakeChild(CONSUMER_PID);
    const producer = new FakeChild(PRODUCER_PID);
    spawnMock.mockReturnValueOnce(consumer).mockReturnValueOnce(producer);
    const kill = fakeKill(consumer);

    const step = start();
    producer.stdout.end(); // the feed ends, and pipe() ends the consumer's stdin
    await tick();
    consumer.close(0); // the consumer read to the end and closed first
    await tick();
    producer.stderr.write("tar: a file changed as we read it\n");
    producer.close(3); // then the producer's own close arrives
    const res = await step;

    expect(res.code).toBe(3);
    expect(res.stderr).toContain("tar-side (stdinFrom) failed: exit 3");
    expect(res.stderr).toContain("tar: a file changed as we read it");
    expect(res.stderr).not.toContain("still producing");
    expect(kill).not.toHaveBeenCalledWith(-PRODUCER_PID, expect.anything());
  });

  it("a producer that ended its feed and then succeeds makes a successful step", async () => {
    const consumer = new FakeChild(CONSUMER_PID);
    const producer = new FakeChild(PRODUCER_PID);
    spawnMock.mockReturnValueOnce(consumer).mockReturnValueOnce(producer);
    const kill = fakeKill(consumer);

    const step = start();
    producer.stdout.end();
    await tick();
    consumer.stdout.write("staged");
    consumer.close(0);
    await tick();
    producer.close(0);
    const res = await step;

    expect(res).toEqual({ stdout: "staged", stderr: "", code: 0 });
    expect(kill).not.toHaveBeenCalledWith(-PRODUCER_PID, expect.anything());
  });

  it("a producer still writing when the consumer closes is killed, and the step says the feed didn't arrive", async () => {
    const consumer = new FakeChild(CONSUMER_PID);
    const producer = new FakeChild(PRODUCER_PID);
    spawnMock.mockReturnValueOnce(consumer).mockReturnValueOnce(producer);
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === -PRODUCER_PID) setImmediate(() => producer.close(null, "SIGKILL"));
      return true;
    }) as typeof process.kill);

    const step = start();
    producer.stdout.write("part of the feed"); // its stdout hasn't ended
    await tick();
    consumer.close(0);
    const res = await step;

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("tar-side (stdinFrom) was still producing when the consumer exited");
    expect(kill).toHaveBeenCalledWith(-PRODUCER_PID, "SIGKILL");
  });
});
