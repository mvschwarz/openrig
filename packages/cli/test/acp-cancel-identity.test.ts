import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpCommand, processStart } from "../src/commands/acp.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0)) fn(); });

async function cancel(runId: string): Promise<number | undefined> {
  const error = console.error, log = console.log;
  console.error = () => {}; console.log = () => {};
  process.exitCode = undefined;
  try { await acpCommand().parseAsync(["node", "rig", "cancel", runId]); } finally { console.error = error; console.log = log; }
  const exit = process.exitCode; process.exitCode = 0;
  return exit;
}

it("rig acp cancel signals only the live run that wrote the record, never a reused pid or an ended run", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-cancel-"));
  vi.stubEnv("OPENRIG_HOME", home);
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  cleanup.push(() => { child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  const runs = join(home, "acp", "runs");
  mkdirSync(runs, { recursive: true });
  const record = (runId: string, extra: Record<string, unknown>) =>
    writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ runId, qitemId: "qitem-x", pid: child.pid, agent: [], startedAt: "2026-10-23T00:00:00Z", ...extra }));
  const start = processStart(child.pid!);
  expect(start).toBeDefined();

  record("acp-stale", { processStart: "Thu Jan 1 00:00:00 2026" }); // an old run's record whose pid now names another process
  record("acp-ended", { processStart: start, endedAt: "2026-10-23T00:00:01Z" });
  expect(await cancel("acp-stale")).toBe(1);
  expect(await cancel("acp-ended")).toBe(1);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();

  record("acp-live", { processStart: start });
  expect(await cancel("acp-live")).toBeUndefined();
  expect(await exited).toBe("SIGINT");
});
