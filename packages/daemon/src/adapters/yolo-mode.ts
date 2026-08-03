// OPR.0.4.8.2 — OpenRig YOLO mode (opt-in, DEFAULT OFF).
//
// A simple deterministic setting that rides the STABLE launch-flag surface only (per the founder's
// two-surface rule: launch flags may be deterministic code; config-file policy may NOT). When ON,
// every managed seat boots at its harness's maximally-permissive LAUNCH FLAG:
//   - Claude: --dangerously-skip-permissions            (permission bypass)
//   - Codex:  --dangerously-bypass-approvals-and-sandbox (permission + sandbox bypass)
//   - Pi:     --approve                                  (full RESOURCE TRUST — Pi's
//             --approve/--no-approve govern RESOURCE TRUST, not a permission policy)
// When OFF (the default), seats boot with the usability floor, unchanged. The YOLO path writes ZERO
// config files — it only selects a launch flag. Opt-in via the OPENRIG_YOLO env setting. (The
// zero-permission-config-write property concerns Claude/Codex permission policy; Pi is resource trust.)

export function yoloEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENRIG_YOLO;
  return v === "1" || v === "true";
}

// ── The single launch-posture decision per harness — used on EVERY managed launch path (fresh,
// resume, fork) so the floor (OFF) and the full-bypass (ON) are uniform, never path-dependent. ──

/** Claude launch posture flag: floor `--permission-mode acceptEdits`, or the YOLO full bypass. */
export function claudePostureFlag(env: NodeJS.ProcessEnv = process.env): string {
  return yoloEnabled(env) ? "--dangerously-skip-permissions" : "--permission-mode acceptEdits";
}

/**
 * Codex launch posture segment (leading space included). YOLO forces the full-bypass flag on EVERY
 * seat, overriding even a named `-p` profile; otherwise pass the caller's profile arg (or "" for the
 * harness-default floor). `profileArg` is the already-formatted ` -p <profile>` string or "".
 */
export function codexPostureArg(profileArg: string, env: NodeJS.ProcessEnv = process.env): string {
  return yoloEnabled(env) ? " --dangerously-bypass-approvals-and-sandbox" : profileArg;
}

/** Pi RESOURCE TRUST (Pi's --approve/--no-approve govern resource trust, NOT a permission policy):
 *  YOLO forces `approve`; otherwise the configured posture (default `no-approve`). */
export function piTrust(
  configured: "approve" | "no-approve" | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "approve" | "no-approve" {
  return yoloEnabled(env) ? "approve" : configured ?? "no-approve";
}
