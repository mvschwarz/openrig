import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { windowsAuthFile, writeWindowsOwnedText } from "../src/domain/windows-owned-text.js";
import { windowsDirectoryAccess } from "./helpers/directory-permissions.js";

it.runIf(process.platform === "win32")("copies synthetic auth through native private handles on long paths", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-native-long-"));
  const deep = join(root, ...Array.from({ length: 5 }, () => "native profile 用户 ".repeat(3)));
  mkdirSync(deep, { recursive: true });
  const source = join(deep, "source.json"), dest = join(deep, "saved.json");
  const bytes = '{"synthetic":"fixture-only"}\n';
  writeWindowsOwnedText(source, bytes);
  try {
    expect(source.length).toBeGreaterThan(260);
    expect(windowsAuthFile("auth-mode", source)).toBe("600");
    expect(Buffer.from(windowsAuthFile("auth-read", source), "base64").toString("utf8")).toBe(bytes);
    const stat = statSync(source, { bigint: true });
    windowsAuthFile("auth-copy", source, dest, { dev: stat.dev, ino: stat.ino });
    expect(readFileSync(dest, "utf8")).toBe(bytes);
    expect(windowsAuthFile("auth-mode", dest)).toBe("600");
    expect(() => windowsAuthFile("auth-copy", source, dest, { dev: stat.dev, ino: stat.ino + 1n })).toThrow();
    expect(readFileSync(dest, "utf8")).toBe(bytes);
    expect(readdirSync(deep).sort()).toEqual(["saved.json", "source.json"]);
    const profile = join(deep, "new-parent", "new-profile");
    windowsAuthFile("auth-directory", profile);
    const outside = join(root, "outside"); mkdirSync(outside);
    const beforeAcl = windowsDirectoryAccess(outside), redirected = join(deep, "redirected");
    symlinkSync(outside, redirected, "junction");
    expect(() => windowsAuthFile("auth-directory", redirected)).toThrow();
    expect(windowsDirectoryAccess(outside)).toBe(beforeAcl);
    expect(statSync(profile).isDirectory()).toBe(true);
    windowsAuthFile("auth-directory", profile);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
