import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: run }));
import { defaultSend } from "../src/commands/heartbeat.js";

it.runIf(process.platform === "win32")("reproduces execFile refusing an owned npm-style cmd entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-cmd-"));
  const command = join(root, "rig.cmd"), marker = join(root, "executed.txt");
  writeFileSync(command, `@echo unexpected>"${marker}"\r\n`);
  try {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const error = await new Promise<Error | null>(resolve => {
      try { actual.execFile(command, ["send", "owned-seat", "inert"], { timeout: 1000 }, error => resolve(error)); }
      catch (error) { resolve(error as Error); }
    });
    expect(error).toMatchObject({ code: "EINVAL" });
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true }); }
});

it.runIf(process.platform === "win32")("uses the paired Node CLI for native nudges without interpreting message syntax", async () => {
  run.mockImplementation((_command, _args, _options, callback) => callback(null, "sent\r\n", ""));
  const text = "owned 用户 & %PATH% !literal! \"quoted\"\r\nsecond line";
  expect(await defaultSend("owned-seat", text)).toEqual({ ok: true, message: "sent" });
  expect(run).toHaveBeenLastCalledWith(process.execPath,
    [fileURLToPath(new URL("../src/index.js", import.meta.url)), "send", "owned-seat", text],
    { timeout: 10_000 }, expect.any(Function));
  run.mockImplementation((_command, _args, _options, callback) => callback(new Error("owned failure"), "", "exact failure\r\n"));
  expect(await defaultSend("owned-seat", text)).toEqual({ ok: false, message: "exact failure" });
});
