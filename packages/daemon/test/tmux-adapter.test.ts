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
});
