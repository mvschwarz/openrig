// OPR.0.4.8.2 — OpenRig YOLO mode (opt-in, DEFAULT OFF).
//
// A simple deterministic setting that rides the STABLE launch-flag surface only (per the founder's
// two-surface rule: launch flags may be deterministic code; config-file policy may NOT). When ON,
// every managed seat boots with its harness full-bypass LAUNCH FLAG:
//   - Claude: --dangerously-skip-permissions
//   - Codex:  --dangerously-bypass-approvals-and-sandbox
//   - Pi:     --approve
// When OFF (the default), seats boot with the usability floor, unchanged. The YOLO path writes ZERO
// config files — it only selects a launch flag. Opt-in via the OPENRIG_YOLO env setting.

export function yoloEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENRIG_YOLO;
  return v === "1" || v === "true";
}
