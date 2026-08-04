// OPR.0.4.8.2 — OpenRig YOLO mode (opt-in, DEFAULT OFF).
//
// A simple deterministic setting that rides the STABLE launch-flag surface only (per the founder's
// two-surface rule: launch flags may be deterministic code; config-file policy may NOT). When ON,
// every managed seat boots at its harness's maximally-permissive LAUNCH FLAG:
//   - Claude: --dangerously-skip-permissions  (permission bypass)
//   - Codex:  -s danger-full-access           (maximally-permissive sandbox; OFF floor = the
//             explicit -s workspace-write flag, NOT a harness default)
//   - Pi:     --approve                       (full RESOURCE TRUST — Pi's
//             --approve/--no-approve govern RESOURCE TRUST, not a permission policy)
// When OFF (the default), seats boot with the usability floor, unchanged. The YOLO path writes ZERO
// config files — it only selects a launch flag. Opt-in via the OPENRIG_YOLO env setting. (The
// zero-permission-config-write property concerns Claude/Codex permission policy; Pi is resource trust.)

export function yoloEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENRIG_YOLO;
  return v === "1" || v === "true";
}

// ── The single launch-posture decision per harness — used on EVERY managed launch path (fresh,
// resume, fork) so the floor (OFF) and the maximally-permissive posture (ON) are uniform, never
// path-dependent. NOTE the ON posture differs by harness: Claude/Codex = permission bypass; Pi =
// full RESOURCE TRUST (--approve), which is not a permission policy. ──

/** Claude launch posture flag: floor `--permission-mode acceptEdits`, or the YOLO full bypass. */
export function claudePostureFlag(env: NodeJS.ProcessEnv = process.env): string {
  return yoloEnabled(env) ? "--dangerously-skip-permissions" : "--permission-mode acceptEdits";
}

/**
 * Codex launch posture segment (leading space included), applied on EVERY managed Codex path
 * (fresh / resume / native-fork). `profileArg` is the already-formatted ` -p <profile>` string or "".
 * - YOLO ON → ` -s danger-full-access` (maximally-permissive sandbox), overriding even a named profile.
 * - OFF + named profile → the profile (it governs its own sandbox).
 * - OFF + no profile → OpenRig's explicit workspace-only floor ` -s workspace-write`.
 * No forced approval flag on any path — the approval flow is left to Codex, unforced.
 */
export function codexPostureArg(profileArg: string, env: NodeJS.ProcessEnv = process.env): string {
  if (yoloEnabled(env)) return " -s danger-full-access";
  return profileArg ? profileArg : " -s workspace-write";
}

/** Pi RESOURCE TRUST (Pi's --approve/--no-approve govern resource trust, NOT a permission policy):
 *  YOLO forces `approve`; otherwise the configured posture (default `no-approve`). */
export function piTrust(
  configured: "approve" | "no-approve" | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "approve" | "no-approve" {
  return yoloEnabled(env) ? "approve" : configured ?? "no-approve";
}
