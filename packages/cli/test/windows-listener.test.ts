import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findListeningPidWithLsof, parseWindowsListeningPid } from "../src/destroy-helpers.js";

describe("Windows listener table", () => {
  it("deduplicates dual-stack listeners and excludes connected sockets and other ports", () => {
    expect(parseWindowsListeningPid([
      "  TCP  0.0.0.0:17433  0.0.0.0:0  LISTENING  42",
      "  TCP  [::]:17433  [::]:0  LISTENING  42",
      "  TCP  127.0.0.1:17433  127.0.0.1:91  ESTABLISHED  99",
      "  TCP  0.0.0.0:117433  0.0.0.0:0  LISTENING  99",
      "  UDP  0.0.0.0:17433  *:*  99",
    ].join("\r\n"), 17433)).toBe(42);
  });
  it("keeps absent, ambiguous and malformed ownership unknown", () => {
    expect(parseWindowsListeningPid("", 17433)).toBeNull();
    expect(parseWindowsListeningPid("TCP 127.0.0.1:17433 0.0.0.0:0 LISTENING 42\nTCP [::1]:17433 [::]:0 LISTENING 43", 17433)).toBeNull();
    expect(parseWindowsListeningPid("TCP 127.0.0.1:17433 0.0.0.0:0 LISTENING invalid", 17433)).toBeNull();
  });
});

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
