import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appendWindowsPrivateText, readWindowsOwnedText, readWindowsRegularText, writeWindowsOwnedText } from "../src/domain/windows-owned-text.js";

it.runIf(process.platform === "win32")("retains bounded owned reads and private writes beyond MAX_PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "owned-text-long-"));
  const deep = join(root, ...Array.from({ length: 5 }, () => "原生 long directory ".repeat(3)));
  mkdirSync(deep, { recursive: true });
  const file = join(deep, "settings.json");
  writeFileSync(file, "synthetic original");
  try {
    expect(file.length).toBeGreaterThan(260);
    expect(readWindowsRegularText(file, 100)).toBe("synthetic original");
    expect(readWindowsOwnedText(file, 100)).toBe("synthetic original");
    expect(() => readWindowsOwnedText(file, 2)).toThrow();
    writeWindowsOwnedText(file, "replacement");
    expect(readFileSync(file, "utf8")).toBe("replacement");
    const log = join(deep, "receipt.jsonl");
    appendWindowsPrivateText(log, "first\n"); appendWindowsPrivateText(log, "second\n");
    expect(readFileSync(log, "utf8")).toBe("first\nsecond\n");
    linkSync(file, join(deep, "another-link"));
    expect(() => writeWindowsOwnedText(file, "must not replace")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("replacement");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
