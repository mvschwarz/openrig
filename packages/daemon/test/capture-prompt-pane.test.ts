// A seat sat at a native approval in an 18x12 pane, and `rig capture` showed only the bottom of the menu, so nobody could
// see what it was asking. A capture that shows a prompt in a pane smaller than 80x24 now says the prompt may be cut off,
// and how to resize the seat's window to read it.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDaemonTmuxServer, tmuxResizeWindowCommand } from "../src/adapters/tmux-server.js";
import { createDb } from "../src/db/connection.js";
import { transportRoutes } from "../src/routes/transport.js";
const exec = promisify(execFile);

// What an 18-column pane shows of a Claude Code approval: the question wraps, and only the bottom of the menu fits.
const NARROW_APPROVAL = ["Do you want to", "proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel"].join("\n") + "\n";
const SHELL = ["$ ls", "notes.md", "$"].join("\n") + "\n";

describe("rig capture says when a pane is too small to show the prompt the seat is at", () => {
  const dbs: Array<ReturnType<typeof createDb>> = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  async function make(screen: string, size: { width: number; height: number }) {
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", ...size, active: true }]);
    const tmux = { probeSession: vi.fn(async () => ({ state: "present" })), capturePaneContent: vi.fn(async () => screen), listPanes };
    const db = createDb(); dbs.push(db);
    const transport = Object.create(SessionTransport.prototype) as InstanceType<typeof SessionTransport>;
    Object.assign(transport, {
      db, tmuxAdapter: tmux,
      getSessionMeta: () => ({ runtime: "claude-code", attachmentType: "tmux", nodeId: "n1", pane: "%1", occupant: null, resumeToken: null }),
      absenceProbeTarget: () => null,
      now: () => new Date(),
      recordSessionMissingVerdict: () => {},
      reconcileStartupReadiness: async () => {},
    });
    return { transport, listPanes };
  }

  it("an approval in an 18x12 pane says the prompt may be cut off and how to resize the window", async () => {
    const { transport } = await make(NARROW_APPROVAL, { width: 18, height: 12 });
    const result = await transport.capture("review@rig", { promptPane: true });
    expect(result).toMatchObject({ ok: true, content: NARROW_APPROVAL, promptPane: { width: 18, height: 12 } });
    expect(result.promptPane?.hint).toBe(
      "pane 18x12 is smaller than 80x24, so the prompt may be cut off; resize it (tmux resize-window -t =review@rig: -x 120 -y 40) and capture again");
  });

  // Real private tmux server: a window in another session that has the seat's name must not be the one resized.
  it.skipIf(process.platform === "win32")("the resize command resizes the seat's own window, never a same-named window in another session", async () => {
    const root = mkdtempSync(join(tmpdir(), "resize-target-")), socket = join(root, "s");
    const env = { ...process.env }; delete env.TMUX;
    const tmux = async (args: string[]) => (await exec("tmux", ["-S", socket, ...args], { env })).stdout.trim();
    try {
      await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "review@rig", "-x", "18", "-y", "12", "sleep 60"]);
      await tmux(["new-session", "-d", "-s", "other", "-n", "review@rig", "-x", "90", "-y", "30", "sleep 60"]);
      setDaemonTmuxServer(["-S", socket]);
      await exec("/bin/sh", ["-c", tmuxResizeWindowCommand("review@rig", 120, 40)], { env });
      const sizes = (await tmux(["list-windows", "-a", "-F", "#{session_name} #{window_width}x#{window_height}"])).split("\n").sort();
      expect(sizes).toEqual(["other 90x30", "review@rig 120x40"]);
    } finally {
      setDaemonTmuxServer([]);
      await tmux(["kill-server"]).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the same approval in a normal pane, and a shell in a small pane, add nothing; only a prompt costs the size read", async () => {
    const normal = await make(NARROW_APPROVAL, { width: 120, height: 40 });
    expect(await normal.transport.capture("review@rig", { promptPane: true })).not.toHaveProperty("promptPane");
    const shell = await make(SHELL, { width: 18, height: 12 });
    expect(await shell.transport.capture("review@rig", { promptPane: true })).not.toHaveProperty("promptPane");
    expect(shell.listPanes).not.toHaveBeenCalled();
  });

  it("a caller that doesn't ask (the preview routes, attention recovery) gets main's result with no size read", async () => {
    const { transport, listPanes } = await make(NARROW_APPROVAL, { width: 18, height: 12 });
    expect(await transport.capture("review@rig", { lines: 20 })).toEqual({ ok: true, sessionName: "review@rig", content: NARROW_APPROVAL, lines: 20 });
    expect(listPanes).not.toHaveBeenCalled();
  });

  it("the capture route asks for it with the input box (rig capture and MCP ask; send --verify and walk don't)", async () => {
    const capture = vi.fn(async (sessionName: string, _opts?: unknown) => ({ ok: true, sessionName, content: "x\n", lines: 20 }));
    const transport = { capture, resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "a@r" }] }) };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
    app.route("/api/transport", transportRoutes());
    for (const body of [{ session: "a@r" }, { session: "a@r", inputBox: true }, { rig: "r", inputBox: true }]) {
      expect((await app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
    }
    expect(capture.mock.calls.map(([, opts]) => (opts as { promptPane?: boolean }).promptPane === true)).toEqual([false, true, true]);
  });
});
