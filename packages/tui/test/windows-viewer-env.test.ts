import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { windowsViewerEnvironment } from "../src/terminals/windows-viewer-env.js";

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill(); await exited;
  }
});
describe.skipIf(process.platform !== "win32")("native own-user viewer environment", () => {
  it("returns only canonical terminal markers from a live client, including Unicode and delimiters", async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(TERM_PROGRAM|HERDR_|REX_)/i.test(key)) env[key] = value;
    }
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      env: { ...env, Term_Program: "herdr", herdr_pane_id: "查看者 = pane", HERDR_SOCKET_PATH: "C:\\socket with spaces", HERDR_ENV: "1", OPENRIG_TEST_SECRET: "must-not-leave-helper" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    children.push(child); await once(child.stdout!, "data");
    expect(await windowsViewerEnvironment(child.pid!)).toEqual({ TERM_PROGRAM: "herdr", HERDR_PANE_ID: "查看者 = pane", HERDR_SOCKET_PATH: "C:\\socket with spaces", HERDR_ENV: "1" });
    const exited = once(child, "exit"); child.kill(); await exited;
    expect(await windowsViewerEnvironment(child.pid!)).toBeUndefined();
  }, 15000);
  it.each([0, -1, NaN, 1.5, 0x80000000])("rejects invalid PID %s before invoking a helper", async pid => {
    expect(await windowsViewerEnvironment(pid)).toBeUndefined();
  });
});
