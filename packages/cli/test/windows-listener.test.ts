import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findListeningPidWithLsof } from "../src/destroy-helpers.js";

describe.skipIf(process.platform !== "win32")("native Windows listener identity", () => {
  it("finds an owned listener and observes its removal without killing a process", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    try { expect(findListeningPidWithLsof(address.port)).toBe(process.pid); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    expect(findListeningPidWithLsof(address.port)).toBeNull();
  }, 30_000);
  it("rejects invalid ports before invoking OS tools", () => {
    for (const port of [0, -1, 65536, NaN, 1.5]) expect(findListeningPidWithLsof(port)).toBeNull();
  });
});
