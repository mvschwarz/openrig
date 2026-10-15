import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";

const ENV = { OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-private-token" };
const launch = (adapter: TmuxAdapter, action: "create" | "respawn") => action === "create"
  ? adapter.createSession("seat", undefined, ENV)
  : adapter.respawnPane("%1", undefined, { env: ENV });

function fixture(run: () => Promise<string> = async () => "%1\n") {
  const files: TmuxFileOps = {
    tmpName: () => "/private/fixture.conf",
    bufferName: () => "unused",
    writeFile: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
  };
  const commands: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("unused shell"); }, files, async argv => {
    commands.push(argv);
    return argv.includes("source-file") ? run() : "";
  });
  return { adapter, files, commands };
}

describe("private tmux environment file lifetime", () => {
  for (const action of ["create", "respawn"] as const) {
    it(`${action}: retains the exclusive, owner-only file until tmux finishes reading it`, async () => {
      let finish!: (output: string) => void;
      const f = fixture(() => new Promise(resolve => { finish = resolve; }));
      const result = launch(f.adapter, action);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(f.files.writeFile).toHaveBeenCalledWith("/private/fixture.conf", expect.stringContaining(ENV.OPENRIG_ACTIVITY_HOOK_TOKEN), { mode: 0o600, flag: "wx" });
      expect(f.files.unlink).not.toHaveBeenCalled();
      expect(f.commands.flat().join(" ")).not.toContain(ENV.OPENRIG_ACTIVITY_HOOK_TOKEN);
      finish("%1\n");
      expect(await result).toEqual({ ok: true });
      expect(f.files.unlink).toHaveBeenCalledExactlyOnceWith("/private/fixture.conf");
    });

    it(`${action}: removes its file on a tmux failure and preserves error classification`, async () => {
      const f = fixture(async () => { throw new Error("can't find session: seat"); });
      expect(await launch(f.adapter, action)).toMatchObject({ ok: false, code: "session_not_found" });
      expect(f.files.unlink).toHaveBeenCalledExactlyOnceWith("/private/fixture.conf");
    });

    it(`${action}: a file collision neither launches nor unlinks someone else's file`, async () => {
      const f = fixture();
      vi.mocked(f.files.writeFile).mockRejectedValueOnce(Object.assign(new Error("already exists"), { code: "EEXIST" }));
      expect(await launch(f.adapter, action)).toMatchObject({ ok: false });
      expect(f.commands.some(argv => argv.includes("source-file") || argv.includes("new-session") || argv.includes("respawn-pane"))).toBe(false);
      expect(f.files.unlink).not.toHaveBeenCalled();
    });

    it(`${action}: retries a transient cleanup failure without reporting a leftover file`, async () => {
      const f = fixture();
      vi.mocked(f.files.unlink).mockRejectedValueOnce(new Error("temporarily busy"));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await launch(f.adapter, action)).toEqual({ ok: true });
        expect(f.files.unlink).toHaveBeenCalledTimes(2);
        expect(warning).not.toHaveBeenCalled();
      } finally { warning.mockRestore(); }
    });

    it(`${action}: an already removed file needs no retry or warning`, async () => {
      const f = fixture();
      vi.mocked(f.files.unlink).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await launch(f.adapter, action)).toEqual({ ok: true });
        expect(f.files.unlink).toHaveBeenCalledTimes(1);
        expect(warning).not.toHaveBeenCalled();
      } finally { warning.mockRestore(); }
    });

    it.each([false, true])(`${action}: persistent cleanup failure reports only the path and preserves the command result (tmux fails: %s)`, async tmuxFails => {
      const f = fixture(async () => {
        if (tmuxFails) throw new Error("can't find session: seat");
        return "%1\n";
      });
      vi.mocked(f.files.unlink).mockRejectedValue(new Error(ENV.OPENRIG_ACTIVITY_HOOK_TOKEN));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await launch(f.adapter, action)).toMatchObject(tmuxFails ? { ok: false, code: "session_not_found" } : { ok: true });
        expect(f.files.unlink).toHaveBeenCalledTimes(2);
        expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/private/fixture.conf"));
        expect(warning.mock.calls.flat().join(" ")).not.toContain(ENV.OPENRIG_ACTIVITY_HOOK_TOKEN);
      } finally { warning.mockRestore(); }
    });
  }

  it("rejects a NUL argument before writing a truncated tmux command", async () => {
    const f = fixture();
    expect(await f.adapter.createSession("seat", undefined, { TOKEN: "before\0after" })).toMatchObject({ ok: false, message: "tmux arguments must not contain NUL bytes." });
    expect(f.files.writeFile).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });
});
