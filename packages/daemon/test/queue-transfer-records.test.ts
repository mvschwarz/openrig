import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { authorizationDigest, parseActivationResult, parseAuthorization, parseReceipt, rowsDigest } from "../src/domain/queue-transfer-records.js";

const origin = { hostId: "origin", mintedAt: "2026-11-23T00:00:00Z" };
const authorization = {
  kind: "openrig.queue-transfer.authorization/v1", operationId: "op-1", archiveDigest: "a".repeat(64), origin,
  destination: { hostId: "here", authorizedAt: "2026-11-23T00:00:00Z", seatMapping: [] },
  intervention: { kind: "online-handshake", actor: "operator", recordedAt: "2026-11-23T00:00:00Z", limits: "local dispatch" },
};

it("keeps authorization and row-set digests stable when reserialized or reordered", () => {
  const parsed = parseAuthorization(authorization);
  expect(authorizationDigest(parseAuthorization(JSON.parse(JSON.stringify(parsed))))).toBe(authorizationDigest(parsed));
  const a = { qitemId: "qitem-a", state: "pending" };
  const b = { qitemId: "qitem-b", state: "blocked" };
  expect(rowsDigest([a, b])).toBe(rowsDigest([b, a]));
  expect(rowsDigest([a, b])).not.toBe(rowsDigest([a]));
});

it("validates portable records without a daemon Zod dependency or digest changes from extra fields", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.dependencies).not.toHaveProperty("zod");
  const withExtras = parseAuthorization({ ...authorization, ignored: true, origin: { ...origin, ignored: true } });
  expect(withExtras).toEqual(parseAuthorization(authorization));
  expect(authorizationDigest(withExtras)).toBe(authorizationDigest(parseAuthorization(authorization)));
});

it("refuses an unknown authorization kind or a malformed mapping", () => {
  expect(() => parseAuthorization({ ...authorization, kind: "openrig.queue-transfer.authorization/v2" }))
    .toThrow(expect.objectContaining({ code: "authorization_invalid" }));
  expect(() => parseAuthorization({ ...authorization, destination: { ...authorization.destination, seatMapping: [{ from: "x" }] } }))
    .toThrow(expect.objectContaining({ code: "authorization_invalid" }));
});

it("refuses incomplete receipts and noncommitted activation results", () => {
  expect(() => parseReceipt({ kind: "openrig.queue-transfer.receipt/v1", sourceState: "isolated" }))
    .toThrow(expect.objectContaining({ code: "receipt_invalid" }));
  expect(() => parseActivationResult({ kind: "openrig.queue-transfer.activation/v1", status: "ready_for_activation" }))
    .toThrow(expect.objectContaining({ code: "activation_result_invalid" }));
});
