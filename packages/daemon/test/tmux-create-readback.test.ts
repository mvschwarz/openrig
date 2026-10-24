import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";

// tmux can exit 0 having made nothing: a server that can't create its socket prints its error and quits, and the client
// still exits 0. A launch then read as created, and `rig up` reported the seat launched with no terminal.
const socketGone = "error connecting to /fixture/cli/tmux.sock (No such file or directory)\n";

/** The create call: new-session, or the private config that carries it (start-server ; source-file <file>). */
const creates = (args: string[]) => args[1] === "new-session" || args.includes("source-file");

function adapter(respond: (args: string[]) => Promise<string>) {
  const calls: string[][] = [];
  const a = new TmuxAdapter(async () => { throw new Error("argv only"); }, undefined, async args => { calls.push(args); return respond(args); });
  return { a, calls };
}

describe("createSession reads the session back when new-session reports no pane", () => {
  it("no pane and no server: the launch fails as unconfirmed with tmux's own error, and nothing more is sent", async () => {
    const { a, calls } = adapter(async args => {
      if (args[1] === "has-session") throw Object.assign(new Error(`Command failed: tmux has-session -t =seat\n${socketGone}`), { execStderr: socketGone });
      return "";
    });
    const result = await a.createSession("seat");
    // A read-back that can't reach tmux doesn't establish absence.
    expect(result).toMatchObject({ ok: false, code: "session_unconfirmed" });
    expect(result.ok === false && result.message).toContain(`creation of session "seat" could not be confirmed (${socketGone.trim()})`);
    expect(calls.map(c => creates(c) ? "create" : c[1])).toEqual(["create", "has-session"]);
  });

  it("no pane and tmux says the session isn't there: the launch fails as not created", async () => {
    const { a } = adapter(async args => {
      if (args[1] === "has-session") throw Object.assign(new Error("Command failed: tmux has-session -t =seat\ncan't find session: seat\n"), { execStderr: "can't find session: seat\n" });
      return "";
    });
    const result = await a.createSession("seat");
    expect(result).toMatchObject({ ok: false, code: "session_not_created" });
    expect(result.ok === false && result.message).toContain(`no session "seat" exists`);
  });

  it("no pane but the session is there: the launch stands, as before", async () => {
    const { a } = adapter(async () => "");
    expect((await a.createSession("seat")).ok).toBe(true);
  });

  it("a pane: no read-back", async () => {
    const { a, calls } = adapter(async args => creates(args) ? "%4\n" : "");
    expect((await a.createSession("seat")).ok).toBe(true);
    expect(calls.some(c => c[1] === "has-session")).toBe(false);
  });
});

const hasTmux = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

// Root reads any directory, so the unwritable socket parent only stops a non-root user.
describe.skipIf(process.platform === "win32" || !hasTmux || process.getuid?.() === 0)("real tmux whose server can't create its socket", () => {
  it("createSession never reports the launch created", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
    const parent = path.join(home, "ro");
    fs.mkdirSync(parent, { mode: 0o500 });
    const socket = path.join(parent, "sock");
    // The production exec, on a private socket (-S wins over any $TMUX).
    const a = new TmuxAdapter(async () => { throw new Error("argv only"); }, undefined,
      args => execArgvCommand(["tmux", "-S", socket, "-f", "/dev/null", ...args.slice(1)]));
    try {
      const result = await a.createSession("seat");
      // tmux 3.6a exits 0 here with no pane id, so the read-back decides; tmux 3.8 exits non-zero, and the create itself fails.
      expect(result.ok).toBe(false);
      if (result.ok === false && result.code === "session_unconfirmed") {
        expect(result.message).toMatch(/creation of session "seat" could not be confirmed \(error connecting to \S*ro\/sock/);
      }
    } finally {
      fs.chmodSync(parent, 0o700);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
