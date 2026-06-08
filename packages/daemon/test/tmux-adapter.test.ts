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
    it("returns true when tmux has-session exits 0", async () => {
      const adapter = new TmuxAdapter(mockExec({ "has-session": { stdout: "" } }));
      expect(await adapter.hasSession("target-session")).toBe(true);
    });

    it("returns false when session not found", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("session not found: missing-session") },
      }));
      expect(await adapter.hasSession("missing-session")).toBe(false);
    });

    it("returns false when can't find session", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("can't find session: old-session") },
      }));
      expect(await adapter.hasSession("old-session")).toBe(false);
    });

    it("returns false on 'no server running' error", async () => {
      const adapter = new TmuxAdapter(mockExec({ "has-session": { error: NO_SERVER_ERROR } }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });

    it("throws on unexpected probe error (permission denied / socket failure)", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /tmp/tmux-501/default (Permission denied)") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("Permission denied");
    });

    it("throws on generic unrecognized exec error", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("Command failed with exit code 127") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("exit code 127");
    });

    // L1 cold-start tmux truth repair: post-reboot socket absence must classify
    // as "no session" so the reconciler can detach stale rows without manual fix.
    it("returns false when tmux socket is gone post-reboot (No such file or directory)", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)") },
      }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });

    it("returns false on Connection refused against a tmux socket path", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /private/tmp/tmux-501/default (Connection refused)") },
      }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });

    it("rethrows on 'Operation not permitted' (permission must remain fail-closed)", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /private/tmp/tmux-501/default (Operation not permitted)") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("Operation not permitted");
    });

    it("rethrows on EACCES (permission must remain fail-closed)", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("EACCES: permission denied, /private/tmp/tmux-501/default") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("EACCES");
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
      // OPR.0.3.3.17: the inline path now carries the `--` end-of-options
      // sentinel; inert for non-dash content (only delta vs pre-fix is `-- `).
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' -l -- 'hello world'"
      );
    });

    it("with shell-sensitive content is properly quoted", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendText("r01-dev1-impl", "echo \"hello\" && $HOME's dir");

      expect(exec).toHaveBeenCalledOnce();
      // OPR.0.3.3.17: `-- ` inserted before the quoted text; quoting unchanged.
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' -l -- 'echo \"hello\" && $HOME'\"'\"'s dir'"
      );
    });

    // OPR.0.3.3.17 AC-1/AC-4 DISCRIMINATOR (flip-proven): dash-prefixed inline
    // content (--- YAML frontmatter, the norm for per-seat packs) must carry the
    // -- end-of-options sentinel before the text, else tmux send-keys parses the
    // content as flags and the delivery fails (seat boots blind). This assertion
    // FAILS against the pre-fix `-l '<text>'` construction and PASSES after the
    // fix `-l -- '<text>'`. A test that passes against both forms is false coverage.
    it("inserts the -- end-of-options sentinel before dash-prefixed (--- frontmatter) content", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendText("r01-dev1-impl", "---\ntitle: pack\n---");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' -l -- '---\ntitle: pack\n---'"
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
      // OPR.0.3.3.17: inline path now carries the `--` end-of-options sentinel.
      expect(exec.mock.calls[2]![0]).toBe(
        "tmux send-keys -t 'dev-impl@auth-feats' -l -- 'hello'"
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

  // Slice 15 — terminal-active signal via tmux monitor-silence.
  // monitor-silence is a WINDOW option (set with -w on the target). The
  // tmux runtime maintains a per-pane `pane_silence_flag` which flips to
  // "1" when the pane has been silent past the threshold, "0" while it
  // is producing output.
  describe("setMonitorSilence", () => {
    it("constructs `tmux set-option -w -t <target> monitor-silence <seconds>`", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.setMonitorSilence("dev@rig", 3);

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux set-option -w -t 'dev@rig' monitor-silence '3'",
      );
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new TmuxAdapter(mockExec({ "set-option": { stdout: "" } }));
      const result = await adapter.setMonitorSilence("dev@rig", 5);
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: false, code: 'session_not_found' } when tmux says it can't find session", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "set-option": { error: new Error("can't find session: dev@rig") },
      }));
      const result = await adapter.setMonitorSilence("dev@rig", 3);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("session_not_found");
    });

    it("quotes shell-sensitive session names", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.setMonitorSilence("name with 'apos", 3);

      const cmd = exec.mock.calls[0]![0];
      expect(cmd).toContain("tmux set-option -w");
      expect(cmd).toContain("monitor-silence '3'");
      // The apostrophe must be escaped — no raw `name with 'apos'` substring leaks.
      expect(cmd).not.toContain("name with 'apos monitor-silence");
    });

    it("rejects non-integer / non-positive seconds with a clear error (defense at adapter boundary)", async () => {
      const adapter = new TmuxAdapter(vi.fn<ExecFn>().mockResolvedValue(""));
      await expect(adapter.setMonitorSilence("dev@rig", 0)).resolves.toMatchObject({ ok: false });
      await expect(adapter.setMonitorSilence("dev@rig", -1)).resolves.toMatchObject({ ok: false });
      await expect(adapter.setMonitorSilence("dev@rig", 3.5)).resolves.toMatchObject({ ok: false });
      await expect(adapter.setMonitorSilence("dev@rig", Number.NaN)).resolves.toMatchObject({ ok: false });
    });
  });

  describe("readPaneLastActivity", () => {
    it("constructs `tmux display-message -p -t <pane> '#{window_activity}'`", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("1716000000\n");
      const adapter = new TmuxAdapter(exec);

      await adapter.readPaneLastActivity("dev@rig");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux display-message -p -t 'dev@rig' '#{window_activity}'",
      );
    });

    it("returns the Unix-epoch-seconds integer when tmux yields a numeric value", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "1716000000\n" } }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(1716000000);
    });

    it("returns null on read error / missing session (no signal)", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "display-message": { error: new Error("can't find session: dev@rig") },
      }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(null);
    });

    it("returns null when tmux returns a blank value (slice 15 BLOCKING-fix discriminator — observed on tmux 3.6a)", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "" } }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(null);
    });

    it("returns null on unparseable output (defensive — daemon code should not crash on tmux quirks)", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "garbage" } }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(null);
    });

    it("returns null on zero / negative integers (sentinel from uninitialized window_activity)", async () => {
      const a = new TmuxAdapter(mockExec({ "display-message": { stdout: "0\n" } }));
      expect(await a.readPaneLastActivity("dev@rig")).toBe(null);
      const b = new TmuxAdapter(mockExec({ "display-message": { stdout: "-5\n" } }));
      expect(await b.readPaneLastActivity("dev@rig")).toBe(null);
    });
  });

  // OPR.0.3.3.16 - large-payload transport. A >100KB startup pack embedded in
  // one tmux/shell argv exceeds the OS per-arg limit and the launch silently
  // fails, so sendText routes large text through a temp file + tmux buffer.
  // The correctness pivot is `paste-buffer -d -r`: `-r` preserves raw LF (tmux's
  // default paste replaces LF->CR = Enter = catastrophic per-line submit in the
  // Claude/Codex TUIs); `-d` drops the buffer after a successful paste.
  describe("sendText large-payload buffer path", () => {
    // Just over the 100KB byte threshold (ASCII => 1 byte/char).
    const BIG = "x".repeat(100 * 1024 + 1);

    function fixedFileOps() {
      const writeFile = vi.fn(async () => {});
      const unlink = vi.fn(async () => {});
      return {
        ops: {
          writeFile,
          unlink,
          tmpName: () => "/tmp/openrig-tmux-send-FIXED.txt",
          bufferName: () => "openrig_FIXED",
        },
        writeFile,
        unlink,
      };
    }

    it("writes a temp file via fs and delivers via load-buffer + paste-buffer -d -r; payload never in any exec command", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const { ops, writeFile, unlink } = fixedFileOps();
      const adapter = new TmuxAdapter(exec, ops);

      const result: TmuxResult = await adapter.sendText("dev@rig", BIG);

      expect(result).toEqual({ ok: true });
      // The raw payload is written to disk via fs, NOT embedded in a shell command.
      expect(writeFile).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt", BIG);
      const cmds = exec.mock.calls.map((c) => c[0] as string);
      expect(cmds).toEqual([
        "tmux load-buffer -b 'openrig_FIXED' '/tmp/openrig-tmux-send-FIXED.txt'",
        "tmux paste-buffer -t 'dev@rig' -b 'openrig_FIXED' -d -r",
      ]);
      // The argv-size regression: the payload must never reach an exec command.
      for (const cmd of cmds) expect(cmd).not.toContain(BIG);
      // Temp file cleaned up in finally.
      expect(unlink).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt");
    });

    it("keeps the exact inline send-keys -l command for a small payload (no buffer path, no temp file)", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const { ops, writeFile } = fixedFileOps();
      const adapter = new TmuxAdapter(exec, ops);

      await adapter.sendText("dev@rig", "hello world");

      expect(exec).toHaveBeenCalledOnce();
      // OPR.0.3.3.17: inline path now carries the `--` end-of-options sentinel;
      // still the inline path (no buffer, no temp file) for a small payload.
      expect(exec.mock.calls[0]![0]).toBe("tmux send-keys -t 'dev@rig' -l -- 'hello world'");
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("missing target on the large path returns session_not_found and leaks no temp file or buffer", async () => {
      // load-buffer succeeds (buffer is global); paste-buffer fails on missing target.
      const exec = vi.fn<ExecFn>(async (cmd: string) => {
        if (cmd.includes("paste-buffer")) throw new Error("can't find session: dev@rig");
        return "";
      });
      const { ops, unlink } = fixedFileOps();
      const adapter = new TmuxAdapter(exec, ops);

      const result = await adapter.sendText("dev@rig", BIG);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("session_not_found");
      const cmds = exec.mock.calls.map((c) => c[0] as string);
      // Buffer was loaded then explicitly deleted on the error path (no leak).
      expect(cmds).toContain("tmux delete-buffer -b 'openrig_FIXED'");
      // Temp file unlinked regardless of failure (no leak).
      expect(unlink).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt");
    });

    it("generates a unique temp file and buffer name per call (concurrency-safe for parallel rig up)", async () => {
      // Default (production) fileOps - proves the real generators are unique.
      // exec is mocked so no real tmux runs; the temp file is written to the OS
      // tmpdir and removed in finally.
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendText("dev@rig", BIG);
      await adapter.sendText("dev@rig", BIG);

      const loadCmds = exec.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.startsWith("tmux load-buffer"));
      expect(loadCmds).toHaveLength(2);
      expect(loadCmds[0]).not.toBe(loadCmds[1]);
    });
  });
});
