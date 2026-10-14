import { spawn } from "node:child_process";
import { stopGroup } from "../domain/codex-network-default.js";
import type { ExecFn } from "./tmux.js";

/** How long a runtime's `--version` or `--help` probe may take before it is ended and recorded as an error.
 *  Generous on purpose: a longer bound only costs time when a binary really hangs, and loaded hosts are unmeasured. */
export const RUNTIME_PROBE_TIMEOUT_MS = 30_000;
const PROBE_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** After the probe exits, how long to wait for the rest of its output before answering. */
const DRAIN_MS = 200;

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
 * for the reap; the Codex readers' stopGroup) and the promise rejects with ProbeTimeoutError. Where a group
 * can't be signalled (Windows), the probe process itself is then killed; its own descendants may survive there.
 * Otherwise it answers when the probe exits: what it wrote (after a short drain) on exit 0, or a rejection like
 * execCommand's on any other exit. Only if that 200 ms drain times out (the output pipes are still held open, by
 * a descendant) is the group ended then, so that descendant can't turn a finished probe into a timeout; a healthy
 * probe whose pipes end within the drain never reaches stopGroup. A descendant that closed its stdio is left
 * running, as execCommand leaves it.
 */
export function boundedProbeExec(
  timeoutMs = RUNTIME_PROBE_TIMEOUT_MS,
  graceMs = PROBE_GRACE_MS,
  deps: { stopGroup?: typeof stopGroup } = {},
): ExecFn {
  const endGroup = deps.stopGroup ?? stopGroup;
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
    const exited = new Promise<void>((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      else child.once("exit", () => r());
    });
    // The group first; then, where group signals don't reach (Windows), the probe process itself, waiting (bounded)
    // for its exit. Then let the pipes end by themselves, bounded, so output still in them is read before they're
    // closed; nothing holds the caller past that.
    const end = async () => {
      await endGroup(child, graceMs);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise((r) => { t = setTimeout(r, graceMs); })]);
        clearTimeout(t);
      }
      const ends = [child.stdout, child.stderr].filter((stream) => stream && !stream.readableEnded)
        .map((stream) => new Promise<void>((r) => { stream!.once("end", () => r()); stream!.once("close", () => r()); }));
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(ends), new Promise((r) => { t = setTimeout(r, graceMs); })]);
      clearTimeout(t);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void end().then(() => reject(new ProbeTimeoutError(cmd, timeoutMs)));
    }, timeoutMs);
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    // Answer when the probe exits, after a short drain of what it wrote (a descendant may keep the pipes open, so
    // don't wait for `close`). Only pipes still held open after the drain mean a descendant holds the output: then,
    // and only then, end the group. A descendant that closed its stdio is left alone.
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const open = () => [child.stdout, child.stderr].filter((stream) => stream && !stream.readableEnded);
      const drained = new Promise<void>((r) => {
        let pending = 0;
        const done = () => { pending -= 1; if (pending <= 0) r(); };
        for (const stream of open()) { pending += 1; stream!.once("end", done); }
        if (pending === 0) r();
        setTimeout(r, DRAIN_MS);
      });
      // Yield once to I/O before deciding: if the event loop stalled past the drain timer, the pipes' end events
      // may be queued behind it, and a closed-stdio descendant must not be taken for one holding the output.
      void drained.then(() => new Promise((r) => setImmediate(r))).then(() => (open().length > 0 ? end() : undefined)).then(() => {
        if (code === 0) resolve(stdout);
        else {
          const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
          reject(new Error(`Command failed: ${cmd} (${signal ? `signal ${signal}` : `exit ${code}`})${output ? `\n${output}` : ""}`));
        }
      });
    });
  });
}
