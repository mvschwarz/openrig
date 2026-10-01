import { expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

async function line(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => { cleanup(); resolve(data.toString().trim()); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`launcher exited before reply: ${code}`)); };
    const cleanup = () => { child.stdout.off("data", onData); child.off("exit", onExit); };
    child.stdout.once("data", onData);
    child.once("exit", onExit);
    child.once("error", reject);
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await closed;
}

async function query(socketPath: string): Promise<string> {
  const client = net.createConnection(socketPath);
  client.setEncoding("utf8");
  try {
    return await new Promise((resolve, reject) => {
      let text = "";
      client.once("error", reject);
      client.once("connect", () => client.write("state\n"));
      client.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve(JSON.parse(text).instanceId as string);
      });
    });
  } finally { client.destroy(); }
}

it("two processes recovering one stale socket cannot unlink a live replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opr-race-"));
  const socketPath = path.join(root, "control.sock");
  const source = fileURLToPath(new URL("../dist/socket-server.js", import.meta.url));
  const state = fileURLToPath(new URL("../dist/state.js", import.meta.url));
  const launched: ChildProcessWithoutNullStreams[] = [];
  const child = (script: string) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    launched.push(process);
    return process;
  };
  const launcher = (name: string, pause: boolean) => child(`
    import fs from "node:fs";
    import { createControlSocket } from ${JSON.stringify(pathToFileURL(source).href)};
    import { createViewState } from ${JSON.stringify(pathToFileURL(state).href)};
    const socketPath = ${JSON.stringify(socketPath)};
    const originalStat = fs.lstatSync;
    let observations = 0;
    fs.lstatSync = function(target, ...args) {
      const result = originalStat.call(fs, target, ...args);
      if (target === socketPath && ++observations === 2 && ${pause}) {
        // Pause after a genuine inode observation; another OS process can run.
        process.stdout.write("checked\\n");
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      return result;
    };
    try {
      await createControlSocket({ socketPath, view: createViewState({ instanceId: ${JSON.stringify(name)} }) });
      process.stdout.write("ready\\n");
    } catch (error) {
      process.stdout.write("refused:" + error.code + "\\n");
    }
  `);
  try {
    const stale = child(`import net from "node:net"; net.createServer().listen(${JSON.stringify(socketPath)}, () => console.log("ready"));`);
    expect(await line(stale)).toBe("ready");
    await stop(stale);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);

    const first = launcher("first", true);
    expect(await line(first)).toBe("checked");
    const second = launcher("second", false);
    const secondOutcome = await line(second);
    const reachableBeforeRelease = secondOutcome === "ready" ? await query(socketPath) : undefined;
    const firstOutcome = line(first);
    first.stdin.write("\n");
    expect(await firstOutcome).toBe("ready");
    const reachableAfterRelease = await query(socketPath);

    expect({ secondOutcome, reachableBeforeRelease, reachableAfterRelease }).toEqual({
      secondOutcome: "refused:EADDRINUSE",
      reachableBeforeRelease: undefined,
      reachableAfterRelease: "first",
    });
  } finally {
    await Promise.all(launched.map(stop));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
