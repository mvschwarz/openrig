import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../src/config-store.js";
import { buildDaemonEnv, startDaemon } from "../src/daemon-lifecycle.js";
import { daemonCommand } from "../src/commands/daemon.js";
import { startCommand } from "../src/commands/start.js";
import { upCommand } from "../src/commands/up.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { createTranscriptRotationOptionsResolver } from "../../daemon/src/domain/transcript-rotation.js";

vi.mock("../src/daemon-lifecycle.js", async (original) => {
  const actual = await original<typeof import("../src/daemon-lifecycle.js")>();
  return { ...actual, getDaemonStatus: vi.fn(async () => ({ state: "stopped" })), startDaemon: vi.fn(async () => { throw new Error("startup options captured"); }) };
});
vi.mock("../src/system-preflight.js", () => ({ SystemPreflight: class { async run() { return { ready: true, checks: [] }; } } }));
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "transcript-startup-"));
  vi.stubEnv("OPENRIG_HOME", home);
  vi.stubEnv("OPENRIG_TRANSCRIPTS_LINES", undefined);
  vi.stubEnv("OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS", undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(startDaemon).mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); process.exitCode = undefined; });

it.each(["daemon", "start", "up"])("%s startup leaves file settings live and preserves explicit environment overrides", async (entry) => {
  const file = join(home, "config.json");
  const cli = new ConfigStore(file);
  cli.set("transcripts.lines", "40"); cli.set("transcripts.poll_interval_seconds", "3");
  const deps = { lifecycleDeps: {} as never, clientFactory: vi.fn() as never };
  const command = entry === "daemon" ? daemonCommand(deps.lifecycleDeps) : entry === "start" ? startCommand(deps) : upCommand(deps);
  await command.parseAsync(entry === "daemon" ? ["start"] : entry === "start" ? ["--all"] : ["fixture.yaml"], { from: "user" });
  expect(startDaemon).toHaveBeenCalledTimes(1);
  const options = vi.mocked(startDaemon).mock.calls[0]![0];
  const daemonEnv = buildDaemonEnv({}, { ...options, port: 7433, db: "fixture.sqlite" });
  expect(daemonEnv["OPENRIG_TRANSCRIPTS_LINES"]).toBeUndefined();
  expect(daemonEnv["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"]).toBeUndefined();
  vi.useFakeTimers();
  const resolve = createTranscriptRotationOptionsResolver(new SettingsStore(file));
  expect(resolve()).toEqual({ lines: 40, pollIntervalMs: 3000 });
  cli.set("transcripts.lines", "20"); cli.set("transcripts.poll_interval_seconds", "1");
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolve()).toEqual({ lines: 20, pollIntervalMs: 1000 });
  const explicit = buildDaemonEnv({ OPENRIG_TRANSCRIPTS_LINES: "60", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "5" }, { ...options, port: 7433, db: "fixture.sqlite" });
  vi.stubEnv("OPENRIG_TRANSCRIPTS_LINES", explicit["OPENRIG_TRANSCRIPTS_LINES"]);
  vi.stubEnv("OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS", explicit["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolve()).toEqual({ lines: 60, pollIntervalMs: 5000 });
});
