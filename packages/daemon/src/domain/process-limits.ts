/**
 * A seat's own process limits (rig spec member `process_limits`, #3253): opt-in, Linux/systemd hosts only, applied to
 * the seat's new launches. Two limits exist, each opt-in on its own: the task limit (`tasks_max`, systemd's TasksMax=
 * on the seat's own scope) and the memory limit (`memory_max`, systemd's MemoryMax= on that same scope); any other key
 * (a CPU limit) is refused by name, never accepted and ignored.
 *
 * Spec shape: `process_limits: { tasks_max: <integer>, memory_max: <size> }`, either key alone or both. A mapping
 * replaces the stored limits whole; `process_limits: {}` clears them on re-apply; an absent key changes nothing.
 */

/** The limits a seat launches with: at least one of the two (a value with neither is no limits, stored as NULL). */
export interface ProcessLimits {
  /** systemd TasksMax= for the seat's own scope: the most tasks (processes and threads) the seat may hold at once. */
  tasksMax?: number;
  /** systemd MemoryMax= for the seat's own scope, in bytes: the most memory the seat's processes may be charged. */
  memoryMax?: number;
}

/** What a spec member authored: `{}` (neither key) explicitly clears the stored limits. */
export interface SpecProcessLimits {
  tasksMax?: number;
  memoryMax?: number;
}

/** The accepted `tasks_max` range, each end from what enforces it: systemd's TasksMax= takes a positive count (0 is
 *  refused as an assignment), so the floor is 1, and no runtime-wide floor is imposed (how many tasks a harness needs
 *  is the operator's choice, and a fork past the limit fails with EAGAIN, visible as a limit hit); the top is the
 *  kernel's PID_MAX_LIMIT (2^22), the most tasks a Linux host can hold. */
export const PROCESS_LIMITS_TASKS_MAX_MIN = 1;
export const PROCESS_LIMITS_TASKS_MAX_MAX = 4_194_304;

/** `memory_max` is a whole number of MiB: the kernel keeps memory.max in pages and reads back the page multiple below,
 *  so only a value that is a multiple of every page size up to 1 MiB reads back exactly as asked (the probe and the
 *  status compare it as written, as they do pids.max). */
const MIB = 1_048_576;
/** The largest accepted `memory_max`: the largest MiB multiple up to Number.MAX_SAFE_INTEGER, past which the daemon
 *  (which keeps and compares bytes as a JS number) is no longer exact. There is no floor here: the limit's own probe,
 *  a throwaway /bin/sh run inside a scope with that MemoryMax=, decides the low end, and a value too small for it to
 *  start in is refused by name at launch (as for tasks_max, no runtime-wide floor is imposed). */
export const PROCESS_LIMITS_MEMORY_MAX_MAX = 2 ** 53 - 2 ** 20;
/** The size suffixes `memory_max` takes, base 1024 as systemd reads them. */
const SIZE_SUFFIXES: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

const KNOWN_KEYS = new Set(["tasks_max", "memory_max"]);

/** Validates a spec `process_limits` value. Throws with the field named for anything else, including a CPU key: that
 *  limit is not supported yet and must never be accepted silently. */
export function validateProcessLimits(value: unknown, label = "process_limits"): SpecProcessLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: must be a mapping, e.g. { tasks_max: 512 }`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`${label}.${key}: not supported; only tasks_max and memory_max are (CPU limits are not available yet)`);
    }
  }
  const limits: SpecProcessLimits = {};
  const raw = record["tasks_max"];
  if (raw !== undefined) {
    if (typeof raw !== "number" || !Number.isInteger(raw)
      || raw < PROCESS_LIMITS_TASKS_MAX_MIN || raw > PROCESS_LIMITS_TASKS_MAX_MAX) {
      throw new Error(
        `${label}.tasks_max: must be an integer from ${PROCESS_LIMITS_TASKS_MAX_MIN} to ${PROCESS_LIMITS_TASKS_MAX_MAX}`,
      );
    }
    limits.tasksMax = raw;
  }
  if (record["memory_max"] !== undefined) limits.memoryMax = parseMemoryMax(record["memory_max"], `${label}.memory_max`);
  return limits;
}

/** A `memory_max` value in bytes: an integer number of bytes, or `<n>K|M|G|T` (base 1024). Each other form is refused
 *  with what is wrong with it. */
function parseMemoryMax(raw: unknown, label: string): number {
  const form = "must be an integer number of bytes or a size like 512M or 4G (K, M, G or T, base 1024)";
  let bytes: number;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) throw new Error(`${label}: ${form}`);
    bytes = raw;
  } else if (typeof raw === "string") {
    if (raw.trim().endsWith("%")) throw new Error(`${label}: a percentage is not accepted; give a size, e.g. 4G`);
    if (/^\s*infinity\s*$/i.test(raw)) {
      throw new Error(`${label}: infinity is not a limit; omit memory_max, or use process_limits: {} for none`);
    }
    if (/^\d+$/.test(raw)) throw new Error(`${label}: a number of bytes is an integer, not a string (or give a K, M, G or T suffix)`);
    const size = /^([1-9][0-9]*)([KMGT])$/.exec(raw);
    if (!size) throw new Error(`${label}: ${form}`);
    bytes = Number(size[1]) * SIZE_SUFFIXES[size[2]!]!;
  } else {
    throw new Error(`${label}: ${form}`);
  }
  if (bytes > PROCESS_LIMITS_MEMORY_MAX_MAX) {
    throw new Error(`${label}: must be at most ${PROCESS_LIMITS_MEMORY_MAX_MAX} bytes`);
  }
  if (bytes % MIB !== 0) throw new Error(`${label}: must be a whole number of MiB (a multiple of ${MIB} bytes)`);
  return bytes;
}

/** The authored limits as a stored value: `{}` (cleared) is no limits. */
export function effectiveProcessLimits(spec: SpecProcessLimits | undefined): ProcessLimits | undefined {
  if (!spec || (spec.tasksMax === undefined && spec.memoryMax === undefined)) return undefined;
  return { ...(spec.tasksMax !== undefined ? { tasksMax: spec.tasksMax } : {}),
    ...(spec.memoryMax !== undefined ? { memoryMax: spec.memoryMax } : {}) };
}

/** The `nodes.process_limits` column: SQL NULL for none, else the present keys in a fixed order,
 *  `{"tasks_max":N,"memory_max":B}` (bytes). */
export function serializeProcessLimits(limits: ProcessLimits | null | undefined): string | null {
  return limits ? JSON.stringify(processLimitsToSpec(limits)) : null;
}

/** Reads `nodes.process_limits`. NULL is none; anything malformed throws (a limit the operator set is never silently
 *  dropped). The callers keep that error to the one seat: the rig read marks the node (`processLimitsError`), and that
 *  seat's launch and status say it, while the stored value stays as it is. */
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
  if (!limits) throw new Error(`${label}: stored value has no limit (tasks_max or memory_max)`);
  return limits;
}

/** The spec form of stored limits, for export: `memory_max` in bytes, so it reads back exactly. */
export function processLimitsToSpec(limits: SpecProcessLimits): Record<string, number> {
  return { ...(limits.tasksMax !== undefined ? { tasks_max: limits.tasksMax } : {}),
    ...(limits.memoryMax !== undefined ? { memory_max: limits.memoryMax } : {}) };
}
