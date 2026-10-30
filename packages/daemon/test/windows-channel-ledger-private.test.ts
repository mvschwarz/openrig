import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChannelOperation } from "../src/domain/gateway/channel-operations.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const actor = { actor: "synthetic@fixture", provenance: "transport:v1" as const, reason: "Synthetic 中文\nreason", action: "configure" as const, subject: "fixture", before: { enabled: false } };

it.runIf(process.platform === "win32")("keeps native lifecycle receipts private and ordered before effects, including prior bytes and concurrent calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-channel-ledger-"));
  const dir = path.join(root, "state"), file = path.join(dir, "human-channel-operations.jsonl");
  fs.mkdirSync(dir); const prior = '{"syntheticLegacy":true}\n'; fs.writeFileSync(file, prior);
  try {
    const result = await runChannelOperation({ ...actor, run: async () => {
      expectPrivateFile(file);
      expect(JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)!)).toMatchObject({ effect: "started", reason: actor.reason });
      return { value: "SYNTHETIC_RESPONSE_BODY", after: { enabled: true }, effect: "applied" };
    } }, root);
    expect(result.value).toBe("SYNTHETIC_RESPONSE_BODY");
    await Promise.all([1, 2, 3].map(index => runChannelOperation({ ...actor, subject: `fixture-${index}`, run: async () => ({ value: index, after: {}, effect: "no-op" }) }, root)));
    await expect(runChannelOperation({ ...actor, run: async () => { throw new Error("synthetic effect failure"); } }, root)).rejects.toThrow("synthetic effect failure");
    const bytes = fs.readFileSync(file, "utf8"); expect(bytes.startsWith(prior)).toBe(true);
    expect(bytes).not.toContain("SYNTHETIC_RESPONSE_BODY");
    const rows = bytes.trim().split("\n").slice(1).map(line => JSON.parse(line));
    expect(rows).toHaveLength(10);
    for (const id of new Set(rows.map(row => row.id))) {
      const effects = rows.filter(row => row.id === id).map(row => row.effect);
      expect(effects[0]).toBe("started"); expect(effects).toHaveLength(2);
      expect(["applied", "no-op", "failed"]).toContain(effects[1]);
    }
    expectPrivateFile(file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it.runIf(process.platform === "win32")("refuses a multiply-linked receipt file before the effect and preserves both names' bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-channel-refusal-"));
  const dir = path.join(root, "state"), file = path.join(dir, "human-channel-operations.jsonl"), other = path.join(root, "other.jsonl");
  fs.mkdirSync(dir); fs.writeFileSync(file, "synthetic prior"); fs.linkSync(file, other);
  const run = vi.fn();
  try {
    await expect(runChannelOperation({ ...actor, run }, root)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("synthetic prior");
    expect(fs.readFileSync(other, "utf8")).toBe("synthetic prior");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
