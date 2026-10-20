import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assessLocalDaemonOwner } from "../src/local-daemon-owner.js";
import { allowFetchTarget } from "./fetch-guard.js";

const processRow = (uid = 502, start = "Tue Oct 20 03:40:00 2026") => `${uid} ${start}\n`;
function deps(outputs = [processRow(), processRow()]) {
  return {
    platform: "darwin", callerUid: 501,
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ pid: 42, euid: 502 }))) as unknown as typeof fetch,
    run: vi.fn(async (file: string) => {
      // Model unavailable foreign descriptors for the previous assessor, not ps output fed to lsof.
      if (file === "/usr/sbin/lsof") return "";
      const next = outputs.shift();
      if (next === undefined) throw new Error("fixture exhausted");
      return next;
    }),
  };
}
describe("bounded Mac reported/process effective-UID agreement", () => {
  it("corroborates reported foreign euid with repeated process UID/start without descriptor inspection", async () => {
    const d = deps();
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "foreign", pid: 42, uid: 502, callerUid: 501 });
    expect(d.run.mock.calls.map(c => c[0])).toEqual(["/bin/ps", "/bin/ps"]);
    expect(d.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("same effective UID permits use but does not assert instance identity", async () => {
    const d = deps(); d.callerUid = 502;
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "same-user" });
  });
  it.each([
    ["PID reuse", [processRow(), processRow(502, "Tue Oct 20 03:41:00 2026")]],
    ["reported/process UID disagreement", [processRow(501)]],
    ["changed process UID", [processRow(), processRow(501)]],
    ["missing process", [""]],
    ["ambiguous process rows", [processRow() + processRow(503)]],
    ["malformed process", ["502 nonsense"]],
  ])("%s remains unknown", async (_name, rows) => {
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", deps([...rows]))).toMatchObject({ state: "unknown" });
  });
  it.each([{ pid: 43, euid: 502 }, { pid: 42, euid: 503 }, {}])("changed health identity %j remains unknown", async changed => {
    const d = deps();
    d.fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ pid: 42, euid: 502 })))
      .mockResolvedValueOnce(new Response(JSON.stringify(changed)));
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "unknown" });
  });
  it.each(["http://localhost:7433", "http://[::1]:7433"])("checks a loopback target %s", async url => {
    expect(await assessLocalDaemonOwner(url, deps())).toMatchObject({ state: "foreign" });
  });
  it.each(["http://remote.example:7433", "http://192.0.2.1:7433", "not a URL"])("never inspects a remote/unparseable target %s", async url => {
    const d = deps();
    expect(await assessLocalDaemonOwner(url, d)).toMatchObject({ state: "unknown" });
    expect(d.fetchImpl).not.toHaveBeenCalled(); expect(d.run).not.toHaveBeenCalled();
  });
  it.each([null, {}, { pid: 42 }, { pid: "42", euid: 502 }, { pid: -1, euid: 502 },
    { pid: 42, euid: "502" }, { pid: 42, euid: -1 }, { pid: 42, euid: 1.5 }])("old or malformed health %j remains unknown", async body => {
    const d = deps(); d.fetchImpl = vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "unknown" });
    expect(d.run).not.toHaveBeenCalled();
  });
  it.each([{ caller: 0, daemon: 502 }, { caller: 501, daemon: 0 }])("effective UID zero is valid on either side: %j", async ({ caller, daemon }) => {
    const d = deps([processRow(daemon), processRow(daemon)]); d.callerUid = caller;
    d.fetchImpl = vi.fn(async () => new Response(JSON.stringify({ pid: 42, euid: daemon }))) as unknown as typeof fetch;
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "foreign", callerUid: caller, uid: daemon });
  });
  it("unavailable tools/permissions remain unknown without a privileged fallback", async () => {
    const d = deps(); d.run.mockRejectedValue(new Error("EPERM"));
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "unknown" });
    expect(d.run).toHaveBeenCalledTimes(1);
  });
  it("bounds a non-cooperative health fetch and does not start OS work after expiry", async () => {
    const d = deps(); d.fetchImpl = (() => new Promise(() => {})) as typeof fetch;
    const start = performance.now();
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", { ...d, timeoutMs: 30 })).toMatchObject({ state: "unknown" });
    expect(performance.now() - start).toBeLessThan(500); expect(d.run).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== "darwin" || process.env.OPENRIG_TEST_MAC_OWNER_TOOLS !== "1")("qualifies unprivileged Mac ps and an owned reporting listener", async () => {
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ pid: process.pid, euid: process.geteuid!() })));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    allowFetchTarget(url);
    try {
      const started = performance.now();
      expect(await assessLocalDaemonOwner(url)).toMatchObject({ state: "same-user", pid: process.pid, uid: process.geteuid!() });
      const elapsedMs = performance.now() - started;
      // PID1 belongs to root on the hosted Mac: observe UID/start only, without sudo or descriptor access.
      const other = await promisify(execFile)("/bin/ps", ["-o", "uid=,lstart=", "-p", "1"], { timeout: 1000, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
      expect(other.stdout.trim()).toMatch(/^0\s+/); expect(process.geteuid!()).not.toBe(0);
      console.log(JSON.stringify({ qualification: "owned reported identity and foreign-UID ps visibility", pid: process.pid, uid: process.geteuid!(), foreignPid: 1, foreignUid: 0, elapsedMs }));
      expect(elapsedMs).toBeLessThan(1500);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
