import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn, TmuxResult } from "../src/adapters/tmux.js";

const NO_SERVER_ERROR = new Error("no server running on /tmp/tmux-1000/default");

function mockExec(responses: Record<string, { stdout?: string; error?: Error }>): ExecFn {
  return (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response.error) {
          return Promise.reject(response.error);
        }
        return Promise.resolve(response.stdout ?? "");
      }
    }
    return Promise.resolve("");
  };
}

describe("TmuxAdapter", () => {
  describe("listSessions", () => {
    it("calls exec with exact tmux list-sessions command and format string", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listSessions();

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-sessions -F "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}"'
      );
    });

    it("parses output into typed TmuxSession objects", async () => {
      const output = [
        "my-session\t1\t2026-03-23T01:00:00\t1",
        "other-sess\t3\t2026-03-23T02:00:00\t0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { stdout: output } }));
      const sessions = await adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.name).toBe("my-session");
      expect(sessions[0]!.windows).toBe(1);
      expect(sessions[0]!.attached).toBe(true);
      expect(sessions[1]!.name).toBe("other-sess");
      expect(sessions[1]!.windows).toBe(3);
      expect(sessions[1]!.attached).toBe(false);
    });

    it("returns empty array on 'no server running' error", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { error: NO_SERVER_ERROR } }));
      const sessions = await adapter.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe("listWindows", () => {
    it("calls exec with exact tmux list-windows command and format string", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listWindows("my-session");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-windows -t \'my-session\' -F "#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}"'
      );
    });

    it("shell-sensitive session name is quoted in list-windows", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listWindows("my session's name");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-windows -t \'my session\'\"\'\"\'s name\' -F "#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}"'
      );
    });

    it("parses output into typed TmuxWindow objects", async () => {
      const output = [
        "0\tmain\t1\t1",
        "1\twork\t2\t0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-windows": { stdout: output } }));
      const windows = await adapter.listWindows("my-session");

      expect(windows).toHaveLength(2);
      expect(windows[0]!.index).toBe(0);
      expect(windows[0]!.name).toBe("main");
      expect(windows[0]!.panes).toBe(1);
      expect(windows[0]!.active).toBe(true);
      expect(windows[1]!.index).toBe(1);
      expect(windows[1]!.active).toBe(false);
    });

    it("returns empty array on 'no server running' error", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-windows": { error: NO_SERVER_ERROR } }));
      const windows = await adapter.listWindows("my-session");
      expect(windows).toEqual([]);
    });
  });

  describe("listPanes", () => {
    it("calls exec with exact tmux list-panes command and format string", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listPanes("my-session:0");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-panes -t \'my-session:0\' -F "#{pane_id}\t#{pane_index}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_active}"'
      );
    });

    it("shell-sensitive target is quoted in list-panes", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listPanes("my session's:0");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-panes -t \'my session\'\"\'\"\'s:0\' -F "#{pane_id}\t#{pane_index}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_active}"'
      );
    });

    it("parses output into typed TmuxPane objects", async () => {
      const output = [
        "%1\t0\t/home/user/code\t180\t40\t1",
        "%2\t1\t/tmp\t180\t40\t0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-panes": { stdout: output } }));
      const panes = await adapter.listPanes("my-session:0");

      expect(panes).toHaveLength(2);
      expect(panes[0]!.id).toBe("%1");
      expect(panes[0]!.index).toBe(0);
      expect(panes[0]!.cwd).toBe("/home/user/code");
      expect(panes[0]!.active).toBe(true);
      expect(panes[1]!.id).toBe("%2");
      expect(panes[1]!.active).toBe(false);
    });

    it("returns empty array on 'no server running' error", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-panes": { error: NO_SERVER_ERROR } }));
      const panes = await adapter.listPanes("my-session:0");
      expect(panes).toEqual([]);
    });
  });

  describe("hasSession", () => {
    it("returns true when session exists", async () => {
      const output = "target-session\t1\t2026-03-23T01:00:00\t1\n";
      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { stdout: output } }));
      expect(await adapter.hasSession("target-session")).toBe(true);
    });

    it("returns false when session not in list", async () => {
      const output = "other-session\t1\t2026-03-23T01:00:00\t1\n";
      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { stdout: output } }));
      expect(await adapter.hasSession("missing-session")).toBe(false);
    });

    it("returns false on 'no server running' error", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { error: NO_SERVER_ERROR } }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });
  });

  describe("createSession", () => {
    it("calls exec with exact command (name + cwd, both quoted)", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev1-impl", "/home/user/code");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev1-impl' -c '/home/user/code'"
      );
    });

    it("with cwd containing spaces: path is quoted", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev1-impl", "/home/user/my project/code");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev1-impl' -c '/home/user/my project/code'"
      );
    });

    it("with shell-sensitive session name: name is quoted", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev's session", "/tmp");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev'\"'\"'s session' -c '/tmp'"
      );
    });

    it("without cwd omits -c flag", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev1-impl");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev1-impl'"
      );
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new TmuxAdapter(mockExec({ "new-session": { stdout: "" } }));
      const result: TmuxResult = await adapter.createSession("r01-dev1-impl");
      expect(result).toEqual({ ok: true });
    });

    it("with env map constructs -e flags for each key=value", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("dev-impl@rig", "/tmp", {
        OPENRIG_NODE_ID: "node123",
        OPENRIG_SESSION_NAME: "dev-impl@rig",
      });

      const cmd = exec.mock.calls[0]![0] as string;
      expect(cmd).toContain("-e 'OPENRIG_NODE_ID=node123'");
      expect(cmd).toContain("-e 'OPENRIG_SESSION_NAME=dev-impl@rig'");
      expect(cmd).toContain("-s 'dev-impl@rig'");
      expect(cmd).toContain("-c '/tmp'");
    });

    it("without env still works as before", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-test", "/tmp");

      const cmd = exec.mock.calls[0]![0] as string;
      expect(cmd).not.toContain("-e ");
      expect(cmd).toBe("tmux new-session -d -s 'r01-test' -c '/tmp'");
    });

    it("returns { ok: false, code: 'duplicate_session' } on duplicate", async () => {
      const err = new Error("duplicate session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "new-session": { error: err } }));
      const result = await adapter.createSession("r01-dev1-impl");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("duplicate_session");
      }
    });
  });

  describe("sendText", () => {
    it("calls exec with exact command using -l flag (target quoted)", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendText("r01-dev1-impl", "hello world");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' -l 'hello world'"
      );
    });

    it("with shell-sensitive content is properly quoted", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendText("r01-dev1-impl", "echo \"hello\" && $HOME's dir");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' -l 'echo \"hello\" && $HOME'\"'\"'s dir'"
      );
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new TmuxAdapter(mockExec({ "send-keys": { stdout: "" } }));
      const result: TmuxResult = await adapter.sendText("r01-dev1-impl", "test");
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: false, code: 'session_not_found' } on missing target", async () => {
      const err = new Error("can't find session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "send-keys": { error: err } }));
      const result = await adapter.sendText("r01-dev1-impl", "test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_not_found");
      }
    });
  });

  describe("sendKeys", () => {
    it("calls exec with exact command (target quoted, key names individually quoted)", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendKeys("r01-dev1-impl", ["C-c", "Enter"]);

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' 'C-c' 'Enter'"
      );
    });

    it("shell-sensitive key names are individually quoted", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendKeys("r01-dev1-impl", ["Enter; rm -rf /", "C-c"]);

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' 'Enter; rm -rf /' 'C-c'"
      );
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new TmuxAdapter(mockExec({ "send-keys": { stdout: "" } }));
      const result: TmuxResult = await adapter.sendKeys("r01-dev1-impl", ["Enter"]);
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: false, code: 'session_not_found' } on missing target", async () => {
      const err = new Error("can't find session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "send-keys": { error: err } }));
      const result = await adapter.sendKeys("r01-dev1-impl", ["Enter"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_not_found");
      }
    });
  });

  describe("killSession", () => {
    it("calls exec with exact quoted command", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.killSession("r01-dev1-impl");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux kill-session -t 'r01-dev1-impl'"
      );
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new TmuxAdapter(mockExec({ "kill-session": { stdout: "" } }));
      const result: TmuxResult = await adapter.killSession("r01-dev1-impl");
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: false, code: 'session_not_found' } on missing session", async () => {
      const err = new Error("can't find session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "kill-session": { error: err } }));
      const result = await adapter.killSession("r01-dev1-impl");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_not_found");
      }
    });

    it("with shell-sensitive name: exact quoted command", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.killSession("r01-dev's session");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux kill-session -t 'r01-dev'\"'\"'s session'"
      );
    });
  });

  describe("setSessionOption", () => {
    it("calls exec with exact tmux set-option command (session and key/value quoted)", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.setSessionOption("organic-session", "@rigged_node_id", "node-abc123");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux set-option -t 'organic-session' '@rigged_node_id' 'node-abc123'"
      );
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new TmuxAdapter(mockExec({ "set-option": { stdout: "" } }));
      const result = await adapter.setSessionOption("s", "@k", "v");
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: false, code: 'session_not_found' } on missing session", async () => {
      const err = new Error("can't find session: ghost");
      const adapter = new TmuxAdapter(mockExec({ "set-option": { error: err } }));
      const result = await adapter.setSessionOption("ghost", "@k", "v");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("session_not_found");
    });
  });

  describe("getSessionOption", () => {
    it("calls exec with exact tmux show-option -v command", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("node-abc123\n");
      const adapter = new TmuxAdapter(exec);

      const val = await adapter.getSessionOption("organic-session", "@rigged_node_id");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux show-option -v -t 'organic-session' '@rigged_node_id'"
      );
      expect(val).toBe("node-abc123");
    });

    it("returns null on error (session not found, no server, etc.)", async () => {
      const err = new Error("can't find session: ghost");
      const adapter = new TmuxAdapter(mockExec({ "show-option": { error: err } }));
      const val = await adapter.getSessionOption("ghost", "@rigged_node_id");
      expect(val).toBeNull();
    });

    it("returns null on empty output", async () => {
      const adapter = new TmuxAdapter(mockExec({ "show-option": { stdout: "\n" } }));
      const val = await adapter.getSessionOption("s", "@k");
      expect(val).toBeNull();
    });
  });

  describe("canonical session names with @", () => {
    it("createSession + sendKeys with @ in name produce correct quoted commands", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      // createSession with canonical name
      await adapter.createSession("dev-impl@auth-feats", "/home/user/code");
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'dev-impl@auth-feats' -c '/home/user/code'"
      );

      // sendKeys targeting canonical name
      await adapter.sendKeys("dev-impl@auth-feats", ["Enter"]);
      expect(exec.mock.calls[1]![0]).toBe(
        "tmux send-keys -t 'dev-impl@auth-feats' 'Enter'"
      );

      // sendText targeting canonical name
      await adapter.sendText("dev-impl@auth-feats", "hello");
      expect(exec.mock.calls[2]![0]).toBe(
        "tmux send-keys -t 'dev-impl@auth-feats' -l 'hello'"
      );
    });
  });

  describe("malformed output", () => {
    it("bad lines skipped, valid lines returned", async () => {
      const output = [
        "good-session\t2\t2026-03-23T01:00:00\t1",
        "this is garbage",
        "",
        "another-good\t1\t2026-03-23T02:00:00\t0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { stdout: output } }));
      const sessions = await adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.name).toBe("good-session");
      expect(sessions[1]!.name).toBe("another-good");
    });
  });

  // Discovery adapter extensions
  describe("getPanePid", () => {
    it("returns parsed integer PID from tmux output", async () => {
      const exec: ExecFn = async () => "1234\n";
      const adapter = new TmuxAdapter(exec);
      const pid = await adapter.getPanePid("%0");
      expect(pid).toBe(1234);
    });

    it("returns null for empty or non-numeric output", async () => {
      const exec: ExecFn = async () => "\n";
      const adapter = new TmuxAdapter(exec);
      expect(await adapter.getPanePid("%0")).toBeNull();

      const exec2: ExecFn = async () => "not-a-pid";
      const adapter2 = new TmuxAdapter(exec2);
      expect(await adapter2.getPanePid("%0")).toBeNull();
    });
  });

  describe("getPaneCommand", () => {
    it("returns command string from tmux output", async () => {
      const exec: ExecFn = async () => "claude\n";
      const adapter = new TmuxAdapter(exec);
      const cmd = await adapter.getPaneCommand("%0");
      expect(cmd).toBe("claude");
    });

    it("returns null for empty output", async () => {
      const exec: ExecFn = async () => "\n";
      const adapter = new TmuxAdapter(exec);
      expect(await adapter.getPaneCommand("%0")).toBeNull();
    });
  });

  describe("capturePaneContent", () => {
    it("calls exact tmux capture-pane command with shell quoting", async () => {
      const exec: ExecFn = vi.fn(async () => "line 1\nline 2\n") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      const content = await adapter.capturePaneContent("%0");

      expect(content).toBe("line 1\nline 2\n");
      expect(exec).toHaveBeenCalledWith("tmux capture-pane -p -t '%0' -S -20");
    });

    it("returns null on error", async () => {
      const exec: ExecFn = async () => { throw new Error("pane gone"); };
      const adapter = new TmuxAdapter(exec);

      expect(await adapter.capturePaneContent("%0")).toBeNull();
    });

    it("uses custom line count", async () => {
      const exec: ExecFn = vi.fn(async () => "output") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.capturePaneContent("%5", 50);

      expect(exec).toHaveBeenCalledWith("tmux capture-pane -p -t '%5' -S -50");
    });
  });

  describe("startPipePane", () => {
    it("constructs shell-safe command with quoted session name and path", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.startPipePane("dev-impl@my-rig", "/home/user/.openrig/transcripts/my-rig/dev-impl@my-rig.log");

      // The command is: tmux pipe-pane -t <quoted session> <quoted 'cat >> <quoted path>'>
      const cmd = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(cmd).toContain("tmux pipe-pane -t 'dev-impl@my-rig'");
      expect(cmd).toContain("cat >>");
      expect(cmd).toContain("dev-impl@my-rig.log");
    });

    it("quotes path with spaces safely inside pipe command", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.startPipePane("dev@rig", "/path/with spaces/transcript.log");

      const cmd = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(cmd).toContain("tmux pipe-pane -t 'dev@rig'");
      expect(cmd).toContain("cat >>");
      expect(cmd).toContain("with spaces");
    });

    it("handles apostrophes in path safely", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.startPipePane("dev@rig", "/path/it's/transcript.log");

      const cmd = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(cmd).toContain("tmux pipe-pane -t 'dev@rig'");
      // The apostrophe should be escaped, not left raw
      expect(cmd).not.toContain("it's/");
    });

    it("returns { ok: false } on session not found error", async () => {
      const exec: ExecFn = vi.fn(async () => { throw new Error("can't find session: dev@rig"); }) as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      const result = await adapter.startPipePane("dev@rig", "/tmp/test.log");
      expect(result).toEqual({ ok: false, code: "session_not_found", message: "can't find session: dev@rig" });
    });
  });

  describe("stopPipePane", () => {
    it("constructs correct empty pipe-pane command", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.stopPipePane("dev-impl@my-rig");

      expect(exec).toHaveBeenCalledWith("tmux pipe-pane -t 'dev-impl@my-rig'");
    });
  });
});
