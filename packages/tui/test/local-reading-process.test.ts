import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocal } from "../src/local-reading.js";

it("runs the paired local reader with literal native request data and surfaces child failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "local reader process-"));
  try {
    const dir = join(root, "配套 CLI with spaces"); mkdirSync(dir);
    const entry = join(dir, "index.js"), reader = join(dir, "local-reading.js");
    writeFileSync(entry, "throw Error('CLI main must not execute');");
    const request = { op: "read" as const, root: "owned root", path: "docs\\quote' ; $env:NOT_EXECUTED 中文.md" };
    writeFileSync(reader, "const r=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify({content:JSON.stringify(r)}));");
    const result = await readLocal(entry, request);
    expect(JSON.parse(result.content!)).toEqual(request);
    writeFileSync(reader, "process.stdout.write('invalid json');");
    expect(await readLocal(entry, request)).toEqual({ error: "Local reader returned invalid data" });
    writeFileSync(reader, "process.stderr.write('owned reader failure');process.exitCode=7;");
    expect(await readLocal(entry, request)).toMatchObject({ error: "Local reader did not complete", message: expect.stringContaining("owned reader failure") });
    expect(await readLocal(undefined, request)).toMatchObject({ error: expect.stringContaining("Local reader unavailable") });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("bounds a stalled paired reader and waits for its direct child to exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "local reader deadline-"));
  try {
    const entry = join(root, "index.js"), reader = join(root, "local-reading.js"), pidFile = join(root, "owned-child.pid");
    writeFileSync(reader, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
    const started = Date.now();
    expect(await readLocal(entry, { op: "roots" })).toMatchObject({ error: "Local reader did not complete" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    // Observation only: never kill a PID recovered from a file.
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
