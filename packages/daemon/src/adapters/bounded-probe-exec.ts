import { spawn } from "node:child_process";
import { stopGroup } from "../domain/codex-network-default.js";
import type { ExecFn } from "./tmux.js";

/** How long a runtime's `--version` or `--help` probe may take before it is ended and recorded as an error.
 *  Generous on purpose: a longer bound only costs time when a binary really hangs, and loaded hosts are unmeasured. */
export const RUNTIME_PROBE_TIMEOUT_MS = 30_000;
const PROBE_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** A probe that didn't answer within its bound; its process group has been ended. */
export class ProbeTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`${command} did not answer within ${Math.round(timeoutMs / 1000)} s; the probe was ended`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * An ExecFn for runtime version and help probes, which must never hold up their caller (daemon startup awaits
 * one before it listens). Unlike execCommand: stdin is closed (a probe never needs input), the command runs in
 * its own process group, and after `timeoutMs` that whole group is ended (TERM, then KILL, then a bounded wait
 * for the reap; the Codex readers' stopGroup) and the promise rejects with ProbeTimeoutError. Otherwise it
 * resolves with stdout on exit 0 and rejects like execCommand on any other exit.
 */
export function boundedProbeExec(timeoutMs = RUNTIME_PROBE_TIMEOUT_MS, graceMs = PROBE_GRACE_MS): ExecFn {
  return (cmd: string) => new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopGroup(child, graceMs).then(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(new ProbeTimeoutError(cmd, timeoutMs));
      });
    }, timeoutMs);
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    // `close`, not `exit`: the output is complete. A descendant that keeps the pipes open holds this until the
    // bound, and is then ended with the group.
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        reject(new Error(`Command failed: ${cmd} (${signal ? `signal ${signal}` : `exit ${code}`})${output ? `\n${output}` : ""}`));
      }
    });
  });
}
