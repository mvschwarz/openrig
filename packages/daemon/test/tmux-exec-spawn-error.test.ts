// A spawn error means the file never started: macOS reports a tmux script without a #! line as ENOEXEC, where Linux
// runs it through /bin/sh itself. The error is injected for the resolved file, so both hosts check the fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const spawned: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign((...a: Parameters<typeof real.execFile>) => real.execFile(...a), {
    [promisify.custom]: (file: string, args: string[], opts: object) => {
      spawned.push(file);
      if (file.endsWith("/refused/tmux")) {
        return Promise.reject(Object.assign(new Error(`spawn ${file} ENOEXEC`), { code: "ENOEXEC", errno: -8, syscall: `spawn ${file}`, path: file }));
      }
      return promisify(real.execFile)(file, args, opts);
    },
  });
  // The control client's start: the refused file fails to start for real (a path that does not exist), as a spawn of
  // a file that cannot be executed does.
  const spawn = (file: string, args: string[], opts: object) => {
    spawned.push(file);
    return real.spawn(file.endsWith("/refused/tmux") ? `${file}.missing` : file, args, opts);
  };
  return { ...real, execFile, spawn };
});
const { execArgvCommand, spawnTmuxClient } = await import("../src/adapters/tmux-exec.js");

/** What a started client prints, once it exits. */
async function printed(child: import("node:child_process").ChildProcessWithoutNullStreams): Promise<string> {
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { out += chunk; });
  await new Promise((resolve) => child.once("close", resolve));
  return out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tmux-spawn-error-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); spawned.length = 0; });

describe.skipIf(process.platform === "win32")("tmux exec after a spawn error", { timeout: 60_000 }, () => {
  it("an ENOEXEC from the resolved tmux runs the call once through the shell", async () => {
    const refused = path.join(root, "refused"), shell = path.join(root, "shell");
    fs.mkdirSync(refused);
    fs.mkdirSync(shell);
    fs.writeFileSync(path.join(refused, "tmux"), "echo refused\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shell, "tmux"), "#!/bin/sh\necho shell\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${refused}:${shell}:/usr/bin:/bin`);
    // The shell runs the file without #! as a script, as main's shell transport does.
    expect(await execArgvCommand(["tmux", "-V"])).toBe("refused\n");
    expect(spawned).toEqual([path.join(refused, "tmux"), "/bin/sh"]);
    // Each call tries the file once, then the shell once: never the same file twice in one call.
    expect(await execArgvCommand(["tmux", "-V"])).toBe("refused\n");
    expect(spawned).toEqual([path.join(refused, "tmux"), "/bin/sh", path.join(refused, "tmux"), "/bin/sh"]);
  });

  it("starts the control client as it starts a call: the resolved file, else the shell once after a spawn error", async () => {
    const direct = path.join(root, "direct"), shell = path.join(root, "shell-client");
    fs.mkdirSync(direct);
    fs.mkdirSync(shell);
    fs.writeFileSync(path.join(direct, "tmux"), "#!/bin/sh\necho direct \"$@\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shell, "tmux"), "#!/bin/sh\necho shell \"$@\"\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${direct}:/usr/bin:/bin`);
    expect(await printed(await spawnTmuxClient(["-C", "x"]))).toBe("direct -C x\n");
    expect(spawned).toEqual([path.join(direct, "tmux")]);
    // The resolved file does not start: the shell finds tmux on PATH, as it does for a call.
    spawned.length = 0;
    vi.stubEnv("PATH", `${path.join(root, "refused")}:${shell}:/usr/bin:/bin`);
    fs.mkdirSync(path.join(root, "refused"), { recursive: true });
    fs.writeFileSync(path.join(root, "refused", "tmux"), "#!/bin/sh\necho refused\n", { mode: 0o755 });
    expect(await printed(await spawnTmuxClient(["-C", "x"]))).toBe("refused\n");
    expect(spawned).toEqual([path.join(root, "refused", "tmux"), "/bin/sh"]);
    // A PATH whose first entry is relative is left to the shell, which finds tmux where the lookup would not.
    spawned.length = 0;
    vi.stubEnv("PATH", `relative-dir:${shell}:/usr/bin:/bin`);
    expect(await printed(await spawnTmuxClient(["-C", "x"]))).toBe("shell -C x\n");
    expect(spawned).toEqual(["/bin/sh"]);
  });
});
