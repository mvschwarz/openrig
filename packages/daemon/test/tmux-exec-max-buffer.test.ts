import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand, execCommand } from "../src/adapters/tmux-exec.js";

// A batched capture chains 24 panes, past exec's 1 MiB stdout default (#161). A fake `tmux` on a private PATH prints
// 2 MiB: the tmux argv transport carries the larger bound, and the shell exec, which other callers share, keeps the
// default.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tmux-maxbuf-"));
const bytes = 2 * 1024 * 1024;
fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\nyes x | head -c ${bytes}\n`, { mode: 0o755 });
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("tmux exec output bound", { timeout: 60_000 }, () => {
  it("returns more than 1 MiB of tmux stdout on the argv transport", async () => {
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    expect((await execArgvCommand(["tmux", "capture-pane", "-p"])).length).toBe(bytes);
  });

  it("keeps exec's default bound on the shell exec", async () => {
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    await expect(execCommand("tmux capture-pane -p")).rejects.toThrow(/maxBuffer/);
  });
});
