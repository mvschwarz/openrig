import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenStore, DeadLetterStore, InboundReceiptStore } from "../src/domain/gateway/slack/state-store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tornFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-torn-native-")); dirs.push(dir);
  const file = path.join(dir, "records.jsonl"); fs.writeFileSync(file, '{"torn":"unfinished'); return file;
}
it("retains a new seen id after a crash left an unterminated append", () => {
  const file = tornFile(); new SeenStore(file).mark("new-message", "posted");
  expect([...new SeenStore(file).load()]).toEqual(["new-message"]);
});
it("retains every seeded id after a torn append", () => {
  const file = tornFile(); new SeenStore(file).seed(["one", "two"]);
  expect([...new SeenStore(file).load()]).toEqual(["one", "two"]);
});
it("retains the first new dead letter after a torn append", () => {
  const file = tornFile(); new DeadLetterStore(file).append({ event: "owed" }, 1);
  expect(new DeadLetterStore(file).readAll()).toEqual([expect.objectContaining({ ev: { event: "owed" }, attempts: 1 })]);
});
it("retains the first new inbound receipt after a torn append", () => {
  const file = tornFile(); new InboundReceiptStore(file).append({ generation: 1, status: "received", envelopeId: "new-envelope" });
  expect(new InboundReceiptStore(file).readAll()).toEqual([expect.objectContaining({ envelopeId: "new-envelope", status: "received" })]);
});
