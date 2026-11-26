import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { checkLocalPath, parseFilePathArg } from "../src/lib/file-transfer.js";

describe.skipIf(process.platform !== "win32")("native Windows file operands", () => {
  it("keeps drive, UNC and backslash escapes local without consulting hosts", () => {
    for (const operand of ["C:\\docs\\file", "D:/docs/file", "C:relative", "\\\\server\\share\\file", ".\\notes:v2", "..\\notes:v2"]) {
      expect(parseFilePathArg(operand, () => { throw new Error("unexpected host lookup"); }))
        .toEqual({ ok: true, arg: { kind: "local", path: operand } });
    }
    expect(parseFilePathArg("server:/srv/file")).toMatchObject({ ok: true, arg: { kind: "remote", hostId: "server" } });
  });

  it("denies credential directories regardless of path casing or tilde separator", () => {
    for (const directory of [".SSH", ".CODEX", ".CLAUDE", ".OPENRIG"]) {
      expect(checkLocalPath(path.join(os.homedir().toUpperCase(), directory, "file")).ok).toBe(false);
      expect(checkLocalPath(`~\\${directory}\\file`).ok).toBe(false);
    }
  });

  it("retains directory contents semantics for either Windows separator", () => {
    const directory = path.join(os.tmpdir(), "openrig-transfer-path");
    for (const operand of [directory + "\\", directory.replaceAll("\\", "/") + "/"]) {
      expect(checkLocalPath(operand)).toEqual({ ok: true, normalizedPath: directory + path.sep });
    }
  });
});
