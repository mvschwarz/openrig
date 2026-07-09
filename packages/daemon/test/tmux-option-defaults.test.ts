// OPR.0.4.6.02 S1 — unit coverage for the SHARED tmux option-defaults applier
// (used by NodeLauncher + SuccessorSessionLauncher) and the pure per-platform
// copy-command table. Scope-discipline teeth (guard b2): mouse/status are
// SESSION-scope (setSessionOption); set-clipboard/copy-command are SERVER-scope
// (setServerOption) — the two are never crossed.
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import {
  TmuxOptionDefaultsApplier,
  resolveCopyCommand,
} from "../src/domain/tmux-option-defaults.js";

const OK: TmuxResult = { ok: true };

function mockAdapter(overrides?: {
  setSessionOption?: (s: string, k: string, v: string) => Promise<TmuxResult>;
  setServerOption?: (o: string, v: string) => Promise<TmuxResult>;
}) {
  const setSessionOption = vi.fn(overrides?.setSessionOption ?? (async () => OK));
  const setServerOption = vi.fn(overrides?.setServerOption ?? (async () => OK));
  const adapter = { setSessionOption, setServerOption } as unknown as TmuxAdapter;
  return { adapter, setSessionOption, setServerOption };
}

describe("TmuxOptionDefaultsApplier", () => {
  it("sets mouse on + status off (default) on the given session via SESSION scope only", async () => {
    const { adapter, setSessionOption, setServerOption } = mockAdapter();
    // default reader (omitted) → statusBar false.
    const warnings = await new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "darwin", hasCommand: () => true })
      .applyToFreshSession("r01-dev1@rig");

    expect(warnings).toEqual([]);
    // mouse + status are SESSION-scope on the exact session name.
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "mouse", "on");
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "status", "off");
    // set-clipboard + copy-command are SERVER-scope — never via setSessionOption.
    const sessionKeys = setSessionOption.mock.calls.map((c) => c[1]);
    expect(sessionKeys).not.toContain("set-clipboard");
    expect(sessionKeys).not.toContain("copy-command");
    expect(setServerOption).toHaveBeenCalledWith("set-clipboard", "on");
  });

  it("sets status on when the config reader returns statusBar=true (future-launches read at apply)", async () => {
    const { adapter, setSessionOption } = mockAdapter();
    const applier = new TmuxOptionDefaultsApplier({
      tmuxAdapter: adapter,
      readTmuxOptionDefaults: () => ({ statusBar: true }),
      platform: "linux",
      hasCommand: () => false,
    });
    await applier.applyToFreshSession("r01-dev1@rig");
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "status", "on");
  });

  it("falls back to status off when the reader throws", async () => {
    const { adapter, setSessionOption } = mockAdapter();
    const applier = new TmuxOptionDefaultsApplier({
      tmuxAdapter: adapter,
      readTmuxOptionDefaults: () => { throw new Error("settings unavailable"); },
      platform: "darwin",
      hasCommand: () => false,
    });
    await applier.applyToFreshSession("r01-dev1@rig");
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "status", "off");
  });

  it("asserts server defaults ONCE per applier (memoized) but re-applies session opts every call", async () => {
    const { adapter, setSessionOption, setServerOption } = mockAdapter();
    const applier = new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "darwin", hasCommand: () => true });

    await applier.applyToFreshSession("sess-a");
    await applier.applyToFreshSession("sess-b");

    // set-clipboard asserted exactly once across both launches (shared memo).
    const clipCalls = setServerOption.mock.calls.filter((c) => c[0] === "set-clipboard");
    expect(clipCalls).toHaveLength(1);
    // but each fresh session still gets its own mouse+status.
    expect(setSessionOption).toHaveBeenCalledWith("sess-a", "mouse", "on");
    expect(setSessionOption).toHaveBeenCalledWith("sess-b", "mouse", "on");
  });

  it("darwin sets copy-command=pbcopy via SERVER scope", async () => {
    const { adapter, setServerOption } = mockAdapter();
    await new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "darwin" }).applyToFreshSession("s");
    expect(setServerOption).toHaveBeenCalledWith("copy-command", "pbcopy");
  });

  it("linux without wl-copy/xclip skips copy-command (falls back to set-clipboard OSC 52)", async () => {
    const { adapter, setServerOption } = mockAdapter();
    await new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "linux", hasCommand: () => false }).applyToFreshSession("s");
    const copyCalls = setServerOption.mock.calls.filter((c) => c[0] === "copy-command");
    expect(copyCalls).toHaveLength(0);
    // set-clipboard is still asserted.
    expect(setServerOption).toHaveBeenCalledWith("set-clipboard", "on");
  });

  it("collects non-fatal warnings when an option-set fails and never throws", async () => {
    const { adapter } = mockAdapter({
      setSessionOption: async (_s, k) =>
        k === "mouse" ? { ok: false, code: "unknown", message: "boom" } : OK,
      setServerOption: async (o) =>
        o === "set-clipboard" ? { ok: false, code: "unknown", message: "no server" } : OK,
    });
    const applier = new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "linux", hasCommand: () => false });
    const warnings = await applier.applyToFreshSession("sess-x");
    expect(warnings.some((w) => w.includes("mouse") && w.includes("boom"))).toBe(true);
    expect(warnings.some((w) => w.includes("set-clipboard") && w.includes("no server"))).toBe(true);
  });
});

describe("resolveCopyCommand (pure per-platform table)", () => {
  it("darwin → pbcopy", () => {
    expect(resolveCopyCommand("darwin", () => false)).toBe("pbcopy");
  });
  it("linux → wl-copy when present", () => {
    expect(resolveCopyCommand("linux", (b) => b === "wl-copy")).toBe("wl-copy");
  });
  it("linux → xclip when wl-copy absent but xclip present", () => {
    expect(resolveCopyCommand("linux", (b) => b === "xclip")).toBe("xclip -selection clipboard -i");
  });
  it("linux → null when neither present (OSC 52 fallback)", () => {
    expect(resolveCopyCommand("linux", () => false)).toBeNull();
  });
  it("other platforms → null", () => {
    expect(resolveCopyCommand("win32", () => true)).toBeNull();
  });
});
