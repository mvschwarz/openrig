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
    if (podName.includes("@")) {
      errors.push('pod name must not contain "@" — it separates the member from the rig');
    }
  }

  if (!memberName) {
    errors.push("member name must not be empty");
  } else {
    const err = validateSessionNameChars(memberName, "member name");
    if (err) errors.push(err);
    if (memberName.includes("@")) {
      errors.push('member name must not contain "@" — it separates the member from the rig');
    }
  }

  if (!rigName) {
    errors.push("rig name must not be empty");
  } else {
    const err = validateSessionNameChars(rigName, "rig name");
    if (err) errors.push(err);
  }

  return errors;
}
/**
 * A session name tmux would create under a different name. tmux replaces "." with "_" in a
 * session name, so `dev-impl@demo.v2` runs as `dev-impl@demo_v2` and every later lookup by the
 * recorded name misses it. Launch preflight refuses these; parsing and validation above still
 * accept "." (existing records, attach and restore are unchanged).
 * Returns null when tmux keeps the name, or an error naming the session tmux would create.
 */
export function tmuxRenamedSessionError(sessionName: string): string | null {
  if (!sessionName.includes(".")) return null;
  return `session name "${sessionName}" contains "." and tmux would create it as "${sessionName.replace(/\./g, "_")}", so OpenRig could not reach the seat; use a rig name without dots`;
}

// Single-letter format aliases tmux 3.6a replaces after "#" (format.c format_upper and format_lower).
const TMUX_FORMAT_ALIASES = "DFHIPSTWh";

/** What tmux 3.6a's format expansion does to a name new-session runs through it (cmd-new-session.c:104,
 *  format.c format_expand1), or null when every "#" is copied as written: "#" plus any other character is kept. */
function tmuxFormatChange(name: string): string | null {
  let styleEnd = -1;
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "#") continue;
    const next = name[i + 1];
    if (next === undefined) return 'tmux can\'t reliably handle a "#" at the end of a new session\'s name';
    let run = i + 1;
    while (name[run] === "#") run++;
    if (name[run] === "[") {
      // "#[" and "##…[" open a style, copied as written; an alias inside it isn't expanded.
      styleEnd = name.indexOf("]", run);
      i = run;
      continue;
    }
    if (next === "#") return 'tmux reads "##" as "#" in a new session\'s name';
    if (next === "(") return 'tmux runs "#(…)" as a command in a new session\'s name';
    if (next === "{") return 'tmux expands "#{…}" in a new session\'s name';
    if (next === "}" || next === ",") return `tmux reads "#${next}" as "${next}" in a new session's name`;
    if (TMUX_FORMAT_ALIASES.includes(next) && i + 1 > styleEnd) return `tmux replaces "#${next}" with a value in a new session's name`;
    i++;
  }
  return null;
}

/**
 * Why a seat can't be launched again under the name it is bound to, or null when it can. An adopted seat keeps its own
 * tmux session's name, which need not follow the canonical or legacy pattern validateSessionName checks. Such a name is
 * reused unless something on the restore, send or capture path changes it or can't find it:
 * - tmux 3.6a refuses an empty name, turns ":" and "." into "_", escapes control characters, "\" and invalid UTF-8
 *   (session.c session_check_name), and changes some "#" sequences in a new session's name (tmuxFormatChange).
 * - OpenRig addresses a session as "=name" (exactTarget, probeSession and listPanes in adapters/tmux.ts), and tmux strips
 *   the "=" and then reads a leading "$" as a session id (cmd-find.c). A name shaped like an id ("%3", "@1") is passed
 *   through as that id. A leading "%", "@" or "=" is otherwise found as written.
 * - A name with two or more "@" is read as already carrying a host (`rig send`'s origin, run-on-host originFor), and
 *   `rig send --to` splits on "," and trims each part.
 */
export function boundSessionNameProblem(sessionName: string): string | null {
  if (!sessionName) return "it is empty";
  if (sessionName !== sessionName.trim()) return "it starts or ends with whitespace, which `rig send --to` trims";
  if (sessionName.split("@").length >= 3) return 'it contains more than one "@", so OpenRig reads its last part as a host';
  if (sessionName.includes(",")) return 'it contains ",", which `rig send --to` reads as a list separator';
  const renamed = [":", "."].find((ch) => sessionName.includes(ch));
  if (renamed) return `tmux turns "${renamed}" into "_" in a session name`;
  // Control characters, and unpaired surrogates (which aren't valid UTF-8): iterating by code point leaves a lone
  // surrogate as its own value in 0xd800-0xdfff.
  const escaped = [...sessionName].some((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff);
  });
  if (sessionName.includes("\\") || escaped) {
    return 'tmux escapes "\\", control characters and invalid UTF-8 in a session name';
  }
  const format = tmuxFormatChange(sessionName);
  if (format) return format;
  if (sessionName.startsWith("$")) return 'tmux reads a name starting with "$" as a session id, even in an exact target';
  if (/^[%@]\d+$/.test(sessionName)) return `tmux reads "${sessionName}" as a ${sessionName[0] === "%" ? "pane" : "window"} id`;
  return null;
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
  // A2 4th leg — virtual-domain ref (<local>@external). `local` is verbatim up to
  // the domain "@" (the scheme leg, slack:U..., rides `local` LEXICALLY; the
  // registered-vs-scheme split is a GATEWAY parse, never the classifier's).
  | { kind: "external"; local: string; domain: string }
  | { kind: "malformed"; error: "malformed_session_name"; input: string };

const HUMAN_SEAT_SESSION_REF_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;
const LEGACY_FLAT_SESSION_PATTERN = /^r\d{2}-.+$/;
// A2 4th leg — CLOSED virtual-domain token set as a NAMED CONSTANT beside the
// pattern (arch: not inline alternation; lexical-only pure fn, no state/IO).
// Future domain words extend this array (e.g. @a2a) as explicit alternation.
// Admission (is this @external ref registered?) is NOT here — it is the A1/A4
// gateway's job; the classifier only recognizes the lexical shape.
export const VIRTUAL_DOMAIN_TOKENS = ["external"] as const;
const VIRTUAL_DOMAIN_SESSION_REF_PATTERN = new RegExp(
  `^[A-Za-z0-9._:-]+@(${VIRTUAL_DOMAIN_TOKENS.join("|")})$`
);

/** Arch tooth 1: human-CLASS classification runs BEFORE any parse at sites where
 *  the human/agent distinction matters (the queue-destination gate + attention
 *  union). A2 widened it: virtual-domain refs (<local>@external) are human-CLASS
 *  too (they join human-route enforcement; NEVER a silent agent-class downgrade).
 *  Admission stays at the A1/A4 gateway. */
export function isHumanSeatSessionRef(sessionRef: string): boolean {
  return HUMAN_SEAT_SESSION_REF_PATTERN.test(sessionRef) ||
    VIRTUAL_DOMAIN_SESSION_REF_PATTERN.test(sessionRef);
}

export function parseSessionName(raw: string): ParsedSessionName {
  // Precedence (arch): human -> EXTERNAL -> canonical -> legacy -> malformed. The
  // virtual-domain leg MUST precede canonical, else "mike@external" parses as
  // member=mike rig=external; A1's rig-name reservation keeps that unambiguous.
  if (VIRTUAL_DOMAIN_SESSION_REF_PATTERN.test(raw)) {
    const domainAt = raw.lastIndexOf("@");
    return { kind: "external", local: raw.slice(0, domainAt), domain: raw.slice(domainAt + 1) };
  }
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
