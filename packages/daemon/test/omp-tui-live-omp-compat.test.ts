import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OmpBridgeServer, controlHandshakeFrame } from "../src/adapters/omp-bridge-server.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { buildPiChildArgs, buildPiChildEnv, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { resolveRuntimeExecutable } from "../src/adapters/pi-runner.js";

const resolvedOmp = resolveRuntimeExecutable("omp", process.env);
const testDir = nodePath.dirname(fileURLToPath(import.meta.url));
const compiledExtension = nodePath.resolve(testDir, "../dist/adapters/omp-tui-extension.js");
const missingOmpReason = resolvedOmp.ok ? "" : `OMP unavailable: ${resolvedOmp.error}`;
const missingExtensionReason = fs.existsSync(compiledExtension) ? "" : "compiled OMP bridge extension missing; build packages/daemon first";
const skipReason = missingOmpReason || missingExtensionReason;

let runningChild: ChildProcess | undefined;
let temporaryRoots: string[] = [];
let bridgeServer: OmpBridgeServer | undefined;
let controlSocket: net.Socket | undefined;

afterEach(async () => {
  controlSocket?.destroy();
  controlSocket = undefined;
  bridgeServer?.close();
  bridgeServer = undefined;
  const child = runningChild;
  runningChild = undefined;
  if (child?.pid !== undefined) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots = [];
});

