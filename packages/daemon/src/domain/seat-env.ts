/**
 * Launch environment a rig declares for its seats: `env:` at rig level and at member level in
 * rig.yaml, plus one-off `rig up --env KEY=VALUE` overrides.
 *
 * These values are written into the seat's tmux launch command line and the process environment.
 * Local processes can read them (#306), so they are for non-secret settings only.
 */

export type SeatEnv = Record<string, string>;

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_PREFIX = "OPENRIG_";

/** Tmux session variable listing the declared keys, so the managed Claude `env -i` launch can
 *  forward exactly those variables from the pane shell. Reserved by the OPENRIG_ prefix. */
export const SEAT_ENV_KEYS_VAR = "OPENRIG_SEAT_ENV_KEYS";

export function validateSeatEnvName(name: string): string | null {
  if (!NAME.test(name)) return `"${name}" is not a valid name; names match ^[A-Z_][A-Z0-9_]*$`;
  if (name.startsWith(RESERVED_PREFIX)) return `"${name}" is reserved; ${RESERVED_PREFIX}* names belong to OpenRig`;
  return null;
}

/** Validate a raw `env:` block. `path` prefixes each message, e.g. `env` or `pods[0].members[1].env`. */
export function validateSeatEnv(raw: unknown, path: string): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [`${path}: must be a mapping of NAME: value`];
  }
  const errors: string[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const nameError = validateSeatEnvName(name);
    if (nameError) errors.push(`${path}.${name}: ${nameError}`);
    if (typeof value !== "string") {
      errors.push(`${path}.${name}: value must be a string (quote numbers and booleans, e.g. "1")`);
    } else if (value === "") {
      errors.push(`${path}.${name}: value must not be empty (the launch omits empty variables)`);
    } else if (value.includes("\0")) {
      errors.push(`${path}.${name}: value must not contain a NUL byte`);
    }
  }
  return errors;
}

/** Normalize an already-validated `env:` block; an absent or empty block stays undefined. */
export function normalizeSeatEnv(raw: unknown): SeatEnv | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The one-off env a request body carries, or undefined when it carries none this launch can
 *  use. `/api/up` and `/api/bundles/install` answered requests with an `envOverride` field as if
 *  the field weren't there before it meant something; a malformed one keeps getting that answer
 *  rather than a new refusal. The CLI checks `--env` itself before sending. */
export function readSeatEnvOverride(raw: unknown): SeatEnv | undefined {
  if (raw === undefined || validateSeatEnv(raw, "envOverride").length > 0) return undefined;
  return normalizeSeatEnv(raw);
}

/** Parse the `KEY=VALUE` form `rig up --env` takes. The value may contain `=`. */
export function parseSeatEnvAssignment(text: string): { ok: true; name: string; value: string } | { ok: false; error: string } {
  const eq = text.indexOf("=");
  if (eq <= 0) return { ok: false, error: `"${text}" is not KEY=VALUE` };
  const name = text.slice(0, eq);
  const value = text.slice(eq + 1);
  const nameError = validateSeatEnvName(name);
  if (nameError) return { ok: false, error: nameError };
  if (value === "") return { ok: false, error: `${name}: value must not be empty (the launch omits empty variables)` };
  if (value.includes("\0")) return { ok: false, error: `${name}: value must not contain a NUL byte` };
  return { ok: true, name, value };
}

/** Effective env for one seat: rig, then member, then a one-off override. Later wins. */
export function mergeSeatEnv(...layers: Array<SeatEnv | null | undefined>): SeatEnv {
  return Object.assign({}, ...layers.filter(Boolean));
}

export function parseStoredSeatEnv(json: string | null | undefined): SeatEnv | null {
  if (!json) return null;
  try {
    return normalizeSeatEnv(JSON.parse(json)) ?? null;
  } catch {
    return null;
  }
}

/** The variables a launch hands the seat: the env itself plus the key list the managed Claude
 *  launch reads back. Empty when the seat declares nothing, so existing seats are unchanged. */
export function seatEnvLaunchVars(env: SeatEnv): SeatEnv {
  const keys = Object.keys(env);
  return keys.length > 0 ? { ...env, [SEAT_ENV_KEYS_VAR]: keys.join(",") } : {};
}
