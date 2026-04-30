import type { CrossHostResult } from "./cross-host-executor.js";

/**
 * Shared CLI-side helpers for commands that gate on `--host`. Centralizes
 * the structured failure formatting + JSON envelope so `send.ts` and
 * `capture.ts` (and any future v1 cross-host command) format identically.
 */

export function emitCrossHostError(hostId: string, code: string, message: string, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, cross_host: { host: hostId }, failedStep: code, error: message }));
  } else {
    console.error(`cross-host (host=${hostId}): ${message}`);
  }
  process.exitCode = 1;
}

export function emitCrossHostFailure(
  hostId: string,
  target: string,
  result: CrossHostResult,
  json?: boolean,
): void {
  if (result.ok) return;
  const message = formatCrossHostFailure(hostId, target, result);
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      cross_host: { host: hostId, target },
      failedStep: result.failedStep,
      error: message,
      ...(result.failedStep === "permission-gate" && result.hint ? { hint: result.hint } : {}),
    }));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}

export function formatCrossHostFailure(
  hostId: string,
  target: string,
  result: Extract<CrossHostResult, { ok: false }>,
): string {
  switch (result.failedStep) {
    case "ssh-unreachable":
      return `ssh to host=${hostId} (target=${target}) failed: ${oneLine(result.sshStderr)}. Verify SSH access and host registry config.`;
    case "permission-gate":
      return `ssh to host=${hostId} (target=${target}) hit a permission/auth gate: ${oneLine(result.sshStderr)}. ${result.hint ?? ""}`.trim();
    case "remote-daemon-unreachable":
      return `remote rig command on host=${hostId} could not reach the remote daemon (exit=${result.remoteExitCode}): ${oneLine(result.stderr || result.stdout)}. Start the daemon on the remote with 'ssh ${target} rig daemon start'.`;
    case "remote-command-failed":
      return `remote rig command on host=${hostId} failed (exit=${result.remoteExitCode}): ${oneLine(result.stderr || result.stdout)}`;
  }
}

function oneLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).join(" | ").slice(0, 400);
}
