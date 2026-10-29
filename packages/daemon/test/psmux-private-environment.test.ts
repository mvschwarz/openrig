import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { psmuxPrivateEnvironmentLine } from "../src/adapters/windows-private-config.js";

it("keeps update values out of argv and retains a file after an uncertain command", async () => {
  const calls: string[][] = [], content: string[] = [];
  let disposed = 0, fail = false;
  const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, {
    writeFile: async () => {}, unlink: async () => {}, tmpName: () => "unused", bufferName: () => "unused",
    privateConfig: async text => { content.push(text); return { path: "C:/owned/private.conf", dispose: async () => { disposed++; } }; },
  }, async argv => { calls.push(argv); if (fail) throw new Error("uncertain source call"); return ""; }, "psmux");
  await adapter.setSessionEnv("selected", "SYNTHETIC", "synthetic-secret\n#{session_name}");
  expect(calls).toEqual([["tmux", "source-file", "-t", "=selected", "C:/owned/private.conf"]]);
  expect(content[0]).toContain("synthetic-secret#{T:#{l:%n}}##{session_name}");
  expect(disposed).toBe(1);
  fail = true;
  await expect(adapter.setSessionEnv("selected", "SYNTHETIC", "different-synthetic-secret")).rejects.toThrow("uncertain");
  expect(disposed).toBe(1);
  expect(calls.flat().some(value => value.includes("synthetic-secret"))).toBe(false);
  expect(() => psmuxPrivateEnvironmentLine("GOOD", "bad\0value")).toThrow();
});

it("does not fall back to argv when protected file creation fails", async () => {
  const calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, {
    writeFile: async () => {}, unlink: async () => {}, tmpName: () => "unused", bufferName: () => "unused",
    privateConfig: async () => { throw new Error("DACL unavailable"); },
  }, async argv => { calls.push(argv); return ""; }, "psmux");
  await expect(adapter.setSessionEnv("selected", "SYNTHETIC", "synthetic-secret")).rejects.toThrow("DACL");
  expect(calls).toEqual([]);
});

describe.skipIf(process.platform !== "win32" || !process.env.OPENRIG_TEST_PSMUX)("native psmux private environment update", () => {
  it("preserves exact values in only the selected session", async () => {
    const namespace = `openrig-private-env-${randomUUID()}`;
    const exec = promisify(execFile), calls: string[][] = [];
    const invoke = async (argv: string[]) => {
      calls.push(argv);
      return (await exec(process.env.OPENRIG_TEST_PSMUX!, ["-L", namespace, ...argv.slice(1)], { encoding: "utf8", windowsHide: true, timeout: 5000 })).stdout;
    };
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, undefined, invoke, "psmux");
    const key = "OPENRIG_SYNTHETIC_PRIVATE", values = ["", "SYNTHETIC two words", "SYNTHETIC\n\nline\n", "SYNTHETIC CR\rLF\r\nTab\tEOF\r", 'SYNTHETIC 日本語🙂 " \\ $ # #{session_name} %n %t %S; #(echo unsafe)'];
    try {
      await invoke(["tmux", "new-session", "-d", "-s", "first"]);
      await invoke(["tmux", "new-session", "-d", "-s", "second"]);
      for (const value of values) {
        await adapter.setSessionEnv("second", key, value);
        expect(await invoke(["tmux", "show-environment", "-t", "=second", key])).toBe(`${key}=${value}\n`);
      }
      expect(await invoke(["tmux", "show-environment", "-t", "=first"])).not.toContain(key + "=");
      expect(calls.flat().some(arg => arg.includes("SYNTHETIC two") || arg.includes("SYNTHETIC 日本語"))).toBe(false);
    } finally { await invoke(["tmux", "kill-server"]); }
  }, 20000);
});
