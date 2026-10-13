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
  return { ...real, execFile };
});
const { execArgvCommand } = await import("../src/adapters/tmux-exec.js");

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
});
