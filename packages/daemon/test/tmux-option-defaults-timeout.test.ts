import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
beforeEach(() => { execute.mockReset(); });

describe("clipboard discovery deadline", () => {
  it.each([null, "custom-copy"])("warns and retries a killed default probe, preserving %j", async initial => {
    let copyCommand = initial;
    const setServerOption = vi.fn(async (name: string, value: string) => {
      if (name === "copy-command") copyCommand = value;
      return { ok: true };
    });
    const adapter = { setSessionOption: async () => ({ ok: true }), setServerOption } as unknown as TmuxAdapter;
    execute.mockImplementationOnce((_file, _args, options, callback) => {
      expect(options).toMatchObject({ timeout: 250, killSignal: "SIGKILL" });
      callback(Object.assign(new Error("probe deadline"), { killed: true }));
    }).mockImplementationOnce((_file, _args, _options, callback) => callback(null));
    const applier = new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "linux" });
    const warnings = await applier.applyToFreshSession("first@test");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/clipboard.*250 ms/i);
    expect(warnings[0]).toMatch(/retry/i);
    expect(copyCommand).toBe(initial);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await applier.applyToFreshSession("next@test")).toEqual([]);
    expect(copyCommand).toBe("wl-copy");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await applier.applyToFreshSession("later@test")).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("memoizes confirmed absence without a deadline warning", async () => {
    execute.mockImplementation((_file, _args, _options, callback) => callback(Object.assign(new Error("absent"), { code: 1 })));
    const setServerOption = vi.fn(async () => ({ ok: true }));
    const adapter = { setSessionOption: async () => ({ ok: true }), setServerOption } as unknown as TmuxAdapter;
    const applier = new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "linux" });
    expect(await applier.applyToFreshSession("first@test")).toEqual([]);
    expect(await applier.applyToFreshSession("next@test")).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(setServerOption).not.toHaveBeenCalledWith("copy-command", expect.anything());
  });
});
