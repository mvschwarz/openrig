import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { runProgram } from "../src/cli-error.js";
import { DaemonClient, DaemonTimeoutError } from "../src/client.js";

let server: http.Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function slowBodyServer(delayMs: number) {
  let requests = 0;
  let closedBeforeEnd = 0;
  let response: http.ServerResponse | undefined;
  let markHeadersWritten: () => void;
  const headersWritten = new Promise<void>((resolve) => { markHeadersWritten = resolve; });
  server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the actual request body */ }
    requests++;
    response = res;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":'); // fetch resolves headers, while body remains incomplete
    markHeadersWritten();
    const timer = setTimeout(() => res.end("true}"), delayMs);
    res.on("close", () => {
      if (!res.writableEnded) closedBeforeEnd++;
      clearTimeout(timer);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests, closedBeforeEnd: () => closedBeforeEnd,
    headersWritten, dropBody: () => response!.destroy() };
}

function observedFetch() {
  let markHeadersReceived: () => void;
  const headersReceived = new Promise<void>((resolve) => { markHeadersReceived = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    markHeadersReceived();
    return response;
  };
  return { fetchImpl, headersReceived };
}

describe("DaemonClient response body deadline", () => {
  it.each(["json", "text", "write"])("bounds %s body reads after headers arrive", async (kind) => {
    const endpoint = await slowBodyServer(4_000);
    const observed = observedFetch();
    const client = new DaemonClient(endpoint.url, { timeoutMs: 1_000, fetchImpl: observed.fetchImpl });
    const request = kind === "json" ? client.get("/read") : kind === "text" ? client.getText("/read") : client.post("/write", { action: "once" });
    const result = request.then(() => null, (error: unknown) => error);
    await expect(Promise.race([endpoint.headersWritten.then(() => "headers written"), result])).resolves.toBe("headers written");
    await expect(Promise.race([observed.headersReceived.then(() => "headers received"), result])).resolves.toBe("headers received");
    expect(await result).toBeInstanceOf(DaemonTimeoutError);
    expect(endpoint.requests()).toBe(1); // no automatic retry of an accepted write
    await expect.poll(endpoint.closedBeforeEnd).toBe(1); // cancel the body/socket, not just the caller promise
  });

  it.each([false, true])("reports an unknown POST outcome after the response body drops (json=%s)", async (json) => {
    const endpoint = await slowBodyServer(4_000);
    const observed = observedFetch();
    const client = new DaemonClient(endpoint.url, { timeoutMs: 2_000, fetchImpl: observed.fetchImpl });
    const program = new Command().option("--json");
    program.command("write").action(async () => { await client.post("/write", { action: "once" }); });
    const out: string[] = [];
    const err: string[] = [];
    const exitCodes: number[] = [];
    const run = runProgram(program, ["node", "rig", "write", ...(json ? ["--json"] : [])], {
      out: (line) => out.push(line), err: (line) => err.push(line), exit: (code) => exitCodes.push(code),
    });
    await expect(Promise.race([endpoint.headersWritten.then(() => "headers written"), run])).resolves.toBe("headers written");
    await expect(Promise.race([observed.headersReceived.then(() => "headers received"), run])).resolves.toBe("headers received");
    endpoint.dropBody();
    expect(await run).toBe(1);
    expect(exitCodes).toEqual([1]);
    const guidance = (json ? out : err).join("\n");
    expect(guidance).toMatch(/unreadable response/i);
    expect(guidance).toMatch(/outcome.*UNKNOWN/i);
    expect(guidance).toMatch(/re-check current state/i);
    expect(guidance).not.toMatch(/not delivered|cannot connect|rig up|rig daemon start/i);
    if (json) expect(JSON.parse(guidance).error.consequence).toMatch(/UNKNOWN/);
    expect(endpoint.requests()).toBe(1);
    await expect.poll(endpoint.closedBeforeEnd).toBe(1);
  });

  it("uses the per-request deadline through the complete body", async () => {
    const endpoint = await slowBodyServer(100);
    const client = new DaemonClient(endpoint.url, { timeoutMs: 20 });
    await expect(client.get("/read", { timeoutMs: 1_000 })).resolves.toEqual({ status: 200, data: { ok: true } });
    expect(endpoint.requests()).toBe(1);
    expect(endpoint.closedBeforeEnd()).toBe(0);
  });
});
