import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChannelCoverageStore, DeadLetterStore, ThreadCoverageStore } from "../src/domain/gateway/slack/state-store.js";

it.skipIf(process.platform !== "win32")("replaces Slack state with a valid 253-character native filename", () => {
  const root = mkdtempSync(join(tmpdir(), "rig-slack-name-"));
  try {
    const file = join(root, "s".repeat(247) + ".jsonl");
    const dead = new DeadLetterStore<{ value: number }>(file);
    dead.append({ value: 1 }, 1);
    const original = dead.readAll();
    dead.replaceAll(original);
    expect(new DeadLetterStore(file).readAll()).toEqual(original);
    dead.replaceAll([]);
    expect(dead.readAll()).toEqual([]);
    const channel = new ChannelCoverageStore(file);
    // Each store normally has its own file; remove only this owned fixture
    // before exercising the next on-disk format with the same filename limit.
    rmSync(file);
    const coverage = { coverageStart: "100.000001", coveredThrough: "101.000001", seedBasis: "feature-adoption" as const };
    channel.save("C-owned", coverage);
    channel.save("C-owned", { ...coverage, coveredThrough: "102.000001" });
    expect(new ChannelCoverageStore(file).all()["C-owned"]?.coveredThrough).toBe("102.000001");
    rmSync(file);
    const thread = new ThreadCoverageStore(file);
    thread.save("C-owned:100.000001", coverage);
    thread.save("C-owned:100.000001", { ...coverage, coveredThrough: "103.000001" });
    expect(new ThreadCoverageStore(file).read()["C-owned:100.000001"]?.coveredThrough).toBe("103.000001");
    expect(readdirSync(root)).toEqual(["s".repeat(247) + ".jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
