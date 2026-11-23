import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as format from "../src/domain/queue-transfer-format.js";

it("canonicalizes sorted keys and hashes the entire envelope except its digest", () => {
  const data = { rows: [{ qitemId: "qitem-a", body: "first\nanswer" }], format: format.QUEUE_TRANSFER_FORMAT };
  const expected = '{"format":"openrig.queue-transfer/v2","rows":[{"body":"first\\nanswer","qitemId":"qitem-a"}]}';
  const archive = format.sealQueueTransfer(data, 1024);
  const parsed = JSON.parse(archive);
  expect(format.canonicalQueueJson(parsed)).toBe(archive);
  expect(format.sealQueueTransfer(parsed, 1024)).toBe(archive);
  expect(parsed.digest).toEqual({ algorithm: "sha256", coverage: format.QUEUE_TRANSFER_FORMAT,
    value: createHash("sha256").update(expected).digest("hex") });
  expect(parsed).not.toHaveProperty("authorization");
});

it("refuses the complete UTF-8 file over the byte bound rather than truncating it", () => {
  const data = { format: format.QUEUE_TRANSFER_FORMAT, text: "é" };
  const size = Buffer.byteLength(format.sealQueueTransfer(data, 1024));
  expect(() => format.sealQueueTransfer(data, size - 1)).toThrow(/archive_too_large/);
  expect(Buffer.byteLength(format.sealQueueTransfer(data, size))).toBe(size);
});
