import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * The native TUI seat's pty geometry, proven against the real runner.
 *
 * The defect this guards: the runner spawned OMP's pty launcher with a piped
 * stdin, so the child's terminal stayed at 0x0 with no SIGWINCH — OMP's TUI
 * could neither size itself nor reflow when the pane was resized.
 *
 * How the proof works: the runner runs inside a `script` pty of a known size
 * (30x100). The runner hands its own terminal to the child, so the fake `omp`
 * on PATH reports that size. With a piped stdin the child's terminal is 0x0
 * and the marker never reaches the pane at all — the same observable the
 * operator sees as a TUI that cannot size itself.
 *
 * This exercises the runner's real spawn, so it also catches a call site that
 * stops using the tested spawn-options helper.
 */

const RUNNER_ENTRY = resolve(import.meta.dirname, "../src/adapters/pi-runner.ts");
const ROWS = 30;
const COLS = 100;

/** The util-linux `script` launcher the native TUI seat needs anyway. */
function scriptLauncher(): string | null {
  for (const candidate of ["/usr/bin/script", "/bin/script"]) {
    if (existsSync(candidate)) return candidate;
  }
  const found = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  const path = found.stdout.trim();
  return path ? path : null;
}

/** A fake `omp` that reports the terminal it was given, then exits. */
function writeFakeOmp(dir: string): void {
  const path = join(dir, "omp");
  writeFileSync(path, [
    "#!/bin/sh",
    'size=$(stty size 2>/dev/null || echo "0 0")',
    'echo "CHILD_STTY=$size"',
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
}

describe("the native TUI seat's pty geometry", () => {
  const launcher = scriptLauncher();

  // Without util-linux `script` there is no pty launcher on this host, and the
  // native TUI seat cannot start at all — the runner reports that itself.
  it.skipIf(launcher === null)("gives the child the pane's terminal size", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-tui-pty-"));
    try {
      const binDir = join(root, "bin");
      const seatRoot = join(root, "state");
      const seatName = "pty-seat@rig";
      const cwd = join(root, "work");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFakeOmp(binDir);

      const result = spawnSync(
        launcher as string,
        [
          "-qfec",
          [
            `stty rows ${ROWS} cols ${COLS};`,
            `${process.execPath} --import tsx ${RUNNER_ENTRY}`,
            "--runtime omp --approval-mode yolo",
            `--session-name ${seatName}`,
            `--state-root ${seatRoot}`,
            `--cwd ${cwd}`,
            "--launch-id attempt-1",
            "--ui native",
          ].join(" "),
          "/dev/null",
        ],
        {
          env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );

      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\r/g, "");
      const marker = /CHILD_STTY=(\d+ \d+)/.exec(output);
      expect(marker, `the fake OMP never reported its terminal size; runner output:\n${output}`).toBeTruthy();
      expect(marker?.[1], `the child's terminal size was not ${ROWS}x${COLS}; runner output:\n${output}`).toBe(`${ROWS} ${COLS}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
