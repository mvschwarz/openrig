// Session naming: canonical pod-aware format + legacy flat-node format.
// Canonical: {pod}.{member}@{rig} — human-authored, system-validated.
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
  return `${podName}.${memberName}@${rigName}`;
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
