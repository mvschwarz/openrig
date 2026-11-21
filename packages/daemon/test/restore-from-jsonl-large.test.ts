// restore-from-jsonl reads the transcript a line at a time. A long-lived Claude seat's JSONL runs past the longest string
// Node can make (buffer.constants.MAX_STRING_LENGTH, about 512 MB), and a whole-file read there produced no packet at all,
// so managed compaction went without one too. The large transcript here is generated, not a real one.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:buffer";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "plugins", "openrig-core", "skills",
  "claude-compaction-restore", "scripts", "restore-from-jsonl.mjs");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(file: string, out: string, cwd: string) {
  const result = spawnSync(process.execPath, [SCRIPT, "--out", out, "--cwd", cwd, "--json", file],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OPENRIG_TEST_CLOCK_NOW: "2026-11-20T06:00:00.000Z" } });
  return { ...result, packet: result.status === 0 ? JSON.parse(result.stdout) as { outputDir: string; narrative: string; transcript: string } : null };
}

describe("restore-from-jsonl reads the transcript a line at a time", () => {
  it("produces a packet from a transcript past the longest string Node can make", () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-large-")); dirs.push(dir);
    const file = join(dir, "large.jsonl");
    const fd = openSync(file, "w");
    const line = (record: unknown) => `${JSON.stringify(record)}\n`;
    let bytes = 0;
    let records = 0;
    const write = (text: string) => { bytes += writeSync(fd, text); records += 1; };
    write(line({ type: "user", sessionId: "large-fixture", cwd: dir, message: { role: "user", content: "Resume the large-transcript fixture." } }));
    // About 1 MiB of tool output per line, with spaces, so no run of it reads as base64. Each is truncated in the packet.
    const output = "build output ".repeat(80_000);
    for (let i = 0; bytes <= constants.MAX_STRING_LENGTH + 8 * 1024 * 1024; i += 1) {
      write(line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: output }] } }));
      if (i % 100 === 0) write(line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Checkpoint ${i}.` }] } }));
    }
    write(line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The last turn, past the string limit." }] } }));
    closeSync(fd);
    expect(statSync(file).size).toBeGreaterThan(constants.MAX_STRING_LENGTH);

    const out = join(dir, "packets");
    const result = run(file, out, dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const summary = JSON.parse(readFileSync(join(result.packet!.outputDir, "restore-summary.json"), "utf8")) as { sessionId: string; records: number };
    expect(summary).toMatchObject({ sessionId: "large-fixture", records });
    const narrative = readFileSync(result.packet!.narrative, "utf8");
    expect(narrative.startsWith("\n## user\n\nResume the large-transcript fixture.")).toBe(true);
    expect(narrative.trimEnd().endsWith("The last turn, past the string limit.")).toBe(true);
    // The tool output is truncated as before, so the packet is far smaller than the transcript.
    expect(statSync(result.packet!.transcript).size).toBeLessThan(statSync(file).size / 50);
    expect(readdirSync(out)).toEqual([`large-fixture-2026-11-20T06-00-00-000Z`]);
  }, 300_000);

  it("counts records as before: blank lines skipped, CRLF line ends read, an unreadable line kept as a record", () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-lines-")); dirs.push(dir);
    const file = join(dir, "lines.jsonl");
    const turn = (role: string, text: string) => JSON.stringify({ sessionId: "lines-fixture", message: { role, content: text } });
    writeFileSync(file, `${turn("user", "first")}\r\n\r\n${turn("assistant", "second")}\nnot json\n\n${turn("user", "third")}\n`);
    const out = join(dir, "packets");
    const result = run(file, out, dir);
    expect(result.status).toBe(0);
    const summary = JSON.parse(readFileSync(join(result.packet!.outputDir, "restore-summary.json"), "utf8")) as { records: number };
    expect(summary.records).toBe(4);
    expect(readFileSync(result.packet!.narrative, "utf8")).toBe("\n## user\n\nfirst\n\n## assistant\n\nsecond\n\n## user\n\nthird");
    expect(existsSync(join(out, `lines-fixture-2026-11-20T06-00-00-000Z`, "transcript.txt"))).toBe(true);
    expect(readdirSync(out).filter(entry => entry.startsWith(".partial-"))).toEqual([]);
  });

  // SIGTERM is the PreCompact hook's time limit; SIGINT is a person's Ctrl-C on the manual route.
  it.each([["SIGTERM", 143], ["SIGINT", 130]] as const)("removes its staging folder when %s stops it part way, exiting %i", async (signal, code) => {
    const dir = mkdtempSync(join(tmpdir(), "restore-stop-")); dirs.push(dir);
    const file = join(dir, "stop.jsonl");
    // About 64 MB, so the script is still reading when it's stopped.
    const output = "build output ".repeat(80_000);
    const fd = openSync(file, "w");
    writeSync(fd, `${JSON.stringify({ type: "user", sessionId: "stop-fixture", message: { role: "user", content: "Start." } })}\n`);
    for (let i = 0; i < 64; i += 1) {
      writeSync(fd, `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: output }] } })}\n`);
    }
    closeSync(fd);
    const out = join(dir, "packets");
    const child = spawn(process.execPath, [SCRIPT, "--out", out, "--cwd", dir, "--json", file], { stdio: "ignore" });
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    const staged = () => existsSync(out) && readdirSync(out).some((entry) => entry.startsWith(".partial-"));
    for (let i = 0; i < 2_000 && !staged(); i += 1) await new Promise((wait) => setTimeout(wait, 5));
    expect(staged()).toBe(true);
    child.kill(signal);
    expect(await exited).toBe(code);
    expect(readdirSync(out)).toEqual([]);
  });
});
