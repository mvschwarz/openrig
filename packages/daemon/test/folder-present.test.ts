// A seat folder reads as missing only on a confirmed absence: nothing at the path, a file on the way to it, or a file in
// its place. A permission or I/O error reads as present, so delivery still attempts the write and reports its own
// outcome. This is the check the daemon gives the Claude adapter and the restore. The real filesystem covers what a test
// can cause; a stat stub covers the errors it can't cause reliably.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderPresent } from "../src/domain/cwd-resolution.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root)) fs.chmodSync(path.join(root, entry), 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const tmp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-present-")); roots.push(root); return root; };

describe("folderPresent: only a confirmed absence reads as missing", () => {
  it("reads a folder as present, and nothing there, a file on the way or a file in its place as missing", () => {
    const root = tmp();
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "");
    expect(folderPresent(root)).toBe(true);
    expect(folderPresent(path.join(root, "absent"))).toBe(false);
    expect(folderPresent(path.join(file, "sub"))).toBe(false);
    expect(folderPresent(file)).toBe(false);
  });

  it.each(["EACCES", "EPERM", "EIO"])("reads a %s failure to look as present", (code) => {
    expect(folderPresent("/any", () => { throw Object.assign(new Error(code), { code }); })).toBe(true);
  });

  it("reads a folder behind a parent it can't search as present", () => {
    if (process.getuid?.() === 0) return; // root searches any folder, so there is no permission error to read
    const root = tmp();
    const locked = path.join(root, "locked");
    fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    expect(() => fs.statSync(path.join(locked, "inner"))).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(folderPresent(path.join(locked, "inner"))).toBe(true);
  });
});
