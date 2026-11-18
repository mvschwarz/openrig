// A seat pool declaration: the `pool:` block on a model member (#3395, Piece 1). The block says how many extra agents
// cloned from that member the pool may hold and when it moves work to them; the job that acts on it comes later. This
// module is the one reader of the block, for the schema, the codec, the node and the job.
//
// Whatever is wrong inside the block is an advisory, never a spec error: the whole block is then not used (a pool never
// runs on part of its settings) and the rest of the rig loads. `pool: {}` clears a stored block on re-apply, and an
// absent key leaves it unchanged, as `process_limits: {}` and `launch_wrapper: []` do.

/** A usable pool block, with every default filled in. */
export interface SeatPoolSpec {
  /** The most pool agents (required); 0 is valid and means no extra agents. */
  max: number;
  /** The fewest pool agents. */
  min: number;
  /** How long a row must wait before it can be moved to a pool agent, in seconds. */
  dispatchAfterSeconds: number;
  /** How long a pool agent must sit idle before it can be drained, in seconds. */
  idleGraceSeconds: number;
  /** The gap between two add or drain steps, in seconds. */
  cooldownSeconds: number;
  /** Only the model's rows that carry this tag are moved; null: every row to the model. */
  dispatchTag: string | null;
  /** An absolute working folder for each pool agent, with `{rig}` and `{slot}` filled in; null: the model's folder. */
  cwdTemplate: string | null;
  /** True empties the pool. */
  drain: boolean;
}

/** One thing wrong with a block: the field (null for the block as a whole) and why. */
export interface SeatPoolProblem {
  field: string | null;
  reason: string;
}

/** A block as it is stored on a node: a usable spec, or the block as authored when it can't be used. */
export type SeatPoolNodeBlock = { spec: SeatPoolSpec } | { raw: unknown };

/** What a node holds: a usable spec, or the stored block with why it can't be read. */
export type StoredSeatPool = { spec: SeatPoolSpec } | { raw: unknown; error: string };

export const SEAT_POOL_DEFAULTS = {
  min: 0,
  dispatchAfterSeconds: 60,
  idleGraceSeconds: 300,
  cooldownSeconds: 60,
} as const;

const KEYS = ["max", "min", "dispatch_after_s", "idle_grace_s", "cooldown_s", "dispatch_tag", "cwd_template", "drain"] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set(KEYS);

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads a `pool` block. `{}` is the explicit clear (`spec: null`). Anything wrong is listed, every field, so that one
 * re-apply can fix them all; the block is then not used at all.
 */
export function parsePoolBlock(raw: unknown): { ok: true; spec: SeatPoolSpec | null } | { ok: false; problems: SeatPoolProblem[] } {
  if (!isMapping(raw)) {
    return { ok: false, problems: [{ field: null, reason: "must be a mapping, e.g. { max: 3 } (use {} to clear a stored pool)" }] };
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) return { ok: true, spec: null };

  const problems: SeatPoolProblem[] = [];
  for (const key of keys) {
    if (!KNOWN_KEYS.has(key)) problems.push({ field: key, reason: `unknown field; known fields are ${KEYS.join(", ")}` });
  }

  const numbers: Record<string, number> = {};
  const numberField = (key: string, fallback?: number): void => {
    const value = raw[key];
    if (value === undefined) {
      if (fallback === undefined) problems.push({ field: key, reason: "required, a whole number of 0 or more" });
      else numbers[key] = fallback;
      return;
    }
    if (!wholeNumber(value)) problems.push({ field: key, reason: "must be a whole number of 0 or more" });
    else numbers[key] = value;
  };
  numberField("max");
  numberField("min", SEAT_POOL_DEFAULTS.min);
  numberField("dispatch_after_s", SEAT_POOL_DEFAULTS.dispatchAfterSeconds);
  numberField("idle_grace_s", SEAT_POOL_DEFAULTS.idleGraceSeconds);
  numberField("cooldown_s", SEAT_POOL_DEFAULTS.cooldownSeconds);
  if (numbers["max"] !== undefined && numbers["min"] !== undefined && numbers["max"] < numbers["min"]) {
    problems.push({ field: "max", reason: `must be at least min (${numbers["min"]})` });
  }

  const dispatchTag = raw["dispatch_tag"];
  if (dispatchTag !== undefined && (typeof dispatchTag !== "string" || !dispatchTag.trim())) {
    problems.push({ field: "dispatch_tag", reason: "must be a non-empty tag" });
  }

  const cwdTemplate = raw["cwd_template"];
  if (cwdTemplate !== undefined) {
    if (typeof cwdTemplate !== "string" || !cwdTemplate.startsWith("/")) {
      problems.push({ field: "cwd_template", reason: "must be an absolute path" });
    } else {
      // one pass, so removing a placeholder never builds another out of the text around it ("{r{slot}ig}")
      const rest = cwdTemplate.replace(/\{(?:rig|slot)\}/g, "");
      if (rest.includes("{") || rest.includes("}")) {
        problems.push({ field: "cwd_template", reason: "may use only the placeholders {rig} and {slot}" });
      }
    }
  }

  const drain = raw["drain"];
  if (drain !== undefined && typeof drain !== "boolean") problems.push({ field: "drain", reason: "must be true or false" });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    spec: {
      max: numbers["max"]!,
      min: numbers["min"]!,
      dispatchAfterSeconds: numbers["dispatch_after_s"]!,
      idleGraceSeconds: numbers["idle_grace_s"]!,
      cooldownSeconds: numbers["cooldown_s"]!,
      dispatchTag: (dispatchTag as string | undefined) ?? null,
      cwdTemplate: (cwdTemplate as string | undefined) ?? null,
      drain: (drain as boolean | undefined) ?? false,
    },
  };
}

