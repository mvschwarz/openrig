import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { OmpBridgeServer, type OmpBridgeServerOptions } from "../src/adapters/omp-bridge-server.js";

function createSocketPath(): { directory: string; socketPath: string } {
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-bridge-server-"));
  return { directory, socketPath: nodePath.join(directory, "bridge.sock") };
}

function createBridgeServer(
  socketPath: string,
  options: Pick<OmpBridgeServerOptions, "onLockOwnerJudged" | "onLockMovedAside" | "onBridgeClosed" | "onBridgeReady" | "processKill"> = {},
): OmpBridgeServer {
  return new OmpBridgeServer({
    socketPath,
    onBridgeFrame: () => {},
    onControlFrame: () => {},
    ...options,
  });
}

function connect(socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

/** A pid that is not running, so a lock file holding it is stale. */
function deadPid(): number {
  for (let pid = 999_000; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no unused pid found");
}

describe("OmpBridgeServer socket ownership", () => {
  it("allows only one concurrent starter and preserves its socket", async () => {
    const { directory, socketPath } = createSocketPath();
    const servers = [createBridgeServer(socketPath), createBridgeServer(socketPath)];
    try {
      const results = await Promise.allSettled(servers.map((server) => server.start()));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fs.existsSync(socketPath)).toBe(true);
      await connect(socketPath);
    } finally {
      for (const server of servers) server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a live socket owner without disrupting its control connections", async () => {
    const { directory, socketPath } = createSocketPath();
    const owner = createBridgeServer(socketPath);
    const contender = createBridgeServer(socketPath);
    try {
      await owner.start();
      await expect(contender.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      await connect(socketPath);
    } finally {
      owner.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes a stale lock and starts serving", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, String(Number.MAX_SAFE_INTEGER));
      await server.start();
      await connect(socketPath);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      server.close();
      expect(fs.existsSync(lockPath)).toBe(false);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("takes over a stale pid lock and records its tokenized owner", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, String(deadPid()));
      await server.start();
      await connect(socketPath);
      const owner = fs.readFileSync(lockPath, "utf8");
      expect(owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(owner.slice(`${process.pid}:`.length)).not.toBe("");
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a replacement lock during stale takeover", async () => {
    const { directory, socketPath } = createSocketPath();
    const lockPath = `${socketPath}.lock`;
    let replaced = false;
    const server = createBridgeServer(socketPath, {
      onLockMovedAside: (asidePath) => {
        if (replaced) return;
        replaced = true;
        fs.unlinkSync(asidePath);
        fs.writeFileSync(asidePath, "replacement-aside-owner");
        fs.writeFileSync(lockPath, `${process.pid}:replacement-owner`);
      },
    });
    try {
      fs.writeFileSync(lockPath, String(deadPid()));
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(replaced).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:replacement-owner`);
      expect(fs.readdirSync(directory).some((name) => name.endsWith(".aside"))).toBe(true);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a replacement lock during release", async () => {
    const { directory, socketPath } = createSocketPath();
    const lockPath = `${socketPath}.lock`;
    let replaced = false;
    const server = createBridgeServer(socketPath, {
      onLockMovedAside: (asidePath) => {
        if (replaced) return;
        replaced = true;
        fs.unlinkSync(asidePath);
        fs.writeFileSync(asidePath, "replacement-aside-owner");
        fs.writeFileSync(lockPath, `${process.pid}:replacement-owner`);
      },
    });
    try {
      await server.start();
      server.close();
      expect(replaced).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:replacement-owner`);
      expect(fs.readdirSync(directory).some((name) => name.endsWith(".aside"))).toBe(true);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a replacement lock when closing", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      await server.start();
      fs.writeFileSync(lockPath, `${process.pid}:other-owner`);
      server.close();
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:other-owner`);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a pid and non-empty token in its lock", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    try {
      await server.start();
      const owner = fs.readFileSync(`${socketPath}.lock`, "utf8");
      expect(owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(owner.slice(`${process.pid}:`.length)).not.toBe("");
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a live pid lock without removing it", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    const owner = `${process.pid}:live-owner`;
    try {
      fs.writeFileSync(lockPath, owner);
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["EPERM", Object.assign(new Error("permission denied"), { code: "EPERM" })],
    ["unexpected errors", new Error("unexpected process probe failure")],
  ])("preserves a pid lock on %s from process probe", async (_failure, error) => {
    const { directory, socketPath } = createSocketPath();
    const owner = "12345:live-owner";
    const server = createBridgeServer(socketPath, {
      processKill: () => {
        throw error;
      },
    });
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, owner);
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("takes over a pid lock when process probe returns ESRCH", async () => {
    const { directory, socketPath } = createSocketPath();
    const lockPath = `${socketPath}.lock`;
    const server = createBridgeServer(socketPath, {
      processKill: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });
    try {
      fs.writeFileSync(lockPath, "12345:gone-owner");
      await server.start();
      await connect(socketPath);
      expect(fs.readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("takes over a lock file whose owner is gone", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, String(deadPid()));
      await server.start();
      await connect(socketPath);
      const owner = fs.readFileSync(lockPath, "utf8");
      expect(owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(owner.slice(`${process.pid}:`.length)).not.toBe("");
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unowned live socket without removing its path", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const plainServer = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        plainServer.once("error", reject);
        plainServer.listen(socketPath, resolve);
      });
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.existsSync(`${socketPath}.lock`)).toBe(false);
      await connect(socketPath);
    } finally {
      server.close();
      await new Promise<void>((resolve) => plainServer.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes its lock file when closed", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      await server.start();
      expect(fs.existsSync(lockPath)).toBe(true);
      server.close();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes a stale socket path and starts serving", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    try {
      fs.writeFileSync(socketPath, "stale socket entry");
      await server.start();
      await connect(socketPath);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports bridge closure once and ignores control-client closure", async () => {
    const { directory, socketPath } = createSocketPath();
    let bridgeClosedCount = 0;
    let bridgeReadyCount = 0;
    let bridgeReadyResolve: (() => void) | undefined;
    let bridgeClosedResolve: (() => void) | undefined;
    let bridgeReady = new Promise<void>((resolve) => { bridgeReadyResolve = resolve; });
    let bridgeClosed = new Promise<void>((resolve) => { bridgeClosedResolve = resolve; });
    const server = createBridgeServer(socketPath, {
      onBridgeReady: () => {
        bridgeReadyCount += 1;
        bridgeReadyResolve?.();
      },
      onBridgeClosed: () => {
        bridgeClosedCount += 1;
        bridgeClosedResolve?.();
      },
    });
    try {
      await server.start();
      const control = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        control.once("connect", () => {
          control.write(`${JSON.stringify({ role: "control", protocolVersion: 1 })}\n`);
          resolve();
        });
        control.once("error", reject);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      control.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(bridgeClosedCount).toBe(0);

      const bridge = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        bridge.once("connect", () => {
          bridge.write(`${JSON.stringify({ role: "bridge", protocolVersion: 1 })}\n`);
          resolve();
        });
        bridge.once("error", reject);
      });
      await bridgeReady;
      bridge.destroy();
      await bridgeClosed;
      expect(bridgeClosedCount).toBe(1);

      bridgeReady = new Promise<void>((resolve) => { bridgeReadyResolve = resolve; });
      bridgeClosed = new Promise<void>((resolve) => { bridgeClosedResolve = resolve; });
      const reconnectedBridge = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        reconnectedBridge.once("connect", () => {
          reconnectedBridge.write(`${JSON.stringify({ role: "bridge", protocolVersion: 1 })}\n`);
          resolve();
        });
        reconnectedBridge.once("error", reject);
      });
      await bridgeReady;
      expect(bridgeReadyCount).toBe(2);
      reconnectedBridge.destroy();
      await bridgeClosed;
      expect(bridgeClosedCount).toBe(2);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

});
