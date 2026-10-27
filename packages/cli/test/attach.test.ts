import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { attachCommand, resolveAttachContext } from "../src/commands/attach.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
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
    ...overrides,
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
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
  };
}

describe("Attach CLI", () => {
  let server: http.Server;
  let port: number;
  let receivedBody: Record<string, unknown>;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/rigs/rig-1/attach-self" && req.method === "POST") {
        const parsed = body ? JSON.parse(body) : {};
        receivedBody = parsed;
        const logicalId = parsed.logicalId ?? `${parsed.podNamespace}.${parsed.memberName}`;
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          nodeId: "node-1",
          logicalId,
          sessionId: "sess-1",
          sessionName: "orch1-lead@rigged-buildout",
          attachmentType: "external_cli",
          env: {
            OPENRIG_NODE_ID: "node-1",
            OPENRIG_SESSION_NAME: "orch1-lead@rigged-buildout",
          },
        }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.configureOutput({
      writeOut: (str) => console.log(str.trimEnd()),
      writeErr: (str) => console.error(str.trimEnd()),
    });
    prog.addCommand(attachCommand(runningDeps(port)));
    return prog;
  }

  it("attach --self --node prints a human summary", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--node", "orch1.lead"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Attached this shell to node orch1.lead");
    expect(output).toContain("external_cli");
    expect(output).toContain("inbound tmux transport unavailable");
  });

  it("attach --self --node accepts the advertised runtime guard", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--node", "orch1.lead", "--runtime", "codex"]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Attached this shell to node orch1.lead");
    expect(receivedBody).toMatchObject({ logicalId: "orch1.lead", runtime: "codex" });
  });

  it("attach --self --print-env prints shell exports only", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--node", "orch1.lead", "--print-env"]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs).toEqual([
      "export OPENRIG_NODE_ID='node-1'",
      "export OPENRIG_SESSION_NAME='orch1-lead@rigged-buildout'",
    ]);
  });

  it("attach rejects missing --self", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--rig", "rig-1", "--node", "orch1.lead"]).catch(() => undefined);
    });

    expect(exitCode).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it.each(["--pod", "--member"])("attach rejects node mode combined with %s", async (flag) => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--node", "orch1.lead", "--runtime", "codex", flag, "orch1"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Specify either");
  });

  it("attach rejects incomplete pod mode before calling the daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--pod", "orch1", "--member", "lead"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.some((line) => line.includes("Pod attach requires"))).toBe(true);
  });

  it("resolveAttachContext detects tmux session metadata when TMUX_PANE is set", () => {
    const result = withTmuxPane("%42", () =>
      resolveAttachContext(fakeTmux({ session: "dev1-impl2@rigged-buildout", window: "@12", pane: "%42" })));
    expect(result).toEqual({
      attachmentType: "tmux",
      tmuxSession: "dev1-impl2@rigged-buildout",
      tmuxWindow: "@12",
      tmuxPane: "%42",
    });
  });

  // Real tmux rewrote the newlines of a combined format as "_" ("unrelated-shell_@2_%2"), and the session fell back to
  // external_cli, so replies to the self-attached member had no transport.
  it.each([
    ["the shape real tmux returned", "unrelated-shell"],
    ["a name holding underscores, spaces and id-like words", "team_1 rig_b @7 %9"],
  ])("resolveAttachContext resolves the pane from %s", (_label, session) => {
    const result = withTmuxPane("%2", () => resolveAttachContext(fakeTmux({ session, window: "@2", pane: "%2" })));
    expect(result).toEqual({ attachmentType: "tmux", tmuxSession: session, tmuxWindow: "@2", tmuxPane: "%2" });
  });

  it("resolveAttachContext keeps external_cli outside tmux, and when tmux can't answer", () => {
    const notCalled = vi.fn(() => "");
    expect(withTmuxPane(undefined, () => resolveAttachContext(notCalled))).toEqual({ attachmentType: "external_cli" });
    expect(notCalled).not.toHaveBeenCalled();
    for (const tmux of [vi.fn(() => { throw new Error("no server running"); }), vi.fn(() => ""), vi.fn(() => "unexpected")]) {
      expect(withTmuxPane("%2", () => resolveAttachContext(tmux))).toEqual({ attachmentType: "external_cli" });
    }
  });
});

const TMUX_SOCKET = `openrig-attach-test-${process.pid}`;
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;

describe.runIf(tmuxAvailable)("resolveAttachContext against a real tmux server (private socket)", () => {
  afterAll(() => { spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"]); });

  it("resolves the session, window and pane of a session whose name holds spaces and underscores", () => {
    const session = "unrelated_shell b";
    execFileSync("tmux", ["-L", TMUX_SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", session]);
    const read = (format: string) => execFileSync("tmux", ["-L", TMUX_SOCKET, "list-panes", "-t", `=${session}`, "-F", format],
      { encoding: "utf8" }).trim();
    const pane = read("#{pane_id}");
    const window = read("#{window_id}");
    const onSocket = (cmd: string) => execSync(cmd.replace(/^tmux /, `tmux -L ${TMUX_SOCKET} `), { encoding: "utf8" }).trim();
    expect(withTmuxPane(pane, () => resolveAttachContext(onSocket)))
      .toEqual({ attachmentType: "tmux", tmuxSession: session, tmuxWindow: window, tmuxPane: pane });
  });
});

/** A `tmux display-message -p` double that renders the requested format as real tmux does, control characters
 *  included: tmux writes each one as "_". */
function fakeTmux(values: { session: string; window: string; pane: string }) {
  return vi.fn((cmd: string) => {
    const format = /'([^']*)'\s*$/.exec(cmd)?.[1] ?? /"([^"]*)"\s*$/.exec(cmd)?.[1];
    if (format === undefined) throw new Error(`unexpected tmux command: ${cmd}`);
    return format.replace(/#\{session_name\}/g, values.session).replace(/#\{window_id\}/g, values.window)
      .replace(/#\{pane_id\}/g, values.pane).replace(/[\u0000-\u001f]/g, "_");
  });
}

function withTmuxPane<T>(pane: string | undefined, run: () => T): T {
  const saved = process.env["TMUX_PANE"];
  if (pane === undefined) delete process.env["TMUX_PANE"];
  else process.env["TMUX_PANE"] = pane;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env["TMUX_PANE"];
    else process.env["TMUX_PANE"] = saved;
  }
}
