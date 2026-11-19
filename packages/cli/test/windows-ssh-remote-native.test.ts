import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { runCrossHostCommand, type SpawnFn } from "../src/cross-host-executor.js";

// Opt-in: an operator-owned Windows SSH host and synthetic receiver only.
// The receiver reads stdin, echoes argv/origin as JSON, and exits argv[0].
const enabled = ["TARGET", "USER", "KEY", "KNOWN_HOSTS", "RECEIVER"].every(key => !!process.env[`OPENRIG_TEST_SSH_${key}`]);
const execute: SpawnFn = (command, args) => spawn(command, ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", `UserKnownHostsFile=${process.env.OPENRIG_TEST_SSH_KNOWN_HOSTS}`, "-i", process.env.OPENRIG_TEST_SSH_KEY!, ...args], { stdio: "pipe", windowsHide: true });
const host = () => ({ id: "owned-acceptance", transport: "ssh" as const, target: process.env.OPENRIG_TEST_SSH_TARGET!, user: process.env.OPENRIG_TEST_SSH_USER!, remoteShell: "powershell" as const, rigPath: process.env.OPENRIG_TEST_SSH_RECEIVER! });
it.runIf(enabled).each([0, 7])("real Windows SSH preserves structured argv/stdin/origin and exit %s", async code => {
  const values = [String(code), "", "space 中文😀", "a'b", 'a"b', "trailing\\", "$() &; %PATH%\nnext"];
  const origin = "fixture@acceptance@owned-host", stdin = "synthetic stdin 中文\nnext\n";
  const result = await runCrossHostCommand(host(), ["rig", ...values], { originTriple: origin, stdin, spawn: execute });
  expect(result.ok, JSON.stringify(result)).toBe(code === 0);
  expect(result.failedStep).toBe(code === 0 ? "none" : "remote-command-failed");
  if (!("stdout" in result)) throw new Error(JSON.stringify(result));
  expect(JSON.parse(result.stdout)).toEqual({ args: values, origin, stdin });
  expect(result.remoteExitCode).toBe(code);
}, 30000);
it.runIf(enabled && !!process.env.OPENRIG_TEST_SSH_RIG_ENTRY)("queries the actual remote rig version through the ordinary SSH executor without starting a daemon", async () => {
  const result = await runCrossHostCommand({ ...host(), rigPath: process.env.OPENRIG_TEST_SSH_RIG_ENTRY! }, ["rig", "--version"], { spawn: execute });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!("stdout" in result)) throw new Error(JSON.stringify(result));
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
}, 30000);
