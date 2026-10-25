import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import {
  createRexCliTransport,
  resolveRexBinary,
  RexError,
  RexRunError,
  spawnRex,
  type RexRun,
} from "../src/domain/terminal/rex-transport.js";

const BIN = "/opt/rex/bin/rex";

function recording(reply: (argv: string[], stdin: string) => string | Promise<string>) {
  const calls: Array<{ argv: string[]; stdin: string; timeoutMs: number }> = [];
  const run: RexRun = async (argv, stdin, timeoutMs) => {
    calls.push({ argv, stdin, timeoutMs });
    return reply(argv, stdin);
  };
  return { run, calls };
}

const rejected = async (p: Promise<unknown>): Promise<RexError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RexError);
    return err as RexError;
  }
  throw new Error("expected a rejection");
};

describe("rex CLI transport", () => {
  it("runs `rex --autostart=false -S <server> api call <method> -` with the params as JSON on stdin", async () => {
    const { run, calls } = recording(() => '{"session_id":"session:1"}');
    const transport = createRexCliTransport({ run, binary: () => BIN, env: { REX_SERVER: "unix:///tmp/rex%20home/server.sock" } });
    const params = { label: "kernel", initial_windows: [{ window_label: "w", layout: { block: { flavor: "f" } } }] };
    expect(await transport.request("session.create", params)).toEqual({ session_id: "session:1" });
    expect(calls).toEqual([{
      argv: [BIN, "--autostart=false", "-S", "unix:///tmp/rex%20home/server.sock", "api", "call", "session.create", "-"],
      stdin: JSON.stringify(params),
      timeoutMs: 30_000,
    }]);
  });

  it("leaves the server to rex's own default when REX_SERVER is unset, and reads env once", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { run, calls } = recording(() => "{}");
    const transport = createRexCliTransport({ run, binary: () => BIN, env });
    env["REX_SERVER"] = "unix:///changed.sock";
    await transport.request("session.list", {});
    expect(calls[0]!.argv).toEqual([BIN, "--autostart=false", "api", "call", "session.list", "-"]);
    expect(calls[0]!.stdin).toBe("{}");
  });

  it("is unavailable without running anything when no rex binary is found", async () => {
    const { run, calls } = recording(() => "{}");
    const err = await rejected(createRexCliTransport({ run, binary: () => null, env: {} }).request("server.version", {}));
    expect(err.kind).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it.each([
    ["exit 4 (server unreachable)", new RexRunError("exit 4", 4, "Error: rex server is not running\nrex server autostart is disabled\n")],
    ["a binary that vanished", new RexRunError("spawn rex ENOENT", null, "", "ENOENT")],
  ])("classifies %s as unavailable", async (_name, failure) => {
    const transport = createRexCliTransport({ run: async () => { throw failure; }, binary: () => BIN, env: {} });
    const err = await rejected(transport.request("server.version", {}));
    expect(err.kind).toBe("unavailable");
    expect(err.message).toContain("not reachable");
  });

  it("classifies method_not_found as an older server, whatever the exit code", async () => {
    const stderr = 'Error: stream response "control-1" failed: netapi: no handler for method "session.create" (status=404 code=method_not_found)\n';
    const transport = createRexCliTransport({ run: async () => { throw new RexRunError("exit 3", 3, stderr); }, binary: () => BIN, env: {} });
    const err = await rejected(transport.request("session.create", {}));
    expect(err).toMatchObject({ kind: "method_not_found", code: "method_not_found" });
    expect(err.message).toBe("this Rex server has no session.create; update Rex");
  });

  it("keeps Rex's own words and code for any other failure", async () => {
    const stderr = 'Error: stream response "control-1" failed: session session:0 not found (status=404 code=session_not_found)\n';
    const transport = createRexCliTransport({ run: async () => { throw new RexRunError("exit 3", 3, stderr); }, binary: () => BIN, env: {} });
    const err = await rejected(transport.request("session.list_blocks", { session_id: "session:0" }));
    expect(err).toMatchObject({ kind: "failed", code: "session_not_found" });
    expect(err.message).toBe("rex session.list_blocks: session session:0 not found (status=404 code=session_not_found)");
  });

  it.each(["not json", "[1,2]", "null", ""])("rejects a reply that is not a JSON object: %j", async (out) => {
    const transport = createRexCliTransport({ run: async () => out, binary: () => BIN, env: {} });
    const err = await rejected(transport.request("session.view", {}));
    expect(err).toMatchObject({ kind: "unknown", message: "rex session.view returned no JSON object" });
  });

  it.each([
    ["a timeout", new RexRunError("did not answer within 30000 ms", null)],
    ["a killed client", new RexRunError("ended by SIGKILL", null)],
  ])("%s leaves the outcome unknown, not failed", async (_case, runError) => {
    const transport = createRexCliTransport({ run: async () => { throw runError; }, binary: () => BIN, env: {} });
    const err = await rejected(transport.request("session.new_window", {}));
    expect(err).toMatchObject({ kind: "unknown", message: `rex session.new_window: ${runError.message}` });
  });

  it("probes server.version and server.status for version and instance id", async () => {
    const { run } = recording((argv) => argv.includes("server.version")
      ? '{"rex_version":"0.0.1792787366-g623b2d","platform":"darwin_arm64","dirty":false,"api_revision":7}'
      : '{"pid":1,"instance_id":"aa6e4a93","host_id":"31e9"}');
    expect(await createRexCliTransport({ run, binary: () => BIN, env: {} }).probe())
      .toEqual({ alive: true, version: "0.0.1792787366-g623b2d", instanceId: "aa6e4a93" });
  });

  it("probes with a short timeout, so a hung server can't hold up a status report", async () => {
    const { run, calls } = recording((argv) => argv.includes("server.version") ? '{"rex_version":"1"}' : '{"instance_id":"i"}');
    const transport = createRexCliTransport({ run, binary: () => BIN, env: {} });
    await transport.probe();
    await transport.request("session.list", {});
    expect(calls.map((c) => [c.argv.at(-2), c.timeoutMs])).toEqual([["server.version", 1_000], ["server.status", 1_000], ["session.list", 30_000]]);
  });

  it("answers by its budget even when a stuck rex can't be stopped", async () => {
    const transport = createRexCliTransport({ run: () => new Promise(() => {}), binary: () => BIN, env: {}, probeTimeoutMs: 50 });
    const started = performance.now();
    expect(await transport.probe()).toEqual({ alive: false, version: null, instanceId: null, detail: "the Rex server did not answer within 50 ms" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps a version answer when only server.status is stuck", async () => {
    const run: RexRun = async (argv) => (argv.includes("server.version") ? '{"rex_version":"1.2.3"}' : new Promise<string>(() => {}));
    const transport = createRexCliTransport({ run, binary: () => BIN, env: {}, probeTimeoutMs: 50 });
    expect(await transport.probe()).toEqual({ alive: true, version: "1.2.3", instanceId: null });
  });

  it("a probe never throws: an unreachable server is alive:false with the reason", async () => {
    const transport = createRexCliTransport({ run: async () => { throw new RexRunError("exit 4", 4, "Error: rex server is not running\n"); }, binary: () => BIN, env: {} });
    const probe = await transport.probe();
    expect(probe).toMatchObject({ alive: false, version: null, instanceId: null });
    expect(probe.detail).toContain("rex server is not running");
  });

  it("an answering server without a readable status is alive, with no instance id", async () => {
    const run: RexRun = async (argv) => {
      if (argv.includes("server.status")) throw new RexRunError("exit 1", 1, "Error: boom\n");
      return '{"rex_version":"1.2.3"}';
    };
    expect(await createRexCliTransport({ run, binary: () => BIN, env: {} }).probe()).toEqual({ alive: true, version: "1.2.3", instanceId: null });
  });
});

describe("resolveRexBinary", () => {
  const bundled = path.join(homedir(), "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex");

  it("prefers $REX_BIN_DIR, then PATH, then the app bundle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-bin-"));
    try {
      fs.writeFileSync(path.join(dir, "rex"), "#!/bin/sh\n", { mode: 0o755 });
      expect(resolveRexBinary({ REX_BIN_DIR: "/rex dir", PATH: dir }, (file) => file === "/rex dir/rex")).toBe("/rex dir/rex");
      expect(resolveRexBinary({ REX_BIN_DIR: "/missing", PATH: dir }, () => false)).toBe(path.join(dir, "rex"));
      expect(resolveRexBinary({ PATH: "/nowhere" }, (file) => file === bundled)).toBe(bundled);
      expect(resolveRexBinary({ PATH: "/nowhere" }, () => false)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnRex", () => {
  const script = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-run-"));
    const file = path.join(dir, "rex");
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  it("passes argv without a shell and the params on stdin", async () => {
    const { file, cleanup } = script('printf "%s|" "$@"; cat');
    try {
      expect(await spawnRex([file, "api", "call", "x y", "-"], '{"a":"$HOME"}', 5_000)).toBe('api|call|x y|-|{"a":"$HOME"}');
    } finally {
      cleanup();
    }
  });

  it("rejects with the exit code and stderr", async () => {
    const { file, cleanup } = script('echo "Error: nope (status=400 code=bad_request)" >&2; exit 1');
    try {
      await expect(spawnRex([file], "{}", 5_000)).rejects.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("code=bad_request") });
    } finally {
      cleanup();
    }
  });

  it("ends a run that does not answer in time, with its process group", async () => {
    const { file, cleanup } = script('sleep 30 & echo $! > "$(dirname "$0")/child.pid"; wait');
    try {
      const failure = vi.fn();
      const started = performance.now();
      // A deadline the script's start fits well inside, even on a loaded runner.
      await spawnRex([file], "{}", 1_000).catch(failure);
      // Ended at the deadline: not after stopGroup's one-second grace, and not when the sleep ends 30 s later.
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(failure).toHaveBeenCalledOnce();
      expect(failure.mock.calls[0]![0]).toMatchObject({ exitCode: null, message: "did not answer within 1000 ms" });
      // An empty file would read as pid 0, which names this test's own process group.
      const child = Number(fs.readFileSync(path.join(path.dirname(file), "child.pid"), "utf8"));
      expect(Number.isInteger(child) && child > 1, `backgrounded pid ${child}`).toBe(true);
      // The backgrounded sleep was ended with the run's group. Its parent is gone, so the system reaps it on its own
      // schedule: wait a bounded moment for that instead of reading the process table at one instant.
      await expect.poll(() => { try { process.kill(child, 0); return true; } catch { return false; } }, { timeout: 5_000, interval: 20 })
        .toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects a binary that cannot start as ENOENT", async () => {
    await expect(spawnRex(["/no/such/rex"], "{}", 1_000)).rejects.toMatchObject({ errno: "ENOENT", exitCode: null });
  });
});
