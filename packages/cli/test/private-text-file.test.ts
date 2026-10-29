import { afterEach, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateTextFile } from "../src/lib/private-text-file.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), "openrig-private-text-"));
  directories.push(directory);
  return join(directory, "owned ' 中文.json");
}

describe("private staging files", () => {
  it("writes exact UTF-8 bytes and retains private access after publication", () => {
    const staging = file(), content = "synthetic ' 中文\r\n\u0000\n";
    createPrivateTextFile(staging, content);
    expect(readFileSync(staging, "utf8")).toBe(content);
    expectPrivateFile(staging);
    const published = staging + ".published";
    renameSync(staging, published);
    expectPrivateFile(published);
    expect(readFileSync(published, "utf8")).toBe(content);
  });
  it("refuses an existing target without truncating its bytes", () => {
    const target = file();
    writeFileSync(target, "preserve");
    expect(() => createPrivateTextFile(target, "replacement")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("preserve");
  });
  it("refuses a hard-linked staging path without modifying the other name", () => {
    const target = file(), linked = target + ".link";
    writeFileSync(target, "other name must survive");
    linkSync(target, linked);
    expect(() => createPrivateTextFile(linked, "replacement")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("other name must survive");
    expect(readFileSync(linked, "utf8")).toBe("other name must survive");
  });
});
