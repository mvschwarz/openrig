import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SlowOpRecorder, SlowOpRecorderWriteError } from "../src/domain/slow-op-recorder.js";
import { expectPrivateFile } from "./helpers/private-file.js";

it.runIf(process.platform === "win32")("tightens an existing owned log before appending without losing its prior bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-log-upgrade-"));
  const file = path.join(root, "slow.jsonl"), prior = "synthetic prior bytes\n";
  fs.writeFileSync(file, prior);
  const recorder = new SlowOpRecorder({ logPath: file });
  try {
    recorder.recordMeasurement("synthetic.private-log", 300);
    await recorder.flush();
    expect(recorder.snapshot()).toMatchObject({ healthy: true });
    expect(fs.readFileSync(file, "utf8")).toMatch(/^synthetic prior bytes\n\{/);
    expectPrivateFile(file);
  } finally {
    await recorder.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(process.platform === "win32")("refuses a multiply-linked log without appending bytes or reporting a durable drain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-log-refusal-"));
  const file = path.join(root, "slow.jsonl"), prior = "synthetic prior bytes\n";
  fs.writeFileSync(file, prior);
  fs.linkSync(file, path.join(root, "other-link.jsonl"));
  const recorder = new SlowOpRecorder({ logPath: file });
  try {
    recorder.recordMeasurement("synthetic.private-log", 300);
    await expect(recorder.flush()).rejects.toBeInstanceOf(SlowOpRecorderWriteError);
    expect(recorder.snapshot()).toMatchObject({ healthy: false });
    expect(fs.readFileSync(file, "utf8")).toBe(prior);
  } finally {
    await recorder.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
