import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { startWindowsDaemonControl, requestWindowsDaemonStop } from "../src/windows-daemon-control.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
describe.skipIf(process.platform !== "win32")("native Windows drain request", () => {
  it("crosses the production startServer drain and persists a clean receipt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-drain-"));
    const root = path.resolve(import.meta.dirname, "../../..");
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(path.join(import.meta.dirname, "fixtures/shutdown-loader.mjs")).href,
      path.join(import.meta.dirname, "fixtures/shutdown-child.mjs")], { windowsHide: true, stdio: "ignore",
      env: { ...process.env, S15_SOURCE_ROOT: root, S15_CASE: "clean", OPENRIG_HOME: home, OPENRIG_DB: path.join(home, "db.sqlite"), OPENRIG_NO_KERNEL: "1", OPENRIG_URL: "" } });
    try {
      const ready = path.join(home, "ready.json");
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(ready)).toBe(true);
      const state = JSON.parse(readFileSync(ready, "utf8"));
      const exited = once(child, "exit");
      await requestWindowsDaemonStop(home, state);
      const [code] = await exited;
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(path.join(home, "daemon-shutdown.json"), "utf8"))).toMatchObject({ pid: child.pid, outcome: "clean", phase: "complete" });
      expect(existsSync(path.join(home, "daemon-control.json"))).toBe(false);
      expect(readFileSync(path.join(home, `measurements-${child.pid}.jsonl`), "utf8")).toContain("shutdown.consumer");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    }
  }, 15000);
  it("rejects stale identity and accepts exactly the current instance", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const state = { pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(path.join(home, "daemon.json"), JSON.stringify(state));
    let requested = 0;
    const close = await startWindowsDaemonControl(home, () => { requested += 1; });
    cleanup.push(close);
    await expect(requestWindowsDaemonStop(home, { ...state, startedAt: "wrong" })).rejects.toThrow("unverified");
    expect(requested).toBe(0);
    await requestWindowsDaemonStop(home, state);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requested).toBe(1);
  });
  it("preserves a successor's capability when closing a predecessor", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const close = await startWindowsDaemonControl(home, () => {});
    const file = path.join(home, "daemon-control.json");
    const successor = { ...JSON.parse(readFileSync(file, "utf8")), token: "successor" };
    writeFileSync(file, JSON.stringify(successor));
    await close();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("successor");
  });
});
