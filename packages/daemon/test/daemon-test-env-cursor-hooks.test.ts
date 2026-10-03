// The daemon suite must never touch the operator's real ~/.cursor. The shared setup file points
// OPENRIG_CURSOR_HOME at a fresh temp dir, so createDaemon's Cursor hooks setup runs against that.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";

describe("daemon test environment", () => {
  it("points the Cursor home at a temp dir, not the real ~/.cursor", () => {
    const home = process.env.OPENRIG_CURSOR_HOME;
    expect(home).toBeTruthy();
    expect(path.isAbsolute(home!)).toBe(true);
    expect(home!.startsWith(os.tmpdir())).toBe(true);
    expect(path.resolve(home!)).not.toBe(path.resolve(os.homedir(), ".cursor"));
  });
});
