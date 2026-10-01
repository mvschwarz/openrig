import { afterAll, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createViewState } from "../src/state.js";
import { createControlSocket, type ControlSocket } from "../src/socket-server.js";

const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opr-sock-"));
afterAll(() => fs.rmSync(socketRoot, { recursive: true, force: true }));
function socketPath(label: string) { return path.join(socketRoot, `${label}.sock`); }
async function query(path: string): Promise<unknown> {
  const client = net.createConnection(path);
  client.setEncoding("utf8");
  try {
    return await new Promise((resolve, reject) => {
      let text = "";
      client.once("error", reject);
      client.once("connect", () => client.write("state\n"));
      client.on("data", (chunk) => { text += chunk; if (text.includes("\n")) resolve(JSON.parse(text)); });
    });
  } finally { client.destroy(); }
}

it("refuses a second launcher without taking over the first live control socket", async () => {
  const path = socketPath("live");
  const first = await createControlSocket({ socketPath: path, view: createViewState({ instanceId: "first" }) });
  let second: ControlSocket | undefined;
  try {
    await expect((async () => {
      second = await createControlSocket({ socketPath: path, view: createViewState({ instanceId: "second" }) });
    })()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await query(path)).toMatchObject({ instanceId: "first" });
  } finally {
    await second?.close();
    await first.close();
  }
});

it("keeps an ordinary file at the configured socket path intact", async () => {
  const path = socketPath("file");
  fs.writeFileSync(path, "owner data");
  let control: ControlSocket | undefined;
  try {
    await expect((async () => { control = await createControlSocket({ socketPath: path, view: createViewState({ instanceId: "new" }) }); })()).rejects.toBeDefined();
    expect(fs.readFileSync(path, "utf8")).toBe("owner data");
  } finally { await control?.close(); fs.rmSync(path, { force: true }); }
});

it("recovers the owned stale socket of a killed launcher", async () => {
  const path = socketPath("stale");
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("ready"))`], { stdio: ["ignore", "pipe", "pipe"] });
  let control: ControlSocket | undefined;
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    const died = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await died;
    expect(fs.lstatSync(path).isSocket()).toBe(true);
    control = await createControlSocket({ socketPath: path, view: createViewState({ instanceId: "recovered" }) });
    expect(await query(path)).toMatchObject({ instanceId: "recovered" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await control?.close();
    fs.rmSync(path, { force: true });
  }
});
