/**
 * Slice 51-02 (L2 test-system) — the scenario FORMAT + VALIDATOR.
 *
 * The verbatim-binding arch shape (ARCH-SHAPE-scenario-format-and-runner, sha256
 * fc30a736): a scenario is `{scenario, topology, env?, steps[]}`; each step is a
 * single-key object whose key is an action verb or the one assertion verb
 * `expect`. The validator is pure (operates on an already-parsed object) and
 * rejects LOUDLY with a DISTINCTLY NAMED error — never a silent no-op — so the
 * author sees exactly what is wrong.
 *
 * The three proof-item-1 rejections: unknown expect surface, unknown emit
 * behavior, and emit `usage_limit` in a stub topology (a KNOWN real-runtime-only
 * behavior — a stub cannot honestly feed the provider-usage lane, so it FAILS
 * loud rather than pretending). Plus structural fidelity and the wall-clock guard
 * (`within` is a relative poll bound, never an assertion input).
 */

/** Action verbs (arch shape). `daemon` is the A1 amendment; distinct from seat `restart`. */
export const ACTION_VERBS = [
  "up",
  "down",
  "send",
  "restart",
  "restore",
  "emit",
  "mutate",
  "policy",
  "seed_regression",
  "daemon",
] as const;

/** The shipped-observable surface set — the ONLY surfaces `expect` may name. */
export const EXPECT_SURFACES = [
  "ps",
  "queue",
  "stream",
  "scope",
  "proof",
  "pane",
  "transcript",
  "tui_socket",
  "policy_provenance",
] as const;

/** The stub's locked four-behavior emit repertoire (shared vocab with 51-01). */
export const EMIT_BEHAVIORS = ["compaction", "slow_output", "mid_turn_death", "restore"] as const;

/** Known-but-real-runtime-only emit behaviors: valid ONLY in a real topology. */
export const REAL_RUNTIME_ONLY_EMIT_BEHAVIORS = ["usage_limit"] as const;

/** The three `expect` match modes (exactly one per assertion). */
export const EXPECT_MATCH_MODES = ["match", "contains", "equals"] as const;

/** The daemon-lifecycle verb ops (A1). */
export const DAEMON_OPS = ["sigterm", "restart"] as const;

export type ActionVerb = (typeof ACTION_VERBS)[number];
export type ExpectSurface = (typeof EXPECT_SURFACES)[number];
export type EmitBehavior = (typeof EMIT_BEHAVIORS)[number];

export type ValidationErrorCode =
  | "SCENARIO_NOT_OBJECT"
  | "SCENARIO_NAME_MISSING"
  | "TOPOLOGY_MISSING"
  | "ENV_NOT_OBJECT"
  | "STEPS_MISSING"
  | "STEP_NOT_OBJECT"
  | "STEP_NOT_SINGLE_KEY"
  | "UNKNOWN_STEP_VERB"
  | "EXPECT_NOT_OBJECT"
  | "UNKNOWN_EXPECT_SURFACE"
  | "EXPECT_MATCH_MODE_MISSING"
  | "EXPECT_MATCH_MODE_AMBIGUOUS"
  | "WITHIN_NOT_A_DURATION"
  | "EMIT_NOT_OBJECT"
  | "UNKNOWN_EMIT_BEHAVIOR"
  | "USAGE_LIMIT_IN_STUB_TOPOLOGY"
  | "UNKNOWN_DAEMON_OP";

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  /** JSON-ish path to the offending node, e.g. `steps[2].expect.surface`. */
  path: string;
}

export interface ValidatedScenario {
  scenario: string;
  topology: string;
  env?: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
}

export type ValidationResult =
  | { ok: true; scenario: ValidatedScenario }
  | { ok: false; errors: ValidationError[] };

export interface ValidateScenarioOptions {
  /**
   * The topology's runtime kind. 51-02 v1 scenarios are stub topologies (the
   * whole test system stands up runtime:stub seats), so this defaults to "stub".
   * `usage_limit` emit is permitted ONLY when this is "real".
   */
  topologyKind?: "stub" | "real";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A relative poll duration: bare ms integer, or an integer with ms/s/m/h. */
const DURATION_RE = /^\d+(ms|s|m|h)?$/;

/**
 * Validate a parsed scenario object against the arch shape. Collects ALL errors
 * (loud, complete) rather than stopping at the first. Pure — no I/O.
 */
export function validateScenario(
  doc: unknown,
  opts: ValidateScenarioOptions = {},
): ValidationResult {
  const topologyKind = opts.topologyKind ?? "stub";
  const errors: ValidationError[] = [];
  const push = (code: ValidationErrorCode, message: string, path: string) =>
    errors.push({ code, message, path });

  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ code: "SCENARIO_NOT_OBJECT", message: "scenario must be a YAML mapping/object", path: "" }] };
  }

  if (typeof doc.scenario !== "string" || doc.scenario.length === 0) {
    push("SCENARIO_NAME_MISSING", "scenario: a non-empty name is required (it names the defect class pinned)", "scenario");
  }
  if (typeof doc.topology !== "string" || doc.topology.length === 0) {
    push("TOPOLOGY_MISSING", "topology: a non-empty rig-spec path is required", "topology");
  }
  if (doc.env !== undefined && !isPlainObject(doc.env)) {
    push("ENV_NOT_OBJECT", "env: must be a mapping of preconditions when present", "env");
  }

  if (!Array.isArray(doc.steps)) {
    push("STEPS_MISSING", "steps: a non-empty ordered list of step objects is required", "steps");
  } else {
    doc.steps.forEach((step, i) => validateStep(step, i, topologyKind, push));
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    scenario: {
      scenario: doc.scenario as string,
      topology: doc.topology as string,
      env: doc.env as Record<string, unknown> | undefined,
      steps: doc.steps as Array<Record<string, unknown>>,
    },
  };
}

