import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  const child: ChildProcess = spawn(process.execPath, process.platform === "win32"
    ? ["--import", "tsx", fileURLToPath(new URL("./fixtures/acp-cancel-runner.ts", import.meta.url)), home]
    : ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "inherit"] });
  cleanup.push(() => { child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  if (process.platform === "win32") await vi.waitFor(() => expect(existsSync(join(home, "ready"))).toBe(true), { timeout: 10000 });
  const runs = join(home, "acp", "runs");
  mkdirSync(runs, { recursive: true });
  const record = (runId: string, extra: Record<string, unknown>) =>
    writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ runId, qitemId: "qitem-x", pid: child.pid, agent: [], startedAt: "2026-10-23T00:00:00Z", ...extra }));
  const start = processStart(child.pid!);
  expect(start).toBeDefined();
  if (process.platform === "win32") {
    writeFileSync(join(runs, "acp-live.cancel.json"), JSON.stringify({ processStart: "stale-process-start" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.exitCode).toBeNull();
    expect(existsSync(join(home, "outcome.json"))).toBe(false);
  }

  record("acp-stale", { processStart: "Thu Jan 1 00:00:00 2026" }); // an old run's record whose pid now names another process
  record("acp-ended", { processStart: start, endedAt: "2026-10-23T00:00:01Z" });
  expect(await cancel("acp-stale")).toBe(1);
  expect(await cancel("acp-ended")).toBe(1);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();

  record("acp-live", { processStart: start });
  expect(await cancel("acp-live")).toBeUndefined();
  expect(await exited).toBe(process.platform === "win32" ? null : "SIGINT");
  if (process.platform === "win32") {
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "outcome.json"), "utf8"))).toMatchObject({ kind: "cancelled" });
    expect(readFileSync(join(home, "run.jsonl"), "utf8")).toContain("session/cancel");
  }
}, 20000);
