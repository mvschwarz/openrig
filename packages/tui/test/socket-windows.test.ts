import { describe, expect, it } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { controlEndpoint, createControlSocket } from "../src/socket-server.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";

function ask(endpoint: string, command: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(endpoint);
    let text = "";
    conn.setTimeout(2000, () => conn.destroy(new Error("Control reply timed out")));
    conn.once("error", reject);
    conn.once("connect", () => conn.write(command + "\n"));
    conn.on("data", (data) => {
      text += data.toString();
      if (text.includes("\n")) { conn.destroy(); resolve(JSON.parse(text.split("\n")[0]!)); }
    });
  });
}
describe("native Windows TUI control", () => {
  it("uses bounded pipe names while Unix endpoints retain their exact paths", () => {
    const file = path.join(os.tmpdir(), "中文", "x".repeat(180), "control.sock");
    expect(controlEndpoint(file, "win32")).toMatch(/^\\\\\.\\pipe\\openrig-tui-[a-f0-9]{64}$/);
    expect(controlEndpoint(file, "linux")).toBe(file);
    const explicit = "\\\\.\\pipe\\user-selected-control";
    expect(controlEndpoint(explicit, "win32")).toBe(explicit);
  });
  it.runIf(process.platform === "win32")("serves grammar commands, protects live endpoints, and rebinds after close", async () => {
    const socketPath = path.join(os.tmpdir(), `rig-tui-${randomUUID()}.sock`);
    const view = createViewState({ instanceId: "native-tui", getSnapshot: () => demoSnapshot() });
    const first = await createControlSocket({ socketPath, view });
    let alternate: Awaited<ReturnType<typeof createControlSocket>> | undefined;
    try {
      expect((await ask(first.path, "state")).instanceId).toBe("native-tui");
      await expect(createControlSocket({ socketPath, view })).rejects.toMatchObject({ code: "EADDRINUSE" });
      alternate = await createControlSocket({ socketPath, view, fallbackOnCollision: true });
      expect(alternate.path).not.toBe(first.path);
      expect((await ask(first.path, "commands")).ok).toBe(true);
      expect((await ask(alternate.path, "state")).ok).toBe(true);
    } finally {
      if (alternate) await alternate.close();
      await first.close();
    }
    const next = await createControlSocket({ socketPath, view });
    try { expect((await ask(next.path, "state")).instanceId).toBe("native-tui"); }
    finally { await next.close(); }
  });
  it.runIf(process.platform === "win32")("protects a live pipe across processes and recovers after its owner is killed", async () => {
    const socketPath = path.join(os.tmpdir(), `rig-process-${randomUUID()}.sock`);
    const endpoint = controlEndpoint(socketPath);
    const children: ChildProcessWithoutNullStreams[] = [];
    const launch = (id: string) => {
      const script = `import {createControlSocket} from ${JSON.stringify(new URL("../dist/socket-server.js", import.meta.url).href)}; import {createViewState} from ${JSON.stringify(new URL("../dist/state.js", import.meta.url).href)}; try { const control = await createControlSocket({socketPath:${JSON.stringify(socketPath)},view:createViewState({instanceId:${JSON.stringify(id)}})}); console.log(JSON.stringify({path:control.path})); } catch(error) {console.log(JSON.stringify({code:error.code}));}`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return new Promise<Record<string, string>>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => { cleanup(); reject(new Error("Native control child did not reply")); }, 5000);
        const cleanup = () => { clearTimeout(timer); child.stdout.off("data", data); child.off("exit", exited); child.off("error", failed); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const exited = (code: number | null) => { cleanup(); reject(new Error(`Native control child exited before reply: ${code}`)); };
        const data = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("\n")) { cleanup(); resolve(JSON.parse(output.split("\n")[0]!)); }
        };
        child.stdout.on("data", data); child.once("exit", exited); child.once("error", failed);
      });
    };
    const stop = async (child: ChildProcessWithoutNullStreams) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL"); await exited;
    };
    try {
      expect(await launch("first")).toEqual({ path: endpoint });
      expect(await launch("second")).toEqual({ code: "EADDRINUSE" });
      expect((await ask(endpoint, "state")).instanceId).toBe("first");
      await stop(children[0]!);
      expect(await launch("recovered")).toEqual({ path: endpoint });
      expect((await ask(endpoint, "state")).instanceId).toBe("recovered");
    } finally { await Promise.all(children.map(stop)); }
  });
});