function waitForFrame(
  frames: Record<string, unknown>[],
  subscribe: (listener: (frame: Record<string, unknown>) => void) => void,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const found = frames.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for bridge frame (${timeoutMs}ms); received: ${frames.map((frame) => String(frame.type ?? "unknown")).join(", ")}`)), timeoutMs);
    subscribe((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

function recordField(frame: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = frame[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`bridge frame ${field} was not an object`);
  }
  return value as Record<string, unknown>;
}

function stringIds(data: Record<string, unknown>): string[] {
  const entries = data.entries;
  if (!Array.isArray(entries)) throw new Error("bridge entries reply omitted entries array");
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("bridge entries reply contained a non-object entry");
    }
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id !== "string") throw new Error("bridge entries reply contained an entry without a string id");
    return id;
  });
}

describe("live OMP extension compatibility with real session-manager semantics", () => {
  it.skipIf(Boolean(skipReason))(`loads runner-shipped extension and reports real session entries${skipReason ? ` (skipped: ${skipReason})` : ""}`, async () => {
    if (!resolvedOmp.ok) throw new Error(`unreachable: ${resolvedOmp.error}`);
    if (!fs.existsSync(compiledExtension)) throw new Error("unreachable: compiled OMP bridge extension is absent");

    const timeoutMs = 55_000;
    const stateRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-live-state-"));
    const homeRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-live-home-"));
    temporaryRoots = [stateRoot, homeRoot];
    const sessionName = "live-omp";
    const paths = piSeatPaths(stateRoot, sessionName);
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    const sessionId = randomUUID();
    const sessionFile = nodePath.join(paths.sessionsDir, "2026-10-22T00-00-00-000Z_live.jsonl");
    const timestamp = "2026-10-22T00:00:00.000Z";
    const entries = [
      { type: "model_change", id: "live0001", parentId: null, timestamp, provider: "openai", modelId: "unconfigured" },
      { type: "model_change", id: "live0002", parentId: "live0001", timestamp, provider: "openai", modelId: "unconfigured" },
      { type: "model_change", id: "live0003", parentId: "live0002", timestamp, provider: "openai", modelId: "unconfigured" },
    ];
    const sessionLines = [
      { type: "title", v: 1, title: "", updatedAt: timestamp, pad: " ".repeat(256) },
      { type: "session", version: 3, id: sessionId, timestamp, cwd: stateRoot },
      ...entries,
    ];
    fs.writeFileSync(sessionFile, `${sessionLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const socketPath = nodePath.join(stateRoot, "bridge.sock");
    const frames: Record<string, unknown>[] = [];
    const listeners: Array<(frame: Record<string, unknown>) => void> = [];
    const recordFrame = (frame: Record<string, unknown>): void => {
      frames.push(frame);
      for (const listener of [...listeners]) listener(frame);
    };
    const subscribe = (listener: (frame: Record<string, unknown>) => void): void => { listeners.push(listener); };
    bridgeServer = new OmpBridgeServer({ socketPath, onBridgeFrame: recordFrame, onControlFrame: () => {} });
    await bridgeServer.start();

    const env = buildPiChildEnv(process.env, {
      agentDir: paths.agentDir,
      sessionsDir: paths.sessionsDir,
      runtime: "omp",
      sessionName,
      bridgeSocketPath: socketPath,
    });
    env.HOME = homeRoot;
    const childArgs = buildPiChildArgs({
      sessionsDir: paths.sessionsDir,
      sessionName,
      trust: "approve",
      runtime: "omp",
      ui: "native",
      bridgeExtensionPath: compiledExtension,
      sessionFile,
    });
    const commandLine = [resolvedOmp.path, ...childArgs].map(shellQuote).join(" ");
    const script = ["/usr/bin/script", "/bin/script", ...(process.env.PATH ?? "").split(nodePath.delimiter).filter(Boolean).map((dir) => nodePath.join(dir, "script"))]
      .find((candidate) => {
        try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
      });
    if (!script) throw new Error("native OMP requires util-linux script pty launcher");
    let stdout = "";
    let stderr = "";
    runningChild = spawn(script, ["-qfec", commandLine, "/dev/null"], {
      cwd: stateRoot,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    runningChild.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4000); });
    runningChild.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    const child = runningChild;
    const onChildExit = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => reject(new Error(`OMP exited before bridge completed (code=${code}, signal=${signal}): ${stderr}`)));
    });
    const wait = <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        promise,
        onChildExit,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`OMP startup timed out (${timeoutMs}ms): ${stderr}`)), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    };

    await wait((async () => {
      const deadline = Date.now() + timeoutMs;
      while (!bridgeServer?.bridgeConnected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!bridgeServer?.bridgeConnected) throw new Error(`OMP did not establish bridge-role connection: ${stderr}`);
    })());

    const identity = await Promise.race([
      waitForFrame(frames, subscribe, (frame) => frame.type === "session_identity", 15_000),
      onChildExit,
    ]).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; OMP stdout: ${stdout}; OMP stderr: ${stderr}`);
    });
    expect(identity.sessionId).toBe(sessionId);
    expect(typeof identity.sessionFile).toBe("string");
    expect(nodePath.resolve(identity.sessionFile as string)).toBe(nodePath.resolve(sessionFile));
    await Promise.race([
      waitForFrame(frames, subscribe, (frame) => frame.type === "session_start", 15_000),
      onChildExit,
    ]).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; OMP stdout: ${stdout}; OMP stderr: ${stderr}`);
    });

    controlSocket = net.createConnection({ path: socketPath });
    await wait(new Promise<void>((resolve, reject) => {
      controlSocket?.once("connect", resolve);
      controlSocket?.once("error", reject);
    }));
    controlSocket.write(`${JSON.stringify(controlHandshakeFrame())}\n`);
    const request = (id: string, since?: string): Record<string, unknown> => ({ type: "get_entries", id, ...(since === undefined ? {} : { since }) });
    const sendQuery = async (id: string, since?: string): Promise<Record<string, unknown>> => {
      const reply = waitForFrame(frames, subscribe, (frame) => frame.type === "response" && frame.id === id, timeoutMs);
      bridgeServer?.sendToBridge(request(id, since), controlSocket);
      return wait(reply);
    };

    const initial = await sendQuery("probe-initial");
    expect(initial.success).toBe(true);
    const initialData = recordField(initial, "data");
    expect(initialData.available).toBe(true);
    expect(stringIds(initialData)).toEqual(["live0001", "live0002", "live0003"]);
    expect(initialData.newestId).toBe("live0003");

    const cursorReply = await sendQuery("probe-cursor", "live0001");
    expect(cursorReply.success).toBe(true);
    const cursorData = recordField(cursorReply, "data");
    expect(cursorData.available).toBe(true);
    expect(stringIds(cursorData)).toEqual(["live0002", "live0003"]);
    expect(cursorData.newestId).toBe("live0003");

    const diskLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const diskIds = new Set(diskLines.filter((entry) => typeof entry.id === "string").map((entry) => entry.id as string));
    expect([...stringIds(initialData), ...stringIds(cursorData)].every((id) => diskIds.has(id))).toBe(true);
  }, 60_000);
});
