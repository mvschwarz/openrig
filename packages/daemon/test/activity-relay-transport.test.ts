// #3416 (2): the activity relay posts with node:http, not the global fetch, because it runs once per Claude hook event
// and fetch loads Node's bundled HTTP client first. These run the real script, as the plugin's hook command does, against
// a local receiver: the same request arrives, every failure stays quiet, and a stalled daemon never holds the hook.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const relay = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Received = { at: number; method?: string; url?: string; authorization?: string; type?: string; body: Record<string, unknown> };

async function receiver(answer: (response: http.ServerResponse) => void = (response) => response.writeHead(204).end()) {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      received.push({ at: Date.now(), method: request.method, url: request.url, authorization: request.headers.authorization,
        type: request.headers["content-type"], body: JSON.parse(body) as Record<string, unknown> });
      answer(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { received, port: (server.address() as AddressInfo).port, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-relay-transport-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the relay as the plugin's hook does, with a preload that records, at exit, whether Node's bundled HTTP client
// (undici, behind the global fetch) was loaded during the run. `closedAt` is when the run ended, to time it from the
// moment its post arrived rather than from a spawn whose start-up time depends on the machine's load.
function runRelay(baseUrl: string, event: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const dir = scratch();
  const preload = path.join(dir, "loaded.cjs");
  const report = path.join(dir, "loaded.json");
  fs.writeFileSync(preload, `process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(report)},
    JSON.stringify({ undici: process.moduleLoadList.some((m) => m.includes("undici")) })));\n`);
  const child = spawn(process.execPath, ["-r", preload, relay, "--from-plugin"], {
    env: { PATH: path.dirname(process.execPath), HOME: dir, OPENRIG_HOME: dir, TMPDIR: dir, OPENRIG_URL: baseUrl,
      OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-token", OPENRIG_SESSION_NAME: "worker@transport", OPENRIG_NODE_ID: "node-1",
      OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "generation-1", CLAUDE_PROJECT_DIR: dir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A run still going when its test ends (a regression that holds the hook) is stopped, not left behind.
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ session_id: "11111111-2222-3333-4444-555555555555", cwd: dir, ...event }));
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; closedAt: number;
    undici: boolean | null }>((resolve) => {
    child.on("close", (code, signal) => {
      let undici: boolean | null = null;
      try { undici = (JSON.parse(fs.readFileSync(report, "utf8")) as { undici: boolean }).undici; } catch { /* no exit report */ }
      resolve({ code, signal, stdout, stderr, closedAt: Date.now(), undici });
    });
  });
}

describe("activity relay transport (#3416 item 2)", () => {
  it.skipIf(process.platform === "win32")("posts the same request without loading Node's bundled fetch client", async () => {
    const daemon = await receiver();
    // A name with multibyte characters: the body's length is counted in bytes.
    const run = await runRelay(daemon.url, { hook_event_name: "Stop" }, { OPENRIG_SESSION_NAME: "trabalhador-ação@transporte" });
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "", undici: false });
    expect(daemon.received).toHaveLength(1);
    expect(daemon.received[0]).toMatchObject({ method: "POST", url: "/api/activity/hooks", authorization: "Bearer fixture-token",
      type: "application/json", body: { sessionName: "trabalhador-ação@transporte", nodeId: "node-1", runtime: "claude-code",
        generation: "generation-1", hookEvent: "Stop", relayRoute: "plugin" } });
  });

  it.skipIf(process.platform === "win32")("sends a SessionStart's activity and then its session identity, in that order", async () => {
    const daemon = await receiver();
    const run = await runRelay(daemon.url, { hook_event_name: "SessionStart", source: "startup", transcript_path: "/t.jsonl" });
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(daemon.received.map((post) => post.body["eventFamily"] ?? post.body["hookEvent"]))
      .toEqual(["SessionStart", "session_identity"]);
  });

  it.skipIf(process.platform === "win32")("exits quietly when the daemon refuses the post", async () => {
    const daemon = await receiver((response) => response.writeHead(401, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: false })));
    const run = await runRelay(daemon.url, { hook_event_name: "Stop" });
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(daemon.received).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("leaves a daemon that never answers after 1.5 s, without holding the hook", async () => {
    const daemon = await receiver(() => { /* takes the post and never answers */ });
    const run = await runRelay(daemon.url, { hook_event_name: "Stop" });
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(daemon.received).toHaveLength(1);
    const waited = run.closedAt - daemon.received[0]!.at;
    expect(waited).toBeGreaterThanOrEqual(1300);
    expect(waited).toBeLessThan(3500);
  });

  it.skipIf(process.platform === "win32")("ends the post when the answer arrives, even if its body then stalls", async () => {
    const daemon = await receiver((response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      response.write("{");
    });
    const run = await runRelay(daemon.url, { hook_event_name: "Stop" });
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(daemon.received).toHaveLength(1);
    expect(run.closedAt - daemon.received[0]!.at).toBeLessThan(1000);
  });

  it.skipIf(process.platform === "win32")("exits quietly when nothing listens or the base URL can't be posted to", async () => {
    for (const baseUrl of ["http://127.0.0.1:1", "https://127.0.0.1:1", "ftp://127.0.0.1:1", "not a url"]) {
      const run = await runRelay(baseUrl, { hook_event_name: "Stop" });
      expect(run, baseUrl).toMatchObject({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("posts to an https base URL through node:https, with the same request", async () => {
    // node:https is the module object the relay requires, so the spy sees its call; it carries the request over plain
    // http to the local receiver, which keeps this test free of a certificate.
    const daemon = await receiver();
    const request = vi.spyOn(https, "request").mockImplementation(((url: URL, options: http.RequestOptions,
      callback: (response: http.IncomingMessage) => void) => {
      const plain = new URL(url);
      plain.protocol = "http:";
      plain.hostname = "127.0.0.1";
      plain.port = String(daemon.port);
      return http.request(plain, options, callback);
    }) as unknown as typeof https.request);
    const inProcess = createRequire(import.meta.url)(relay) as { postHookPayload: (payload: object, env: object) => Promise<void> };
    await inProcess.postHookPayload({ hookEvent: "Stop", sessionName: "worker@transport" },
      { OPENRIG_URL: "https://daemon.example:7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-token" });
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]![0])).toBe("https://daemon.example:7433/api/activity/hooks");
    expect(request.mock.calls[0]![1]).toMatchObject({ method: "POST", agent: false });
    expect(daemon.received).toEqual([expect.objectContaining({ url: "/api/activity/hooks", authorization: "Bearer fixture-token",
      body: { hookEvent: "Stop", sessionName: "worker@transport" } })]);
  });
});