/** The spec form of a usable block, every field written (the optional text fields only when set). */
export function serializePoolBlock(spec: SeatPoolSpec): Record<string, unknown> {
  return {
    max: spec.max,
    min: spec.min,
    dispatch_after_s: spec.dispatchAfterSeconds,
    idle_grace_s: spec.idleGraceSeconds,
    cooldown_s: spec.cooldownSeconds,
    ...(spec.dispatchTag !== null ? { dispatch_tag: spec.dispatchTag } : {}),
    ...(spec.cwdTemplate !== null ? { cwd_template: spec.cwdTemplate } : {}),
    drain: spec.drain,
  };
}

/** One advisory per problem: `<member> pool.<field>: <reason>; pool not used`. */
export function poolProblemAdvisories(member: string, problems: readonly SeatPoolProblem[]): string[] {
  return problems.map((problem) =>
    `${member} pool${problem.field === null ? "" : `.${problem.field}`}: ${problem.reason}; pool not used`);
}

/** The `nodes.pool` column: SQL NULL for no pool, else the block as JSON (the spec form, or the block as authored). */
export function storedPoolText(block: SeatPoolNodeBlock): string {
  if ("spec" in block) {
    const checked = parsePoolBlock(serializePoolBlock(block.spec));
    if (!checked.ok || checked.spec === null) throw new Error("pool: not a usable block (pass null to clear)");
    return JSON.stringify(serializePoolBlock(checked.spec));
  }
  const text = JSON.stringify(block.raw);
  if (typeof text !== "string") throw new Error("pool: the authored block can't be stored");
  return text;
}

/**
 * Reads `nodes.pool`. NULL is no pool. A block that can't be read comes back as stored, with why, and never throws:
 * it holds the pool rather than removing it.
 */
export function parseStoredPoolBlock(stored: unknown): StoredSeatPool | undefined {
  if (stored === undefined || stored === null) return undefined;
  if (typeof stored !== "string") return { raw: stored, error: "pool: the stored value is not JSON text" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { raw: stored, error: "pool: the stored value is not valid JSON" };
  }
  const read = parsePoolBlock(parsed);
  if (!read.ok) {
    return { raw: parsed, error: read.problems.map((p) => `pool${p.field === null ? "" : `.${p.field}`}: ${p.reason}`).join("; ") };
  }
  if (read.spec === null) return { raw: parsed, error: "pool: the stored block is empty" };
  return { spec: read.spec };
}

/** What a re-applied member writes to its node: a block, null to clear (`pool: {}`), or undefined to leave it. */
export function memberPoolBlock(member: { pool?: SeatPoolSpec | null; unusablePool?: { raw: unknown } }): SeatPoolNodeBlock | null | undefined {
  if (member.pool !== undefined) return member.pool === null ? null : { spec: member.pool };
  if (member.unusablePool !== undefined) return { raw: member.unusablePool.raw };
  return undefined;
}
