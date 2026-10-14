import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecordedTmuxServerArgs } from "../src/tmux-attachment.js";
import { selectTmuxServer } from "../../daemon/src/domain/tmux-server-selection.js";

describe("offline tmux server selection", () => {
  let home: string;
  let file: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "t")); file = join(home, "tmux-server.json"); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("uses the last effective socket even if a different isolated socket was used earlier", () => {
    const socket = join(home, "inherited socket");
    writeFileSync(file, JSON.stringify({ version: 1, home: realpathSync(home), mode: "inherit",
      socketPath: socket, isolatedSocketPath: join(home, "previously-isolated") }));
    expect(readRecordedTmuxServerArgs(home)).toEqual(["-S", socket]);
  });

  it("keeps legacy behavior when no daemon has written a server record", () => {
    expect(readRecordedTmuxServerArgs(home)).toEqual([]);
  });

  it.each(["inherit", "isolated"] as const)("refuses a missing record after the daemon selected %s", async mode => {
    const selected = await selectTmuxServer({ home, mode, registeredSessions: [], platform: "linux", uid: 1000,
      env: { TMUX: `${join(home, "inherited.sock")},1,0`, TMUX_TMPDIR: home } });
    expect(readRecordedTmuxServerArgs(home)).toEqual(selected.serverArgs);
    unlinkSync(file);
    expect(() => readRecordedTmuxServerArgs(home)).toThrow("Missing tmux server record");
  });

  it.each([
    { version: 2 }, { home: "another-home" }, { mode: "unknown" }, { socketPath: "relative" }, { socketPath: "/bad\0socket" },
  ])("does not guess a server or overwrite an invalid record: %j", invalid => {
    const data = JSON.stringify({ version: 1, home: realpathSync(home), mode: "isolated", socketPath: join(home, "socket"), ...invalid });
    writeFileSync(file, data);
    expect(() => readRecordedTmuxServerArgs(home)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(data);
  });
});
