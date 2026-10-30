import { expect, it, vi } from "vitest";
import { assessLocalDaemonOwner, ForeignLocalDaemonError } from "../src/local-daemon-owner.js";

it.each(["same", "foreign", "birth-changed", "sid-changed", "caller-changed", "pid-changed", "denied", "malformed", "timeout"])("Windows owner observation: %s", async kind => {
  let reads = 0, health = 0;
  const run = vi.fn(async (_file: string, args: string[]) => {
    reads++;
    expect(args).toContain("-NoProfile");
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("ProcessId = 42");
    expect(script).not.toMatch(/CommandLine|Environment/);
    if (kind === "denied") throw Error("access denied");
    if (kind === "malformed") return "{}";
    if (kind === "timeout") return new Promise<string>(() => {});
    return JSON.stringify({ pid: 42, sid: kind === "foreign" || kind === "sid-changed" && reads === 2 ? "S-1-5-21-2" : "S-1-5-21-1",
      callerSid: kind === "caller-changed" && reads === 2 ? "S-1-5-21-3" : "S-1-5-21-1", start: kind === "birth-changed" && reads === 2 ? "200" : "100" });
  });
  const result = await assessLocalDaemonOwner("http://127.0.0.1:17499", { platform: "win32", run, timeoutMs: kind === "timeout" ? 20 : 1000,
    fetchImpl: vi.fn(async () => Response.json({ pid: kind === "pid-changed" && ++health === 2 ? 43 : 42 })) });
  expect(result.state).toBe(kind === "same" ? "same-user" : kind === "foreign" ? "foreign" : "unknown");
  if (result.state === "foreign") expect(new ForeignLocalDaemonError("http://fixture", result).message).toContain("caller SID");
});

it.runIf(process.platform === "win32")("corroborates this owned test process through native SID and creation observations", async () => {
  const result = await assessLocalDaemonOwner("http://127.0.0.1:17499", { timeoutMs: 10000,
    fetchImpl: async () => Response.json({ pid: process.pid }) });
  expect(result).toMatchObject({ state: "same-user", pid: process.pid });
  // No SID or native command output is printed into the receipt.
});
