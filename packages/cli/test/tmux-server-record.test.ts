import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecordedTmuxServerArgs } from "../src/tmux-attachment.js";
import { selectTmuxServer } from "../../daemon/src/domain/tmux-server-selection.js";

describe("offline tmux server selection", () => {
  let home: string;
  let file: string;
  let marker: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "t")); file = join(home, "tmux-server.json"); marker = join(home, "tmux-server.initialized"); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each([undefined, false])("ignores an advisory inherit socket, including an old isolated socket (pinned=%j)", pinned => {
    const socket = join(home, "stale inherited socket");
    writeFileSync(file, JSON.stringify({ version: 1, home: realpathSync(home), mode: "inherit",
      socketPath: socket, pinned, isolatedSocketPath: join(home, "previously-isolated") }));
    // Opt-out writes the advisory record before removing the old active marker.
    writeFileSync(marker, pinned === false ? "openrig-tmux-pinned-v1\n" : "1\n");
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
  });

  it("keeps legacy behavior when no daemon has written a server record", () => {
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
  });

  describe.each([false, true])("unreadable selection with active pin=%s", pinned => {
    it.each(["missing", "malformed", "invalid", "unreadable"])("handles a %s record without guessing a pinned socket", state => {
      writeFileSync(marker, pinned ? "openrig-tmux-pinned-v1\n" : "1\n");
      if (state === "malformed") writeFileSync(file, "{");
      if (state === "invalid") writeFileSync(file, JSON.stringify({ version: 2 }));
      if (state === "unreadable") mkdirSync(file);
      if (pinned) expect(() => readRecordedTmuxServerArgs(home)).toThrow(/tmux server record/);
      else expect(readRecordedTmuxServerArgs(home)).toEqual([]);
    });
  });

  it("does not guess whether an unreadable marker contains an active pin", () => {
    mkdirSync(marker);
    expect(() => readRecordedTmuxServerArgs(home)).toThrow("Cannot read the tmux server pin marker");
  });

  it("keeps legacy cleanup after a default inherit advisory record is lost", async () => {
    const selected = await selectTmuxServer({ home, mode: "inherit", registeredSessions: [], platform: "linux", uid: 1000,
      env: { TMUX: `${join(home, "inherited.sock")},1,0`, TMUX_TMPDIR: home } });
    expect(selected.serverArgs).toEqual(["-S", join(home, "inherited.sock")]);
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
    unlinkSync(file);
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
  });

  it.each(["isolated", "inherit"] as const)("pins cleanup for effective %s during an isolation request and refuses a lost record", async mode => {
    const selected = await selectTmuxServer({ home, mode: "isolated", registeredSessions: mode === "inherit" ? ["seat"] : [],
      platform: "linux", uid: 1000, env: { TMUX: `${join(home, "inherited.sock")},1,0`, TMUX_TMPDIR: home },
      inspect: async () => ({ state: "available", sessions: [{ name: "seat", home }] }) });
    expect(selected.mode).toBe(mode);
    expect(readRecordedTmuxServerArgs(home)).toEqual(selected.executionArgs);
    unlinkSync(file);
    expect(() => readRecordedTmuxServerArgs(home)).toThrow("Missing tmux server record");
  });

  it("releases the cleanup pin after an isolated server drains and inheritance resumes", async () => {
    const options = { home, registeredSessions: ["seat"], platform: "linux" as const, uid: 1000,
      env: { TMUX: `${join(home, "inherited.sock")},1,0`, TMUX_TMPDIR: home }, inspect: async () => ({ state: "absent" as const }) };
    await selectTmuxServer({ ...options, mode: "isolated" });
    const selected = await selectTmuxServer({ ...options, mode: "inherit" });
    expect(selected).toMatchObject({ mode: "inherit", executionArgs: [], migrationPending: false });
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    unlinkSync(file);
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
  });

  it("keeps a legacy isolated record pinned even without the newer marker", () => {
    const socket = join(home, "isolated.sock");
    writeFileSync(file, JSON.stringify({ version: 1, home: realpathSync(home), mode: "isolated", socketPath: socket }));
    expect(readRecordedTmuxServerArgs(home)).toEqual(["-S", socket]);
  });

  it.each([
    { version: 2 }, { home: "another-home" }, { mode: "unknown" }, { socketPath: "relative" }, { socketPath: "/bad\0socket" }, { pinned: false },
    { isolatedSocketPath: "relative" }, { isolatedSocketPath: "/bad\0socket" },
  ])("does not guess a server or overwrite an invalid record: %j", invalid => {
    const data = JSON.stringify({ version: 1, home: realpathSync(home), mode: "isolated", pinned: true, socketPath: join(home, "socket"), ...invalid });
    writeFileSync(file, data);
    expect(() => readRecordedTmuxServerArgs(home)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(data);
  });
});