function validateStep(
  step: unknown,
  i: number,
  topologyKind: "stub" | "real",
  push: (code: ValidationErrorCode, message: string, path: string) => void,
): void {
  const base = `steps[${i}]`;
  if (!isPlainObject(step)) {
    push("STEP_NOT_OBJECT", `${base}: each step must be a single-key mapping`, base);
    return;
  }
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    push(
      "STEP_NOT_SINGLE_KEY",
      `${base}: a step must have exactly one verb key, found [${keys.join(", ")}]`,
      base,
    );
    return;
  }
  const verb = keys[0]!;
  const value = step[verb];
  const isAction = (ACTION_VERBS as readonly string[]).includes(verb);
  if (verb !== "expect" && !isAction) {
    push(
      "UNKNOWN_STEP_VERB",
      `${base}: unknown step verb "${verb}" — allowed: ${[...ACTION_VERBS, "expect"].join(", ")}`,
      `${base}.${verb}`,
    );
    return;
  }

  if (verb === "expect") validateExpect(value, `${base}.expect`, push);
  else if (verb === "emit") validateEmit(value, `${base}.emit`, topologyKind, push);
  else if (verb === "daemon") validateDaemon(value, `${base}.daemon`, push);
  // Other action verbs (up/down/send/restart/restore/mutate/policy/seed_regression)
  // carry free-form payloads the runner interprets; no schema gate at v1.
}

function validateExpect(
  value: unknown,
  path: string,
  push: (code: ValidationErrorCode, message: string, p: string) => void,
): void {
  if (!isPlainObject(value)) {
    push("EXPECT_NOT_OBJECT", `${path}: must be a mapping {surface, within?, seat?, match|contains|equals}`, path);
    return;
  }
  const surface = value.surface;
  if (typeof surface !== "string" || !(EXPECT_SURFACES as readonly string[]).includes(surface)) {
    push(
      "UNKNOWN_EXPECT_SURFACE",
      `${path}.surface: unknown surface ${JSON.stringify(surface)} — the shipped-observable set is: ${EXPECT_SURFACES.join(", ")}`,
      `${path}.surface`,
    );
  }
  const modes = EXPECT_MATCH_MODES.filter((m) => value[m] !== undefined);
  if (modes.length === 0) {
    push("EXPECT_MATCH_MODE_MISSING", `${path}: exactly one of match | contains | equals is required`, path);
  } else if (modes.length > 1) {
    push("EXPECT_MATCH_MODE_AMBIGUOUS", `${path}: only one of match | contains | equals is allowed, found [${modes.join(", ")}]`, path);
  }
  if (value.within !== undefined) {
    if (typeof value.within !== "string" || !DURATION_RE.test(value.within)) {
      push(
        "WITHIN_NOT_A_DURATION",
        `${path}.within: must be a relative poll duration (e.g. "5s", "500ms") — a wall-clock/absolute value is never an assertion input`,
        `${path}.within`,
      );
    }
  }
}

function validateEmit(
  value: unknown,
  path: string,
  topologyKind: "stub" | "real",
  push: (code: ValidationErrorCode, message: string, p: string) => void,
): void {
  if (!isPlainObject(value)) {
    push("EMIT_NOT_OBJECT", `${path}: must be a mapping {seat, behavior, ...}`, path);
    return;
  }
  const behavior = value.behavior;
  if (typeof behavior === "string" && (EMIT_BEHAVIORS as readonly string[]).includes(behavior)) return;
  if (
    typeof behavior === "string" &&
    (REAL_RUNTIME_ONLY_EMIT_BEHAVIORS as readonly string[]).includes(behavior)
  ) {
    if (topologyKind === "stub") {
      push(
        "USAGE_LIMIT_IN_STUB_TOPOLOGY",
        `${path}.behavior: "${behavior}" is real-runtime-only (the provider-usage lane is provider-identity-gated; a stub cannot honestly feed it) — it FAILS in a stub topology, never a silent no-op`,
        `${path}.behavior`,
      );
    }
    return; // permitted in a real topology
  }
  push(
    "UNKNOWN_EMIT_BEHAVIOR",
    `${path}.behavior: unknown behavior ${JSON.stringify(behavior)} — the stub repertoire is: ${EMIT_BEHAVIORS.join(", ")}`,
    `${path}.behavior`,
  );
}

function validateDaemon(
  value: unknown,
  path: string,
  push: (code: ValidationErrorCode, message: string, p: string) => void,
): void {
  const op = isPlainObject(value) ? value.op : undefined;
  if (typeof op !== "string" || !(DAEMON_OPS as readonly string[]).includes(op)) {
    push(
      "UNKNOWN_DAEMON_OP",
      `${path}.op: unknown daemon op ${JSON.stringify(op)} — allowed: ${DAEMON_OPS.join(", ")} (the scenario-local daemon's lifecycle; distinct from the seat-level restart verb)`,
      `${path}.op`,
    );
  }
}
