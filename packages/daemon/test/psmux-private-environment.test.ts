import { expect, it } from "vitest";
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
