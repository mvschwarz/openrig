import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTmux, readTmuxServerArgs } from "../src/tmux-attachment.js";
import { readWindowsTileAttachArgv } from "@openrig/daemon/windows-launch";

vi.mock("node:child_process", async () => ({ ...await vi.importActual("node:child_process"), spawn: vi.fn() }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("tmux attachment", () => {
  it.skipIf(process.platform !== "win32").each([false, true])("uses the verified single-attach wrapper for mapped native names (read-only=%s)", async readOnly => {
    const child = new EventEmitter(); vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const result = attachTmux({ session: "owned|logical", serverArgs: ["-L", "owned-home"], readOnly });
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(readWindowsTileAttachArgv([String(file), ...args as string[]])).toMatchObject({ session: "owned|logical", server: ["-L", "owned-home"], readOnly, attachOnly: true });
    expect(options).toMatchObject({ stdio: "inherit", windowsHide: true });
    child.emit("exit", 7); await expect(result).resolves.toBe(7);
  });
  it.each([false, true])("passes the exact server and session as argv and clears nesting markers (read-only=%s)", async readOnly => {
    vi.stubEnv("TMUX", "/other/server,7,0");
    vi.stubEnv("TMUX_PANE", "%1");
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const result = attachTmux({ session: "-seat ' quoted", serverArgs: ["-S", "/private/instance socket"], readOnly });
    expect(spawn).toHaveBeenCalledWith("tmux", [
      "-S", "/private/instance socket", "attach-session", ...(readOnly ? ["-r"] : []), "-t", "=-seat ' quoted",
    ], expect.objectContaining({ stdio: "inherit" }));
    const env = vi.mocked(spawn).mock.calls[0]![2]!.env!;
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(process.env.TMUX).toBe("/other/server,7,0");
    child.emit("exit", 3);
    await expect(result).resolves.toBe(3);
  });

  it("surfaces spawn failures and signal exits", async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const failed = attachTmux({ session: "seat", serverArgs: [] });
    const assertion = expect(failed).rejects.toThrow("tmux unavailable");
    child.emit("error", new Error("tmux unavailable"));
    await assertion;
    const signaled = attachTmux({ session: "seat", serverArgs: [] });
    child.emit("exit", null);
    await expect(signaled).resolves.toBe(1);
  });

  it.each([null, ["-S"], ["-S", ""], ["-S", "bad\0socket"], ["-L", 7], ["-S", "socket", "kill-server"]])(
    "rejects malformed server metadata: %j", value => {
      expect(() => readTmuxServerArgs(value)).toThrow("invalid tmux server options");
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
