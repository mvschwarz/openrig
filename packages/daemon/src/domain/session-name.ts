// Session naming: canonical pod-aware format + legacy flat-node format.
// Canonical: {pod}-{member}@{rig} — human-authored, system-validated.
// Legacy: r{NN}-{suffix} — for flat rigs without pods.

const LEGACY_SESSION_NAME_PATTERN = /^r\d{2}-.+$/;
const MANAGED_STEM_PATTERN = /^r\d{2}(?:-|$)/;
const ALLOWED_CHARS_PATTERN = /^[a-zA-Z0-9\-_.@]+$/;

/**
 * Derive a canonical session name from pod, member, and rig name.
 * Pure concatenation — no normalization, no heuristics.
 */
export function deriveCanonicalSessionName(
  podName: string,
  memberName: string,
  rigName: string
): string {
  return `${podName}-${memberName}@${rigName}`;
}

/**
 * Legacy session-name derivation for flat rigs without pods.
 * Dots in logicalId are normalized to underscores (tmux compat).
 */
export function deriveSessionName(
  rigName: string,
  logicalId: string
): string {
  const stem = MANAGED_STEM_PATTERN.test(rigName) ? rigName : `r00-${rigName}`;
  // tmux replaces dots with underscores in session names — normalize to match
  const safeId = logicalId.replace(/\./g, "_");
  return `${stem}-${safeId}`;
}

/**
 * Validate a session name. Accepts both:
 * - Legacy: r{NN}-{suffix}
 * - Canonical: {something}@{something} with all chars in allowed set
 * Both branches enforce the allowed character set.
 */
export function validateSessionName(name: string): boolean {
  if (!name || !ALLOWED_CHARS_PATTERN.test(name)) return false;
  // Canonical: contains @
  if (name.includes("@")) return true;
  // Legacy: r{NN}-{suffix}
  return LEGACY_SESSION_NAME_PATTERN.test(name);
}

/**
 * Validate characters in a session name component.
 * Returns null if valid, or an error string with the specific invalid character.
 */
export function validateSessionNameChars(
  value: string,
  label: string
): string | null {
  if (!value) return `${label} must not be empty`;
  for (const ch of value) {
    if (!ALLOWED_CHARS_PATTERN.test(ch)) {
      return `${label} "${value}" contains "${ch}" — tmux session names allow: a-z, A-Z, 0-9, -, _, ., @`;
    }
  }
  return null;
}

/**
 * Validate all three components of a canonical session name.
 * Returns an array of errors (empty if valid).
 */
export function validateSessionComponents(
  podName: string,
  memberName: string,
  rigName: string
): string[] {
  const errors: string[] = [];

  if (!podName) {
    errors.push("pod name must not be empty");
  } else {
    const err = validateSessionNameChars(podName, "pod name");
    if (err) errors.push(err);
  }

  if (!memberName) {
    errors.push("member name must not be empty");
  } else {
    const err = validateSessionNameChars(memberName, "member name");
    if (err) errors.push(err);
  }

  if (!rigName) {
    errors.push("rig name must not be empty");
  } else {
    const err = validateSessionNameChars(rigName, "rig name");
    if (err) errors.push(err);
  }

  return errors;
}
// ============================================================================
// OPR.0.4.6.MH1 FR-8 — THE session-name parse contract (parity-pinned).
//
// CANONICAL HOME: packages/daemon/src/domain/session-name.ts. The CLI and UI
// carry identical copies of this block (packages/cli/src/session-name.ts,
// packages/ui/src/lib/session-name.ts) because workspaces do not
// cross-import; the shared-vector parity test
// (packages/daemon/test/session-name-parity.test.ts) runs ONE vector set
// across all three copies — a divergence there means a copy drifted (the
// hosts-registry twin discipline; arch B2 ruling). Edit the daemon copy
// first, then mirror verbatim.
//
// SEMANTICS (pinned to the queue-destination gate, the archetype site):
// - member = everything before the FIRST "@" (non-empty); rig = everything
//   after it (non-empty, MAY contain further "@"s). The greedy rig is
//   load-bearing: "member@rig@x" parses as rig "rig@x", so the registry
//   lookup misses and the queue gate rejects with the SAME
//   unknown_destination_rig error as before this contract existed — host
//   NEVER rides in-band in the session string (BR-1).
// - Human-seat refs (human@kernel / human-<x>@host) are CLASSIFIED BEFORE
//   any parse wherever the distinction matters: call isHumanSeatSessionRef
//   first, as the queue gate does.
// - Legacy flat-rig names (r{NN}-suffix) remain valid NON-canonical names;
//   they carry no rig binding.
// - Exactly ONE structured malformed shape ("malformed_session_name") —
//   no site invents its own.
// - parseSessionName does NOT trim and does NOT validate the character set
//   (validateSessionName owns chars); callers that trimmed before this
//   contract keep trimming — the migration is behavior-identical for every
//   accepted string.
// ============================================================================

export type ParsedSessionName =
  | { kind: "canonical"; member: string; rig: string }
  | { kind: "legacy"; name: string }
  | { kind: "malformed"; error: "malformed_session_name"; input: string };

const HUMAN_SEAT_SESSION_REF_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;
const LEGACY_FLAT_SESSION_PATTERN = /^r\d{2}-.+$/;

/** Arch tooth 1: human-seat classification runs BEFORE any parse at sites
 *  where the human/agent distinction matters (the queue-destination gate). */
export function isHumanSeatSessionRef(sessionRef: string): boolean {
  return HUMAN_SEAT_SESSION_REF_PATTERN.test(sessionRef);
}

export function parseSessionName(raw: string): ParsedSessionName {
  const at = raw.indexOf("@");
  if (at > 0 && at < raw.length - 1) {
    return { kind: "canonical", member: raw.slice(0, at), rig: raw.slice(at + 1) };
  }
  if (at === -1 && LEGACY_FLAT_SESSION_PATTERN.test(raw)) {
    return { kind: "legacy", name: raw };
  }
  return { kind: "malformed", error: "malformed_session_name", input: raw };
}

/** Display: the member/local leg — text before the first "@", or the whole
 *  string when no "@" is present (the shipped split("@")[0] rendering,
 *  verbatim: "@rig" yields ""). */
export function sessionMemberLabel(session: string): string {
  const at = session.indexOf("@");
  return at === -1 ? session : session.slice(0, at);
}

/** Routing/grouping: the rig leg of a canonical name, else undefined. */
export function sessionRigOf(session: string): string | undefined {
  const parsed = parseSessionName(session);
  return parsed.kind === "canonical" ? parsed.rig : undefined;
}
