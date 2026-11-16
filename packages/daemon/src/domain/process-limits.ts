/**
 * A seat's own process limits (rig spec member `process_limits`, #3253): opt-in, Linux/systemd hosts only, applied to
 * the seat's new launches. Only the task limit exists today (`tasks_max`, systemd's TasksMax= on the seat's own scope);
 * any other key (a memory or CPU limit) is refused by name, never accepted and ignored.
 *
 * Spec shape: `process_limits: { tasks_max: <integer> }`. `process_limits: {}` clears a stored limit on re-apply; an
 * absent key changes nothing.
 */

/** The limits a seat launches with. */
export interface ProcessLimits {
  /** systemd TasksMax= for the seat's own scope: the most tasks (processes and threads) the seat may hold at once. */
  tasksMax: number;
}

/** What a spec member authored: `{}` (no tasksMax) explicitly clears the stored limits. */
export interface SpecProcessLimits {
  tasksMax?: number;
}

/** The accepted `tasks_max` range: below 64 a seat's own harness can't start its helpers; the top is the kernel's
 *  pid_max ceiling (2^22). */
export const PROCESS_LIMITS_TASKS_MAX_MIN = 64;
export const PROCESS_LIMITS_TASKS_MAX_MAX = 4_194_304;

const KNOWN_KEYS = new Set(["tasks_max"]);

/** Validates a spec `process_limits` value. Throws with the field named for anything else, including a memory or CPU
 *  key: those limits are not supported yet and must never be accepted silently. */
export function validateProcessLimits(value: unknown, label = "process_limits"): SpecProcessLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: must be a mapping, e.g. { tasks_max: 512 }`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`${label}.${key}: not supported; only tasks_max is (memory and CPU limits are not available yet)`);
    }
  }
  const raw = record["tasks_max"];
  if (raw === undefined) return {};
  if (typeof raw !== "number" || !Number.isInteger(raw)
    || raw < PROCESS_LIMITS_TASKS_MAX_MIN || raw > PROCESS_LIMITS_TASKS_MAX_MAX) {
    throw new Error(
      `${label}.tasks_max: must be an integer from ${PROCESS_LIMITS_TASKS_MAX_MIN} to ${PROCESS_LIMITS_TASKS_MAX_MAX}`,
    );
  }
  return { tasksMax: raw };
}

/** The authored limits as a stored value: `{}` (cleared) is no limits. */
export function effectiveProcessLimits(spec: SpecProcessLimits | undefined): ProcessLimits | undefined {
  return spec?.tasksMax === undefined ? undefined : { tasksMax: spec.tasksMax };
}

/** The `nodes.process_limits` column: SQL NULL for none, else `{"tasks_max":N}`. */
export function serializeProcessLimits(limits: ProcessLimits | null | undefined): string | null {
  return limits ? JSON.stringify({ tasks_max: limits.tasksMax }) : null;
}

/** Reads `nodes.process_limits`. NULL is none; anything malformed throws (fail closed: a limit the operator set is
 *  never silently dropped). */
export function parseStoredProcessLimits(raw: unknown, label = "process_limits"): ProcessLimits | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`${label}: stored value must be a JSON string or null`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: stored value is not valid JSON`);
  }
  const limits = effectiveProcessLimits(validateProcessLimits(parsed, label));
  if (!limits) throw new Error(`${label}: stored value has no tasks_max`);
  return limits;
}

/** The spec form of stored limits, for export. */
export function processLimitsToSpec(limits: SpecProcessLimits): Record<string, number> {
  return limits.tasksMax === undefined ? {} : { tasks_max: limits.tasksMax };
}
