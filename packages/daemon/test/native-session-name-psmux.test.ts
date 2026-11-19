import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName, NATIVE_LOGICAL_SESSION_OPTION } from "../src/domain/terminal/native-session-name.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("creates and recovers a constrained logical name only with its matching native marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-name-binding-")), registry = path.join(root, "registry"); await mkdir(registry);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL" };
  env.PSMUX_CONFIG_FILE = path.join(root, "fixture.conf");
  await writeFile(env.PSMUX_CONFIG_FILE, `set-option -g default-shell '${path.join(process.env.SystemRoot ?? "C:/Windows", "System32/cmd.exe").replaceAll("\\", "/")}'\n`);
  const execute = promisify(execFile);
  const invoke = async (argv: string[]) => (await execute(process.env.OPENRIG_TEST_PSMUX!, argv, { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000 })).stdout;
  const makeAdapter = () => new TmuxAdapter(async () => { throw new Error("Unexpected shell transport"); }, undefined, argv => invoke(argv.slice(1)), [], "psmux");
  const logical = "owned|logical-name", binding = bindNativeSessionName(logical);
  let primaryFailure: unknown;
  try {
    const adapter = makeAdapter();
    const created = await adapter.createProbeSession(logical, root); expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(await invoke(["show-options", "-qv", "-t", "=" + binding.physical + ":", NATIVE_LOGICAL_SESSION_OPTION])).toBe(binding.marker + "\n");
    await adapter.setSessionEnv(logical, "OPENRIG_SYNTHETIC_BOUND", "synthetic mapped value");
    const recovered = makeAdapter();
    expect(await recovered.probeSession(logical)).toEqual({ state: "present" });
    expect(await recovered.getSessionEnv(logical, "OPENRIG_SYNTHETIC_BOUND")).toBe("synthetic mapped value");
    expect((await recovered.listPanes(logical)).length).toBe(1);
    await invoke(["set-option", "-u", "-t", "=" + binding.physical + ":", NATIVE_LOGICAL_SESSION_OPTION]);
    await expect(recovered.getSessionEnv(logical, "OPENRIG_SYNTHETIC_BOUND")).rejects.toThrow("Cannot read the session's launch environment");
    expect((await makeAdapter().createProbeSession(logical, root)).ok).toBe(false);
    expect((await invoke(["show-options", "-qv", "-t", "=" + binding.physical + ":", NATIVE_LOGICAL_SESSION_OPTION])).trim()).toBe("");
    expect(await invoke(["show-environment", "-t", "=" + binding.physical, "OPENRIG_SYNTHETIC_BOUND"])).toBe("OPENRIG_SYNTHETIC_BOUND=synthetic mapped value\n");
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    await invoke(["kill-session", "-t", "=" + binding.physical]).catch(() => {});
    try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { if (primaryFailure) throw new AggregateError([primaryFailure, error], "Native name binding check and owned cleanup failed"); throw error; }
  }
}, 40000);
