import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { captureCommand } from "../src/commands/capture.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}
function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}
function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

// A 21-row pane full of output, captured with 5 history lines: 26 lines, as measured on tmux.
const TALL = Array.from({ length: 26 }, (_, i) => `row${i + 1}`).join("\n") + "\n";
// A short shell pane: 7 lines of output, then the 14 empty rows below the prompt.
const SHORT = ["$ for i in 1 2 3 4 5", "line1", "line2", "line3", "line4", "line5", "$"].join("\n") + "\n" + "\n".repeat(14);
const PANES: Record<string, string> = { "tall@my-rig": TALL, "short@my-rig": SHORT };
const requests: Array<Record<string, unknown>> = [];

describe("Capture CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/transport/capture") {
          const parsed = JSON.parse(body);
          requests.push(parsed);
          if (parsed.session && PANES[parsed.session] !== undefined) {
            // What `capture-pane -S -N` returns: the history lines asked for, plus the whole visible pane.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: parsed.session, content: PANES[parsed.session], lines: parsed.lines }));
          } else if (parsed.session) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: parsed.session, content: "line1\nline2\n", lines: 20 }));
          } else if (parsed.rig) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ results: [
              { ok: true, sessionName: "dev-impl@my-rig", content: parsed.rig === "tall" ? TALL : "impl output", lines: parsed.lines },
              parsed.rig === "partial" ? { ok: false, sessionName: "dev-qa@my-rig", error: "external CLI capture is not available" } :
              { ok: true, sessionName: "dev-qa@my-rig", content: "qa output", lines: 20 },
            ]}));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing target" }));
          }
        } else { res.writeHead(404).end(); }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(captureCommand(runningDeps(port)));
    return prog;
  }

  it("capture prints pane content", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "capture", "dev-impl@my-rig"]);
    });
    expect(logs.join("\n")).toContain("line1");
  });

  it("capture --rig prints multi-session results with headers", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "capture", "--rig", "my-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("--- dev-impl@my-rig ---");
    expect(output).toContain("impl output");
    expect(output).toContain("--- dev-qa@my-rig ---");
  });

  it.each([false, true])("preserves successful rig capture status when an external CLI cannot be captured %j", async (json) => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "capture", "--rig", "partial", ...(json ? ["--json"] : [])]);
    });
    expect(logs.join("\n")).toContain("impl output");
    expect(logs.join("\n")).toContain("external CLI capture is not available");
    expect(exitCode).toBeUndefined();
  });

  it("capture --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "capture", "dev-impl@my-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toContain("line1");
  });

  describe("--lines N shows the last N lines (not N plus the visible pane)", () => {
    async function run(argv: string[]): Promise<{ out: string[]; err: string[] }> {
      const out: string[] = []; const err: string[] = [];
      const origLog = console.log; const origErr = console.error;
      console.log = (...args: unknown[]) => out.push(args.join(" ")); console.error = (...args: unknown[]) => err.push(args.join(" "));
      try { await makeCmd().parseAsync(["node", "rig", "capture", ...argv]); } finally { console.log = origLog; console.error = origErr; }
      return { out, err };
    }

    it("--lines 5 on a tall pane prints the last 5 lines, with the omitted count on stderr", async () => {
      const { out, err } = await run(["tall@my-rig", "--lines", "5"]);
      expect(out.join("\n").split("\n").filter(Boolean)).toEqual(["row22", "row23", "row24", "row25", "row26"]);
      expect(err).toEqual(["[rig capture: tall@my-rig: 21 earlier lines not shown; last 5 shown]"]);
      expect(requests.at(-1)!.lines).toBe(5); // the daemon request is unchanged
    });

    it("--json reports the count returned, the count requested and the count left out", async () => {
      const { out, err } = await run(["tall@my-rig", "--lines", "5", "--json"]);
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed).toMatchObject({ ok: true, lines: 5, requestedLines: 5, omittedLines: 21 });
      expect(parsed.content).toBe("row22\nrow23\nrow24\nrow25\nrow26\n");
      expect(err).toEqual([]);
    });

    it("drops the empty rows below a short pane's content before counting", async () => {
      const { out } = await run(["short@my-rig", "--lines", "3", "--json"]);
      expect(JSON.parse(out.join("\n"))).toMatchObject({ content: "line4\nline5\n$\n", lines: 3, omittedLines: 4 });
    });

    it("a pane with fewer lines than asked returns them all and prints no note", async () => {
      const { out, err } = await run(["short@my-rig", "--lines", "50"]);
      expect(out.join("\n").split("\n").filter(Boolean)).toHaveLength(7);
      expect(err).toEqual([]);
    });

    it("without --lines the output is unchanged: 20 history lines plus the pane, JSON lines echoes the request", async () => {
      const { out, err } = await run(["tall@my-rig", "--json"]);
      const parsed = JSON.parse(out.join("\n"));
      expect(requests.at(-1)!.lines).toBe(20);
      expect(parsed.content).toBe(TALL);
      expect(parsed.lines).toBe(20);
      expect(parsed).not.toHaveProperty("requestedLines");
      expect(err).toEqual([]);
    });

    it("--history-plus-pane keeps the legacy output for an explicit --lines", async () => {
      const { out, err } = await run(["tall@my-rig", "--lines", "5", "--history-plus-pane", "--json"]);
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed.content).toBe(TALL);
      expect(parsed).not.toHaveProperty("omittedLines");
      expect(err).toEqual([]);
    });

    it.each(["abc", "0"])("--lines %s keeps today's output", async (value) => {
      const { out } = await run(["tall@my-rig", "--lines", value, "--json"]);
      expect(JSON.parse(out.join("\n")).content).toBe(TALL);
    });

    it("--rig cuts each seat's capture and leaves a failed seat as it was", async () => {
      const { out, err } = await run(["--rig", "tall", "--lines", "2"]);
      expect(out).toEqual(["--- dev-impl@my-rig ---", "row25\nrow26\n", "--- dev-qa@my-rig ---", "qa output\n"]);
      expect(err).toEqual(["[rig capture: dev-impl@my-rig: 24 earlier lines not shown; last 2 shown]"]);
      const json = await run(["--rig", "partial", "--lines", "2", "--json"]);
      const results = JSON.parse(json.out.join("\n")).results;
      expect(results[0]).toMatchObject({ ok: true, content: "impl output\n", lines: 1, requestedLines: 2, omittedLines: 0 });
      expect(results[1]).toEqual({ ok: false, sessionName: "dev-qa@my-rig", error: "external CLI capture is not available" });
    });
  });
});
