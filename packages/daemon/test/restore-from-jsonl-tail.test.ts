// restore-from-jsonl --tail-bytes N builds the packet from the transcript's last N bytes. The PreCompact hook asks for it
// when a transcript is too large to read whole inside its 30 s budget, and the packet says what it covers.
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "plugins", "openrig-core", "skills",
  "claude-compaction-restore", "scripts", "restore-from-jsonl.mjs");
const PACKET_FILES = ["transcript.txt", "transcript-narrative.txt", "touched-files.md", "restore-instructions.md", "restore-summary.json"];

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Ten one-line turns of equal length, so a cut can be placed inside a line or exactly at its start. */
function transcript(): { dir: string; file: string; lineBytes: number } {
  const dir = mkdtempSync(join(tmpdir(), "restore-tail-")); dirs.push(dir);
  const file = join(dir, "tail.jsonl");
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({
    type: "user", sessionId: "tail-fixture", timestamp: `2026-11-20T00:00:0${i}Z`, message: { role: "user", content: `turn ${i}` },
  }));
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { dir, file, lineBytes: Buffer.byteLength(`${lines[0]}\n`) };
}

function packet(file: string, dir: string, out: string, ...extra: string[]): string {
  const result = spawnSync(process.execPath, [SCRIPT, "--out", join(dir, out), "--cwd", dir, "--json", ...extra, file],
    { encoding: "utf8", env: { ...process.env, OPENRIG_TEST_CLOCK_NOW: "2026-11-20T06:00:00.000Z" } });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as { outputDir: string }).outputDir;
}

describe("restore-from-jsonl --tail-bytes", () => {
  it("builds the packet from the last N bytes, skips the line the cut falls in, and says what it covers", () => {
    const { dir, file, lineBytes } = transcript();
    const size = statSync(file).size;
    const tail = 3 * lineBytes + 5; // 5 bytes into the line before the last three
    const out = packet(file, dir, "packets", "--tail-bytes", String(tail));
    const summary = JSON.parse(readFileSync(join(out, "restore-summary.json"), "utf8")) as { records: number; coverage: unknown };
    expect(summary.records).toBe(3);
    expect(summary.coverage).toEqual({ fromByte: size - tail, bytes: tail, firstTimestamp: "2026-11-20T00:00:07Z" });
    expect(readFileSync(join(out, "transcript-narrative.txt"), "utf8")).toBe("\n## user\n\nturn 7\n\n## user\n\nturn 8\n\n## user\n\nturn 9");
    expect(readFileSync(join(out, "restore-instructions.md"), "utf8")).toContain(
      `- **Coverage: this packet is built from the JSONL's last ${tail} bytes only** (from byte ${size - tail}, first timed record at 2026-11-20T00:00:07Z).`);
  });

  it("keeps the first line whole when the cut falls at a line start", () => {
    const { dir, file, lineBytes } = transcript();
    const out = packet(file, dir, "packets", "--tail-bytes", String(3 * lineBytes));
    expect((JSON.parse(readFileSync(join(out, "restore-summary.json"), "utf8")) as { records: number }).records).toBe(3);
    expect(readFileSync(join(out, "transcript-narrative.txt"), "utf8").startsWith("\n## user\n\nturn 7\n")).toBe(true);
  });

  it("gives the whole-session packet, byte for byte, when N is at least the transcript's size", () => {
    const { dir, file } = transcript();
    const whole = packet(file, dir, "whole");
    const tailed = packet(file, dir, "tailed", "--tail-bytes", String(statSync(file).size));
    for (const name of PACKET_FILES) {
      expect(readFileSync(join(tailed, name), "utf8").replaceAll(join(dir, "tailed"), "OUT"), name)
        .toBe(readFileSync(join(whole, name), "utf8").replaceAll(join(dir, "whole"), "OUT"));
    }
    expect(readdirSync(join(dir, "tailed"))).toEqual(readdirSync(join(dir, "whole")));
  });

  it("ends the tail at the size it recorded, so turns appended while it reads stay out of the packet and its coverage", () => {
    const { dir, file, lineBytes } = transcript();
    const size = statSync(file).size;
    const tail = 3 * lineBytes + 5;
    const appended = [10, 11].map((i) => `${JSON.stringify({
      type: "user", sessionId: "tail-fixture", timestamp: `2026-11-20T00:00:${i}Z`, message: { role: "user", content: `turn ${i}` },
    })}\n`).join("");
    // The preload appends two turns right after the script records the transcript's size, before its read starts.
    const preload = join(dir, "append-after-stat.mjs");
    writeFileSync(preload, [
      'import fs from "node:fs";',
      "const statSync = fs.statSync;",
      "let done = false;",
      "fs.statSync = (target, ...rest) => {",
      "  const stat = statSync(target, ...rest);",
      `  if (!done && target === ${JSON.stringify(file)}) {`,
      "    done = true;",
      `    fs.appendFileSync(target, ${JSON.stringify(appended)});`,
      "  }",
      "  return stat;",
      "};",
    ].join("\n"));
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, SCRIPT, "--out", join(dir, "packets"),
      "--cwd", dir, "--json", "--tail-bytes", String(tail), file],
    { encoding: "utf8", env: { ...process.env, OPENRIG_TEST_CLOCK_NOW: "2026-11-20T06:00:00.000Z" } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(statSync(file).size).toBe(size + Buffer.byteLength(appended));
    const out = (JSON.parse(result.stdout) as { outputDir: string }).outputDir;
    const summary = JSON.parse(readFileSync(join(out, "restore-summary.json"), "utf8")) as { records: number; coverage: unknown };
    expect(summary.records).toBe(3);
    expect(summary.coverage).toEqual({ fromByte: size - tail, bytes: tail, firstTimestamp: "2026-11-20T00:00:07Z" });
    expect(readFileSync(join(out, "transcript-narrative.txt"), "utf8")).toBe("\n## user\n\nturn 7\n\n## user\n\nturn 8\n\n## user\n\nturn 9");
  });
});
