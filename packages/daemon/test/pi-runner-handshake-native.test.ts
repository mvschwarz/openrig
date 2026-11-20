import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { piSeatPaths, PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER } from "../src/adapters/pi-runner-protocol.js";

import { connectPiRunnerChannel, RunnerCore } from "../src/adapters/pi-runner.js";

// Real runner + real offline JSONL child, never a provider API or installed Pi.
describe.skipIf(process.platform === "win32")("Pi startup RPC handshake", () => {
  it.each([
    { character: "\n", members: 0, hint: undefined }, { character: "\0", members: 0, hint: undefined },
    { character: "\0", members: 1, hint: undefined },
    { character: "\0", members: 2, hint: undefined }, { character: "\n", members: 9, hint: undefined },
    ...["omit", "invalid", "9007199254740991", "1"].map(hint => ({ character: "\0", members: 2, hint })),
  ])("the production SSE reader bounds ordinary/grouped native input ($members sources, $character, $hint)", async ({ character, members, hint }) => {
    const posts: Record<string, unknown>[] = [], rpc: Record<string, unknown>[] = [];
    const core = new RunnerCore({ sendRpc: command => { rpc.push(command); }, mirrorLine: () => {}, mirrorAppend: () => {},
      postActivity: () => {}, writeSidecar: () => {}, now: () => new Date().toISOString(), postRunner: async body => { posts.push(body); return true; } },
      { sessionName: "fixture", runId: "run" });
    core.start(); core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionId: "offline", isStreaming: false, pendingMessageCount: 0 } }));
    const question = "q" + character.repeat(hint && hint !== "omit" ? 1 : (members === 1 ? 2 : 1) * 1024 * 1024 - 1);
    const frames = [1, 2].map(sequence => {
      const memberIds = Array.from({ length: members }, (_, index) => index === 0 ? `large-${sequence}` : `large-${sequence}-source-🧭-${index}`);
      const grouped = members > 0 && sequence === 1;
      const frame = grouped ? { version: 1, requestId: `large-${sequence}`, nodeId: "node-🧭", runId: "run", sequence,
        kind: "input", inputRoute: "native", stage: "offered", bindingHash: "b".repeat(64), ...(members > 1 ? { memberIds } : {}),
        payload: { text: Array.from({ length: members }, () => question).join("\n") } }
        : { version: 1, runId: "run", requestId: `large-${sequence}`, sequence, kind: "wake", payload: { question: members === 1 ? "normal successor" : question } };
      const data = JSON.stringify(frame);
      if (members === 1 && sequence === 1) {
        expect(frame).not.toHaveProperty("memberIds");
        expect(data.length).toBeGreaterThan(6 * 1024 * 1024 + 64 * 1024);
      }
      return `${grouped && hint !== "omit" ? `: runner-frame-chars=${hint ?? data.length}\n` : ""}event: request\ndata: ${data}\n\n`;
    }).join("");
    const controller = new AbortController();
    let reads = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ receipts: [] }));
      reads++;
      return new Response(new ReadableStream({ start(stream) {
        // Deliberately split the first JSON escape and then coalesce two valid large frames.
        const split = frames.indexOf(character === "\n" ? "\\n" : "\\u0000") + 1;
        if (members) stream.enqueue(new TextEncoder().encode(frames.slice(0, 9)));
        stream.enqueue(new TextEncoder().encode(frames.slice(members ? 9 : 0, split)));
        stream.enqueue(new TextEncoder().encode(frames.slice(split))); stream.close();
      } }));
    });
    try {
      const connected = connectPiRunnerChannel(core, { baseUrl: "http://fixture", token: "fixture" }, "run", controller.signal);
      const until = Date.now() + 3000;
      while ((hint ? reads < 2 : posts.filter(post => post.type === "ack").length < 2) && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, 10));
      controller.abort(); await connected;
      expect(posts.filter(post => post.type === "ack").map(post => post.requestId)).toEqual(hint ? [] : ["large-1", "large-2"]);
      if (hint) {
        expect(reads).toBeGreaterThanOrEqual(2); // The actual reader rejected and reconnected before this test stops it.
        expect(rpc.filter(command => command.type === "prompt")).toEqual([]);
      } else expect(reads).toBe(1);
      if (members && !hint) {
        const prompts = rpc.filter(command => command.type === "prompt");
        expect(prompts).toHaveLength(1); // The second accepted operation waits for the first native start.
        expect(prompts[0]?.message).toBe(Array.from({ length: members }, () => question).join("\n"));
      }
    } finally { controller.abort(); fetch.mockRestore(); }
  });

  it.each([
    { boundary: "ack", code: "runner_receipt_erased", status: 409, later: true },
    { boundary: "ack", code: "runner_grant_revoked", status: 401, later: false },
    { boundary: "ack", code: "runner_grant_stale", status: 409, later: false },
    ...["hello", "subscription"].flatMap(boundary => [
      { boundary, code: "runner_grant_revoked", status: 401, later: false },
      { boundary, code: "forbidden", status: 403, later: false },
      { boundary, code: "runner_grant_stale", status: 409, later: false },
      { boundary, code: "runner_grant_pending", status: 409, later: true },
      { boundary, code: "runner_grant_unverified", status: 409, later: true },
      { boundary, code: "unavailable", status: 503, later: true },
    ]),
  ])("$boundary refusal $code preserves the run boundary and person input", async ({ boundary, code, status, later }) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ack-")), bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const log = path.join(temp, "rpc.jsonl");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const cmd=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
console.log(JSON.stringify({type:'response',id:cmd.id,success:true,data:cmd.type==='get_state'?{sessionId:'offline',isStreaming:false,pendingMessageCount:0}:{disposition:'handled'}}));
if (${JSON.stringify(boundary)}!=='ack' && (cmd.type==='get_state' && cmd.id==='pi-runner-get-state' || cmd.message==='person input')) console.log(JSON.stringify({type:cmd.message==='person input'?'agent_end':'agent_start'}));
});
`, { mode: 0o700 });
    let stream: import("node:http").ServerResponse | undefined, pending: import("node:http").ServerResponse | undefined;
    let refused = false, subscriptions = 0, hellos = 0;
    const endpoint = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/activity/runner-channel") {
        subscriptions++;
        if (boundary === "subscription" && subscriptions === 2) {
          res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ code })); refused = true; return;
        }
        stream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
        if (subscriptions === 1) for (const [index, id] of ["first", "later"].entries()) res.write(`event: request\nid: ${index + 1}\ndata: ${JSON.stringify({ version: 1, runId: "run", requestId: id, sequence: index + 1,
          kind: boundary === "ack" ? "input" : "wake", payload: boundary === "ack" ? { text: id } : { question: id } })}\n\n`);
        return;
      }
      let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (body.type === "hello" && ++hellos === 2 && boundary === "hello") {
          res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ code })); refused = true; return;
        }
        if (boundary === "ack" && body.type === "ack" && body.requestId === "first") { pending = res; return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ tokenPersisted: true, receipts: [] }));
        if (body.type === "ack" && body.requestId === "later") {
          if (boundary === "ack") { pending!.writeHead(status, { "content-type": "application/json" }); pending!.end(JSON.stringify({ code })); refused = true; }
          else stream!.end();
        }
      });
    });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", path.join(temp, "state"), "--cwd", temp, "--launch-id", "run", "--no-approve"], {
      env: { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: temp, OPENRIG_HOME: path.join(temp, "home"),
        OPENRIG_URL: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "oag_fixture", OPENRIG_RUN_ID: "run" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = ""; child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
    const commands = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const wait = async (probe: () => boolean) => {
      const until = Date.now() + 8000;
      while (!probe() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      expect(probe(), output).toBe(true);
    };
    try {
      await wait(() => refused);
      if (later && boundary === "ack") await wait(() => commands().some(cmd => cmd.message === "later"));
      if (later && boundary !== "ack") await wait(() => boundary === "hello" ? hellos >= 3 : subscriptions >= 3);
      child.stdin.write("person input\n");
      await wait(() => commands().some(cmd => cmd.message === "person input"));
      // Person preflight completes after the refusal and pumps again; a revoked run stays fenced.
      await new Promise(resolve => setTimeout(resolve, 100));
      if (later) await wait(() => commands().some(cmd => cmd.message === "later"));
      expect(commands().filter(cmd => cmd.message === "first")).toHaveLength(boundary !== "ack" && later ? 1 : 0);
      expect(commands().filter(cmd => cmd.message === "later")).toHaveLength(later ? 1 : 0);
    } finally {
      child.kill("SIGTERM"); stream?.destroy(); pending?.destroy(); endpoint.closeAllConnections();
      await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
      await new Promise<void>(resolve => endpoint.close(() => resolve()));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15000);

  it.each(["missing", "old"])("reports the pane's actual %s executable failure", async kind => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-"));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    if (kind === "old") fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
if(process.argv.includes('--version')) { console.error('0.73.1'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('old Pi help'); process.exit(0); }
console.error('Error: Unknown options: --name, --no-approve'); process.exit(1);
`, { mode: 0o700 });
    const stateRoot = path.join(temp, "state");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "owned-attempt", "--no-approve"], {
      env: { PATH: bin, HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d.toString(); });
    child.stderr.on("data", d => { output += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      await new Promise<void>(resolve => child.once("close", () => resolve()));
      expect(child.signalCode, output).toBeNull();
      expect(child.exitCode, output).not.toBe(0);
      expect(output).not.toContain(PI_RUNNER_READY_MARKER);
      const state = JSON.parse(fs.readFileSync(piSeatPaths(stateRoot, "fixture").runnerStatePath, "utf8"));
      expect(state).toMatchObject({ ready: false, launchId: "owned-attempt" });
      if (kind === "old") {
        expect(output).toContain("Pi invoked as pi (version 0.73.1; exact executable path unknown)");
        expect(output).toContain("@earendil-works/pi-coding-agent");
        expect(state.exited.code).toBe(1);
      } else {
        expect(output).toContain("failed to spawn pi: spawn pi ENOENT");
        expect(state.exited.code).toBe(127);
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGTERM");
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 20000);

  it.each([
    { success: false, credential: "absent" },
    { success: true, credential: "absent" },
    { success: true, credential: "dynamic" },
    { success: true, credential: "present" },
  ])("publishes ready only after successful get_state (success=$success, credential=$credential)", async ({ success, credential }) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-"));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const pidPath = path.join(temp, "child.pid");
    const sessionFile = path.join(temp, "session.jsonl");
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconst fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const cmd=JSON.parse(line); if(cmd.type==='get_state') console.log(JSON.stringify({type:'response',id:cmd.id,success:${success},
${success ? `data:{sessionFile:${JSON.stringify(sessionFile)},sessionId:'offline'}` : `error:'cannot load saved session'`}}));
if(cmd.type==='prompt') { console.error('Unknown option: --name'); console.error('AFTER_RUNNING_WARNING'); }
});\n`, { mode: 0o700 });
    const stateRoot = path.join(temp, "state");
    const runnerStatePath = piSeatPaths(stateRoot, "fixture").runnerStatePath;
    if (credential !== "absent") {
      const agentDir = piSeatPaths(stateRoot, "fixture").agentDir;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ openrouter: {
        type: "api_key", key: credential === "dynamic" ? "!private-command" : "private-value",
      } }));
    }
    const reports: Array<{ body: Record<string, unknown>; token: string | undefined }> = [];
    const endpoint = createServer((req, res) => {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST") reports.push({ body: JSON.parse(body), token: req.headers.authorization });
        res.statusCode = credential === "present" ? 409 : 200;
        res.end(JSON.stringify({ tokenPersisted: credential !== "present" }));
      });
    });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const port = (endpoint.address() as { port: number }).port;
    const token = credential === "absent" ? "fixture-install-token" : "oag_fixture-bound";
    const envRunId = credential === "dynamic" ? "owned-attempt" : "inherited-predecessor";
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "owned-attempt", "--no-approve", "--model", "openrouter/fixture"], {
      env: { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: temp, OPENRIG_HOME: path.join(temp, "home"),
        OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: token, OPENRIG_RUN_ID: envRunId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d.toString(); });
    child.stderr.on("data", d => { output += d.toString(); });
    try {
      const deadline = Date.now() + 15000;
      while (!output.includes(PI_RUNNER_READY_MARKER) && !output.includes(PI_RUNNER_ERROR_MARKER) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(pidPath), output).toBe(true);
      const notice = credential === "absent" ? "No stored sign-in or provider key was found"
        : credential === "dynamic" ? "Pi credential status unknown" : "Pi stored provider key present";
      expect(output).toContain(notice);
      expect(output.indexOf(notice)).toBeLessThan(output.indexOf("starting pi --mode rpc"));
      expect(output.toLowerCase()).toContain("launch continues");
      expect(output).not.toMatch(/private-command|private-value/);
      const state = JSON.parse(fs.readFileSync(runnerStatePath, "utf8"));
      expect(state.ready, output).toBe(success);
      expect(state.launchId).toBe("owned-attempt");
      if (success) {
        expect(state.sessionFile).toBe(sessionFile);
        const reportDeadline = Date.now() + 5000;
        while (!reports.some(r => r.body.eventFamily === "session_identity") && Date.now() < reportDeadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const identity = reports.find(r => r.body.eventFamily === "session_identity");
        expect(identity).toBeDefined();
        if (credential === "absent") expect(identity!.body).not.toHaveProperty("runId");
        else expect(identity!.body.runId).toBe(envRunId); // a refused bound claim is never rewritten or downgraded
        expect(reports.every(r => r.token === `Bearer ${token}`)).toBe(true);
        child.stdin.write("emit a runtime warning\n");
        const warningDeadline = Date.now() + 5000;
        while (!output.includes("AFTER_RUNNING_WARNING") && Date.now() < warningDeadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(output).toContain("AFTER_RUNNING_WARNING");
        expect(output).not.toContain("rejects the managed");
        if (credential === "absent") {
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(reports.filter(r => r.body.type === "hello")).toEqual([]);
        }

      }
      else {
        expect(output).toContain("cannot load saved session");
        expect(output).not.toContain(PI_RUNNER_READY_MARKER);
      }
    } finally {
      if (fs.existsSync(pidPath)) {
        try { process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGTERM"); } catch { /* child exited */ }
      }
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
      await new Promise<void>(resolve => endpoint.close(() => resolve()));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 20000);
});
