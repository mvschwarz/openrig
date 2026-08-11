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
  "pane",
  "transcript",
  "tui_socket",
  "policy_provenance",
] as const;

/**
 * RESERVED surfaces — named by the arch shape but NOT currently backed by a
 * shipped read verb, so the format must not promise what the product cannot
 * answer. `proof` moved here by PM lock amendment (ruling row
 * qitem-20260811092250-a80735bc): `rig proof` ships only `add`; the surface
 * re-enters EXPECT_SURFACES by un-reserving when a read verb ships.
 */
export const RESERVED_SURFACES = ["proof"] as const;

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
  | "RESERVED_EXPECT_SURFACE"
  | "STUB_SCRIPTS_NOT_A_MAP"
  | "STUB_SCRIPT_PATH_INVALID"
  | "SCOPE_MISSION_MISSING"
  | "TUI_NOT_DECLARED"
  | "ENV_TUI_NOT_BOOLEAN"
  | "EXPECT_MATCH_MODE_MISSING"
  | "EXPECT_MATCH_MODE_AMBIGUOUS"
  | "WITHIN_NOT_A_DURATION"
  | "EQUALS_PROJECTION_INVALID"
  | "EQUALS_SURFACE_UNKNOWN"
  | "EQUALS_NOT_DECLARATIVE"
  | "EQUALS_TOO_FEW_SURFACES"
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

  if (isPlainObject(doc.env)) validateEnvBlock(doc.env, push);

  if (!Array.isArray(doc.steps)) {
    push("STEPS_MISSING", "steps: a non-empty ordered list of step objects is required", "steps");
  } else {
    doc.steps.forEach((step, i) => validateStep(step, i, topologyKind, push));
    validateEnvStepCrossRequirements(
      isPlainObject(doc.env) ? doc.env : undefined,
      doc.steps,
      push,
    );
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

/** Shape-check the delta env fields (D1 stub_scripts, D7 tui). Pure shape only —
 *  the stub_scripts KEY CONTRACT (each key resolves to exactly one runtime:stub
 *  member) needs the parsed topology and is enforced at the pipeline boundary. */
function validateEnvBlock(
  env: Record<string, unknown>,
  push: (code: ValidationErrorCode, message: string, path: string) => void,
): void {
  const scripts = env.stub_scripts;
  if (scripts !== undefined) {
    if (!isPlainObject(scripts)) {
      push(
        "STUB_SCRIPTS_NOT_A_MAP",
        "env.stub_scripts: must be a mapping of <seat member> → <script path relative to the scenario file>",
        "env.stub_scripts",
      );
    } else {
      for (const [seat, p] of Object.entries(scripts)) {
        if (typeof p !== "string" || p.length === 0) {
          push(
            "STUB_SCRIPT_PATH_INVALID",
            `env.stub_scripts.${seat}: a non-empty script path string is required`,
            `env.stub_scripts.${seat}`,
          );
        }
      }
    }
  }
  if (env.tui !== undefined && typeof env.tui !== "boolean") {
    push("ENV_TUI_NOT_BOOLEAN", "env.tui: must be a boolean (true opts the scenario into TUI provisioning)", "env.tui");
  }
}

/** Teaching cross-requirements between declared env and the surfaces steps read:
 *  a scope expect needs env.scope_mission (the shipped `rig scope audit` read has
 *  --mission as a requiredOption); a tui_socket expect needs env.tui:true (the
 *  control socket exists only inside a provisioned TUI — without the opt-in the
 *  read would race a socket that never listens). Load-time teaching beats a
 *  runtime surprise. */
function validateEnvStepCrossRequirements(
  env: Record<string, unknown> | undefined,
  steps: unknown[],
  push: (code: ValidationErrorCode, message: string, path: string) => void,
): void {
  const surfacesRead = new Set<string>();
  steps.forEach((step) => {
    if (!isPlainObject(step)) return;
    const ex = step.expect;
    if (isPlainObject(ex) && typeof ex.surface === "string") surfacesRead.add(ex.surface);
  });

  if (surfacesRead.has("scope")) {
    const mission = env?.scope_mission;
    if (typeof mission !== "string" || mission.length === 0) {
      push(
        "SCOPE_MISSION_MISSING",
        "env.scope_mission: required (non-empty string) when any step expects the scope surface — the shipped read is `rig scope audit --mission <name> --json` and --mission is a requiredOption",
        "env.scope_mission",
      );
    }
  }
  if (surfacesRead.has("tui_socket") && env?.tui !== true) {
    push(
      "TUI_NOT_DECLARED",
      "env.tui: true is required when any step expects the tui_socket surface — the control socket exists only inside the TUI the pipeline provisions on opt-in",
      "env.tui",
    );
  }
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
  if (typeof surface === "string" && (RESERVED_SURFACES as readonly string[]).includes(surface)) {
    push(
      "RESERVED_EXPECT_SURFACE",
      `${path}.surface: "${surface}" is reserved, not readable — no shipped read verb exists for it ` +
        `(\`rig proof\` ships only \`add\`), so the format must not promise what the product cannot answer. ` +
        `Reserved until a read verb ships (PM ruling qitem-20260811092250-a80735bc); it re-enters the ` +
        `readable set by un-reserving then.`,
      `${path}.surface`,
    );
  } else if (typeof surface !== "string" || !(EXPECT_SURFACES as readonly string[]).includes(surface)) {
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
  // 51-03: the declarative `equals` mapping (surface -> projection). Validated
  // here so an authoring error is a load-time teaching failure, not a scenario
  // that runs and compares nothing.
  if (value.equals !== undefined && !isPlainObject(value.equals)) {
    // Guard finding: the legacy list form still parsed, so a scenario could name
    // surfaces without declaring HOW they compare — which is what left the
    // comparison to an injected placeholder. A-N1 makes the declarative mapping
    // the only scenario-facing form; refuse anything else at load and teach it.
    push(
      "EQUALS_NOT_DECLARATIVE",
      `${path}.equals: must be the DECLARATIVE mapping of surface -> projection, e.g. ` +
        `{ ps: { pluck: name }, queue: { pluck: destinationSession, rig: true } }. ` +
        `A bare list of surfaces names what to compare without declaring HOW, so the comparison cannot be honest.`,
      `${path}.equals`,
    );
  }
  if (isPlainObject(value.equals)) {
    // A comparison needs at least TWO sides. One surface (or none) is vacuous by
    // construction — it passes whatever the data is.
    const declaredSurfaces = Object.keys(value.equals);
    if (declaredSurfaces.length < 2) {
      push(
        "EQUALS_TOO_FEW_SURFACES",
        `${path}.equals: needs at least TWO surfaces to compare, found ${declaredSurfaces.length}` +
          `${declaredSurfaces.length ? ` (${declaredSurfaces.join(", ")})` : ""} — a one-sided equality passes ` +
          `regardless of the data and proves nothing.`,
        `${path}.equals`,
      );
    }
    for (const [surf, spec] of Object.entries(value.equals)) {
      if (!(EXPECT_SURFACES as readonly string[]).includes(surf)) {
        push(
          "EQUALS_SURFACE_UNKNOWN",
          `${path}.equals.${surf}: not a readable surface — the shipped-observable set is: ${EXPECT_SURFACES.join(", ")}`,
          `${path}.equals.${surf}`,
        );
        continue;
      }
      if (!isPlainObject(spec)) {
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}: must be a projection mapping, e.g. { pluck: name }`, `${path}.equals.${surf}`);
        continue;
      }
      for (const key of Object.keys(spec)) {
        if (!["pluck", "rig", "path"].includes(key)) {
          push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.${key}: unknown projection key — allowed: pluck, rig, path`, `${path}.equals.${surf}.${key}`);
        }
      }
      if (spec.pluck !== undefined && typeof spec.pluck !== "string") {
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.pluck: must be a field name string`, `${path}.equals.${surf}.pluck`);
      }
      if (spec.path !== undefined && typeof spec.path !== "string") {
        // was accepted at load and then threw `path.split is not a function` at
        // runtime — a TypeError must never be the first signal.
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.path: must be a dot-path string`, `${path}.equals.${surf}.path`);
      }
      if (spec.rig !== undefined && typeof spec.rig !== "boolean") {
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.rig: must be a boolean`, `${path}.equals.${surf}.rig`);
      }
    }
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
