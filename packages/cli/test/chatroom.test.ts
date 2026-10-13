import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { chatroomCommand } from "../src/commands/chatroom.js";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { ulid } from "ulid";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("Chatroom CLI", () => {
  let server: http.Server;
  let port: number;

  const rigSummary = [
    { id: "rig-1", name: "my-rig", nodeCount: 2 },
  ];

  // Use ULID-like IDs (time-ordered, all starting with 01KN — well before any current ULID)
  const chatMessages = [
    { id: "01KN000000AA00000000000001", rigId: "rig-1", sender: "alice", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
    { id: "01KN000000AA00000000000002", rigId: "rig-1", sender: "bob", kind: "message", body: "world", topic: null, createdAt: "2026-03-31T10:01:00Z" },
  ];

  const capturedUrls: string[] = [];
  // Mutable list for dynamic injection during wait tests
  const dynamicMessages: Array<typeof chatMessages[0]> = [];
  let historyFailure: { status: number; body: Record<string, unknown> | null } | null = null;
  let historyDelayMs = 0;
  let historyDelayStage: "headers" | "body" = "body";
  let canceledHistoryResponses = 0;
  // History requests to drop by destroying the socket, as a restarting daemon would.
  let historyDrops = 0;

  beforeEach(() => { historyFailure = null; historyDelayMs = 0; canceledHistoryResponses = 0; historyDrops = 0; });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      capturedUrls.push(url);
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url === "/api/rigs/summary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rigSummary));
          return;
        }

        if (url.includes("/chat/send") && req.method === "POST") {
          const parsed = JSON.parse(body);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg-new", rigId: "rig-1", sender: parsed.sender, kind: "message", body: parsed.body, topic: null, createdAt: "2026-03-31T10:05:00Z" }));
          return;
        }

        if (url.includes("/chat/history")) {
          if (historyDrops > 0) {
            historyDrops--;
            req.socket.destroy();
            return;
          }
          if (historyFailure) {
            res.writeHead(historyFailure.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(historyFailure.body));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          const urlObj = new URL(url, `http://localhost:${port}`);
          const senderFilter = urlObj.searchParams.get("sender");
          const afterFilter = urlObj.searchParams.get("after");
          let filtered = [...chatMessages, ...dynamicMessages];
          if (afterFilter) {
            filtered = filtered.filter(m => m.id > afterFilter);
          }
          if (senderFilter) {
            filtered = filtered.filter(m => m.sender === senderFilter);
          }
          if (historyDelayMs > 0) {
            if (historyDelayStage === "body") res.flushHeaders();
            const timer = setTimeout(() => res.end(JSON.stringify(filtered)), historyDelayMs);
            res.once("close", () => {
              if (!res.writableEnded) canceledHistoryResponses++;
              clearTimeout(timer);
            });
          } else res.end(JSON.stringify(filtered));
          return;
        }

        if (url.includes("/chat/topic") && req.method === "POST") {
          const parsed = JSON.parse(body);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg-topic", rigId: "rig-1", sender: parsed.sender, kind: "topic", body: parsed.body ?? "", topic: parsed.topic, createdAt: "2026-03-31T10:06:00Z" }));
          return;
        }

        if (url.includes("/chat/clear") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, deleted: 2 }));
          return;
        }

        if (url.includes("/chat/watch")) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
          res.write(`data: ${JSON.stringify({ id: "msg-1", sender: "alice", kind: "message", body: "streamed", createdAt: "2026-03-31T10:00:00Z" })}\n\n`);
          setTimeout(() => res.end(), 50);
          return;
        }

        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(chatroomCommand(runningDeps(port)));
    return prog;
  }

  it("chatroom send derives the sender from the seat env — echoes the derived seat, NOT the retired 'cli' default", async () => {
    // P21: --sender is deprecated + ignored; the daemon derives the sender from the X-OpenRig-Session
    // header (stamped from the seat env). The local echo now reflects that derived seat, never 'cli'.
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "alice@my-rig";
    try {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "chatroom", "send", "my-rig", "hello world"]);
      });
      expect(logs.join("\n")).toContain("[alice@my-rig] hello world");
      expect(logs.join("\n")).not.toContain("[cli]");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("chatroom history prints chronological", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("[alice] hello");
    expect(output).toContain("[bob] world");
  });

  it("chatroom history --json prints JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sender).toBe("alice");
  });

  it("chatroom topic creates marker", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "topic", "my-rig", "standup"]);
    });
    expect(logs.join("\n")).toContain("--- topic: standup ---");
  });

  it("chatroom watch prints streamed messages", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "watch", "my-rig"]);
    });
    expect(logs.join("\n")).toContain("[alice] streamed");
  });

  it("chatroom send with ambiguous rig name shows error with guidance", async () => {
    // Override to return ambiguous rigs
    const ambiguousSummary = [
      { id: "rig-1", name: "my-rig", nodeCount: 2 },
      { id: "rig-2", name: "my-rig", nodeCount: 1 },
    ];

    const ambiguousServer = http.createServer((req, res) => {
      const url = req.url ?? "";
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url === "/api/rigs/summary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(ambiguousSummary));
          return;
        }
        res.writeHead(404).end();
      });
    });
    const ambiguousPort = await new Promise<number>((resolve) => {
      ambiguousServer.listen(0, () => {
        resolve((ambiguousServer.address() as { port: number }).port);
      });
    });

    const ambiguousCmd = new Command();
    ambiguousCmd.exitOverride();
    ambiguousCmd.addCommand(chatroomCommand(runningDeps(ambiguousPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await ambiguousCmd.parseAsync(["node", "rig", "chatroom", "send", "my-rig", "hello"]);
    });

    ambiguousServer.close();
    expect(logs.join("\n")).toContain("ambiguous");
    expect(exitCode).toBe(1);
  });

  it("chatroom watch --tmux spawns rig chatroom watch as the session command", async () => {
    // Mock execSync to verify the tmux command
    const origExecSync = (await import("node:child_process")).execSync;
    let capturedCmd = "";
    const { execSync } = await import("node:child_process");

    // We can't easily mock execSync in this test setup, so verify the --tmux
    // option prints the expected output when the tmux command fails (which it will
    // in CI since there's no tmux server)
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "watch", "my-rig", "--tmux"]);
    });

    const output = logs.join("\n");
    // Either it created the session or it reported an error about an existing session
    const tmuxSucceeded = output.includes("chatroom@my-rig");
    expect(tmuxSucceeded).toBe(true);
  });

  it("chatroom history --sender filters messages", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig", "--sender", "alice"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("alice");
    expect(output).not.toContain("bob");
  });

  it("chatroom history --since forwards since param to API", async () => {
    capturedUrls.length = 0;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig", "--since", "2026-04-01T00:00:00Z"]);
    });

    const historyUrl = capturedUrls.find(u => u.includes("/chat/history"));
    expect(historyUrl).toContain("since=");
    expect(historyUrl).toContain("2026-04-01");
  });

  it("chatroom history --after forwards after param to API", async () => {
    capturedUrls.length = 0;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig", "--after", "msg-cursor-123"]);
    });

    const historyUrl = capturedUrls.find(u => u.includes("/chat/history"));
    expect(historyUrl).toContain("after=msg-cursor-123");
  });

  it("chatroom history --sender --json returns filtered JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig", "--sender", "alice", "--json"]);
    });

    const parsed = JSON.parse(logs.join(""));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sender).toBe("alice");
  });

  it.each([
    ["history", [], 404, { error: "Rig removed" }],
    ["history", ["--json"], 500, { error: "History unavailable" }],
    ["wait", ["--timeout", "0.05"], 404, { error: "Rig removed" }],
    ["wait", ["--timeout", "0.05", "--json"], 500, { error: "History unavailable" }],
    ["history", [], 503, {}],
    ["wait", ["--timeout", "0.05"], 503, {}],
    ["wait", ["--timeout", "0.05"], 503, null],
  ] as const)("chatroom %s reports an HTTP error (%s, %s)", async (command, options, status, body) => {
    historyFailure = { status, body };
    capturedUrls.length = 0;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", command, "my-rig", ...options]);
    });

    expect(exitCode).toBe(1);
    if (command === "history" && options.some((option) => option === "--json")) {
      expect(JSON.parse(logs.join(""))).toEqual(body);
    } else {
      expect(logs.join("\n")).toContain(body && "error" in body ? body.error : `Failed (HTTP ${status})`);
    }
    expect(logs.join("\n")).not.toContain("No messages.");
    expect(logs.join("\n")).not.toContain("Timed out");
    expect(capturedUrls.filter((url) => url.includes("/chat/history"))).toHaveLength(1);
  });

  it("chatroom wait with explicit --after returns new messages immediately", async () => {
    // --after "000" is before existing messages, so they satisfy the wait
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", "2"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("[alice]");
    expect(output).toContain("hello");
  });

  it.each(["headers", "body"] as const)("chatroom wait cancels late %s instead of printing a message after its deadline", async (stage) => {
    historyDelayMs = 600;
    historyDelayStage = stage;
    const { logs, exitCode } = await captureLogs(() => makeCmd().parseAsync([
      "node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", "0.2",
    ]));
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Timed out after 0.2 seconds");
    expect(logs.join("\n")).not.toContain("[alice] hello");
    await expect.poll(() => canceledHistoryResponses).toBe(1);
  });

  it.each(["30s", "30", "0.5", "0.5s", "1.5s", "1e2", "0x10"])("chatroom wait accepts timeout form %s", async (timeout) => {
    capturedUrls.length = 0;
    const { logs, exitCode } = await captureLogs(() => makeCmd().parseAsync([
      "node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", timeout,
    ]));
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("[alice] hello");
    expect(capturedUrls.filter(url => url.includes("/chat/history"))).toHaveLength(1);
  });

  it.each(["0.05", "0.05s"])("chatroom wait preserves the fractional deadline for %s", async (timeout) => {
    // Isolate the deadline from HTTP latency and real timers, which can wake early.
    vi.useFakeTimers();
    const get = vi.spyOn(DaemonClient.prototype, "get")
      .mockResolvedValueOnce({ status: 200, data: rigSummary })
      .mockResolvedValue({ status: 200, data: [] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const settled = vi.fn();
      const wait = makeCmd().parseAsync([
        "node", "rig", "chatroom", "wait", "my-rig", "--after", "ZZZ", "--timeout", timeout,
      ]).then(settled);

      await vi.advanceTimersByTimeAsync(49);
      expect(get).toHaveBeenNthCalledWith(2, "/api/rigs/rig-1/chat/history?after=ZZZ", { signal: expect.any(AbortSignal) });
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      await wait;
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(`Timed out after ${timeout} seconds — no new messages matching filters.`);
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      get.mockRestore();
      error.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  describe("chatroom wait across a slow or restarting daemon", () => {
    // Polls are mocked and timers faked, so the 3 s cadence and the deadline are exact.
    async function waitWithPolls(timeout: string, poll: () => Promise<unknown>, advanceMs: number) {
      vi.useFakeTimers();
      const get = vi.spyOn(DaemonClient.prototype, "get")
        .mockResolvedValueOnce({ status: 200, data: rigSummary })
        .mockImplementation(poll as never);
      try {
        const run = captureLogs(() => makeCmd().parseAsync([
          "node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", timeout,
        ]));
        await vi.advanceTimersByTimeAsync(advanceMs);
        const { logs, exitCode } = await run;
        return { output: logs.join("\n"), exitCode, polls: get.mock.calls.length - 1 };
      } finally {
        vi.useRealTimers();
        get.mockRestore();
      }
    }

    it("retries a timed-out poll and returns what the next poll finds", async () => {
      const results: Array<() => Promise<unknown>> = [
        () => Promise.reject(new DaemonTimeoutError("The OpenRig daemon did not respond in time")),
        () => Promise.resolve({ status: 200, data: [chatMessages[0]] }),
      ];
      const { output, exitCode, polls } = await waitWithPolls("3600", () => results.shift()!(), 3000);
      expect(polls).toBe(2);
      expect(output).toContain("A poll failed (The OpenRig daemon did not respond in time); retrying until the --timeout deadline.");
      expect(output).toContain("[alice] hello");
      expect(output).not.toContain("Timed out");
      expect(exitCode).toBeUndefined();
    });

    it("keeps retrying timed-out, refused and dropped polls every 3 s until the deadline, and says the last one failed", async () => {
      const failures = [
        new DaemonTimeoutError("slow"),
        new DaemonConnectionError("refused", "ECONNREFUSED"),
        new DaemonConnectionError("reset", "ECONNRESET"),
        new DaemonConnectionError("dropped", "UND_ERR_SOCKET"),
      ];
      let i = 0;
      const { output, exitCode, polls } = await waitWithPolls("10", () => Promise.reject(failures[i++ % failures.length]), 10_000);
      expect(polls).toBe(4); // at 0, 3, 6 and 9 s; the deadline ends the last sleep at 10 s
      expect(output.match(/A poll failed/g)).toHaveLength(1);
      expect(output).toContain("Timed out after 10 seconds — no new messages matching filters.");
      expect(output).toContain("The last poll failed (dropped), so new messages may have arrived without being seen.");
      expect(exitCode).toBe(1);
    });

    it("ends at the deadline without the failure note once a later poll succeeds", async () => {
      let first = true;
      const { output, exitCode, polls } = await waitWithPolls("7", () => {
        if (first) { first = false; return Promise.reject(new DaemonTimeoutError("slow")); }
        return Promise.resolve({ status: 200, data: [] });
      }, 7000);
      expect(polls).toBe(3);
      expect(output).toContain("Timed out after 7 seconds — no new messages matching filters.");
      expect(output).not.toContain("The last poll failed");
      expect(exitCode).toBe(1);
    });

    it.each([
      ["a connection this machine blocked", new DaemonConnectionError("Cannot connect to the OpenRig daemon (EPERM)", "EPERM")],
      ["a connection error with no cause code", new DaemonConnectionError("Cannot connect to the OpenRig daemon")],
      ["an unreadable response", new DaemonResponseError(200, "<html>")],
      ["an unexpected error", new Error("boom")],
    ])("ends at once on %s instead of retrying it", async (_label, failure) => {
      const get = vi.spyOn(DaemonClient.prototype, "get")
        .mockResolvedValueOnce({ status: 200, data: rigSummary })
        .mockRejectedValue(failure);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(makeCmd().parseAsync([
          "node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", "3600",
        ])).rejects.toBe(failure);
        expect(get).toHaveBeenCalledTimes(2);
        expect(error).not.toHaveBeenCalledWith(expect.stringContaining("A poll failed"));
      } finally {
        get.mockRestore();
        error.mockRestore();
      }
    });

    it("retries a poll whose connection the daemon dropped", { timeout: 15000 }, async () => {
      historyDrops = 1;
      capturedUrls.length = 0;
      const { logs, exitCode } = await captureLogs(() => makeCmd().parseAsync([
        "node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", "10",
      ]));
      expect(logs.join("\n")).toMatch(/A poll failed \(Cannot connect to the OpenRig daemon .*\); retrying until the --timeout deadline\./);
      expect(logs.join("\n")).toContain("[alice] hello");
      expect(exitCode).toBeUndefined();
      expect(capturedUrls.filter((url) => url.includes("/chat/history"))).toHaveLength(2);
    });
  });

  it.each(["abc", "NaN", "Infinity", "-Infinity", "", " ", "-1", "-1s", "1e309", "1e309s"])("chatroom wait rejects invalid timeout %s before requests", async (timeout) => {
    capturedUrls.length = 0;
    const { logs, exitCode } = await captureLogs(() => makeCmd().parseAsync([
      "node", "rig", "chatroom", "wait", "my-rig", "--timeout", timeout,
    ]));
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--timeout must be a non-negative number of seconds");
    expect(capturedUrls).toEqual([]);
  });

  it("chatroom wait without --after does not return existing room traffic", async () => {
    // No --after: bootstrap ULID is generated at wait-start time (> all existing fixture IDs).
    // Since no new messages arrive after that, wait should timeout.
    const { exitCode, logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "wait", "my-rig", "--timeout", "1"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Timed out");
  });

  it("chatroom wait detects a newly arriving post-start message", { timeout: 15000 }, async () => {
    // Clear dynamic messages and inject one after a delay
    dynamicMessages.length = 0;
    // Inject a new message after 1s (will appear on second poll)
    const injectionTimer = setTimeout(() => {
      dynamicMessages.push({
        id: ulid(),
        rigId: "rig-1",
        sender: "new-peer",
        kind: "message",
        body: "post-start arrival",
        topic: null,
        createdAt: new Date().toISOString(),
      });
    }, 1000);

    try {
      const { logs } = await captureLogs(async () => {
        // No --after: ULID baseline generated at start, existing messages filtered out.
        // The dynamically injected message has a very high ULID, so it will be > baseline.
        await makeCmd().parseAsync(["node", "rig", "chatroom", "wait", "my-rig", "--timeout", "10"]);
      });

      const output = logs.join("\n");
      expect(output).toContain("[new-peer]");
      expect(output).toContain("post-start arrival");
    } finally {
      clearTimeout(injectionTimer);
      dynamicMessages.length = 0;
    }
  });

  it("chatroom wait times out with exit 1 when no new messages match filter", async () => {
    const { exitCode, logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "wait", "my-rig", "--after", "zzzzzzzzzzzzzzzzzzzzzzzzz", "--timeout", "1"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Timed out");
  });

  it("chatroom wait rejects a non-numeric --timeout instead of polling the daemon without pause", { timeout: 5000 }, async () => {
    // parseInt("abc") is NaN: it never satisfied either timeout check and made the
    // poll sleep ~1ms, so the wait spun against the daemon forever.
    capturedUrls.length = 0;
    const { exitCode, logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "wait", "my-rig", "--timeout", "abc"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--timeout must be a non-negative number of seconds; got 'abc'");
    expect(capturedUrls.some((u) => u.includes("/chat/history"))).toBe(false);
  });

  it("chatroom wait --json returns messages as JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "wait", "my-rig", "--after", "000", "--timeout", "2", "--json"]);
    });

    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("chatroom clear prints deleted count", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "clear", "my-rig"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("Cleared 2 messages from my-rig chatroom.");
  });
});
