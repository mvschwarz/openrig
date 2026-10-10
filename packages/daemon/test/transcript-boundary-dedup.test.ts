import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";

const run = promisify(exec);
const runFile = promisify(execFile);

describe.skipIf(process.platform === "win32")("native transcript boundary replay", () => {
  it("does not accumulate a boundary line echoed in unchanged pane scrollback", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-replay-"));
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "socket-"));
    const socket = path.join(socketDir, "owned.sock");
    const outputPath = path.join(temp, "transcript.log");
    const sessionName = "boundary@fixture";
    const oldBoundary = "--- SESSION BOUNDARY: prior restore";
    const echoedBoundary = "--- SESSION BOUNDARY: latest restore";
    const env = { ...process.env, HOME: temp };
    delete env.TMUX; delete env.TMUX_TMPDIR;
    try {
      const command = `printf '%s\\n' ${shellQuote(echoedBoundary)} 'stable terminal output'; sleep 60`;
      await runFile("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", sessionName, command], { env });
      let captures = 0;
      const tmuxAdapter = new TmuxAdapter(async (command) => {
        const result = await run(`tmux -S ${shellQuote(socket)} ${command.slice(5)}`, { env });
        if (command.includes("capture-pane")) captures += 1;
        return result.stdout;
      });
      const readyDeadline = Date.now() + 2000;
      while (!(await tmuxAdapter.capturePaneContent(sessionName, 20))?.includes("stable terminal output") && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await tmuxAdapter.capturePaneContent(sessionName, 20)).toContain(echoedBoundary);
      fs.writeFileSync(outputPath, `${oldBoundary}\n${echoedBoundary}\n`);
      captures = 0;
      startTranscriptRotation(tmuxAdapter, sessionName, outputPath, { lines: 20, pollIntervalMs: 30 });
      const captureDeadline = Date.now() + 2000;
      while (captures < 4 && Date.now() < captureDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(captures).toBeGreaterThanOrEqual(4);
      stopTranscriptRotation(sessionName);
      const lines = fs.readFileSync(outputPath, "utf8").split("\n");
      expect(lines.filter((line) => line === oldBoundary)).toHaveLength(1);
      // One retained structural header and one unmodified terminal-scrollback line.
      expect(lines.filter((line) => line === echoedBoundary)).toHaveLength(2);
      expect(lines).toContain("stable terminal output");
    } finally {
      stopTranscriptRotation(sessionName);
      await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
