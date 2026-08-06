// OPR.0.5.1.1 — the PURE stub behavior-script model (A5 items 6-8).
//
// A per-seat script deterministically drives the pane-hosted stub-runner: pane
// output lines, named hook/behavior emissions, and (later) stepwise timing (PRD §4.2).
// This module is side-effect-free — parsing + validation + the built-in default only —
// so it unit-tests hermetically and both the runner (pane process) and the adapter
// (daemon) can import it without pulling daemon dependencies into the pane. The stub
// carries NO assertion logic; a script only says WHAT the seat does, never asserts.
//
// TWIN-PARITY: STUB_BEHAVIORS is the canonical, production-owned behavior repertoire.
// 51-02's scenario `emit` verb (scenario-schema.ts EMIT_BEHAVIORS) is a copy of the
// SAME shared contract; test/stub-script.test.ts guards the two against byte-drift.

/** The locked four-behavior repertoire (arch A4 terminal descope). Shared, byte-for-byte,
 *  with 51-02's EMIT_BEHAVIORS. usage_limit is deliberately absent — real-runtime-only. */
export const STUB_BEHAVIORS = ["compaction", "slow_output", "mid_turn_death", "restore"] as const;
export type StubBehavior = (typeof STUB_BEHAVIORS)[number];

/** Known-but-real-runtime-only behaviors: a stub cannot honestly feed the provider-usage
 *  lane, so the script model REFUSES them loudly (never accept-and-drop). Mirrors 51-02's
 *  REAL_RUNTIME_ONLY_EMIT_BEHAVIORS so a stub script and a stub scenario agree. */
export const REAL_RUNTIME_ONLY_BEHAVIORS = ["usage_limit"] as const;

/** A single deterministic script step. */
export type StubStep =
  | { kind: "say"; text: string }
  | { kind: "emit"; behavior: StubBehavior };

export interface StubScript {
  steps: StubStep[];
}

/** Loud, typed rejection — a malformed/dishonest script must fail, never silently no-op. */
export class StubScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubScriptError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStep(raw: unknown, path: string): StubStep {
  if (!isPlainObject(raw)) throw new StubScriptError(`${path}: step must be an object`);
  const kind = raw.kind;
  if (kind === "say") {
    const text = raw.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new StubScriptError(`${path}.text: a say step requires a non-empty string`);
    }
    return { kind: "say", text };
  }
  if (kind === "emit") {
    const behavior = raw.behavior;
    if (typeof behavior === "string" && (STUB_BEHAVIORS as readonly string[]).includes(behavior)) {
      return { kind: "emit", behavior: behavior as StubBehavior };
    }
    if (typeof behavior === "string" && (REAL_RUNTIME_ONLY_BEHAVIORS as readonly string[]).includes(behavior)) {
      throw new StubScriptError(
        `${path}.behavior: "${behavior}" is real-runtime-only (a stub cannot honestly feed the ` +
        `provider-usage lane) — it is refused in a stub script, never a silent no-op`,
      );
    }
    throw new StubScriptError(
      `${path}.behavior: unknown behavior ${JSON.stringify(behavior)} — the stub repertoire is: ${STUB_BEHAVIORS.join(", ")}`,
    );
  }
  throw new StubScriptError(`${path}.kind: unknown step kind ${JSON.stringify(kind)} — expected "say" or "emit"`);
}

/** Parse + validate a stub script from its JSON string. Throws StubScriptError on any
 *  malformation so a bad script fails loudly at load, not with a silent partial run. */
export function parseStubScript(raw: string): StubScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StubScriptError("stub script is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw new StubScriptError("stub script must be an object { steps: [...] }");
  const steps = parsed.steps;
  if (!Array.isArray(steps)) throw new StubScriptError("stub script requires a steps array");
  return { steps: steps.map((step, i) => parseStep(step, `steps[${i}]`)) };
}

/** The built-in default script for a standalone stub seat (no scenario-resolved script):
 *  prompt + echo + a scripted reply, so the seat produces observable pane output. */
export const DEFAULT_STUB_SCRIPT: StubScript = {
  steps: [
    { kind: "say", text: "[stub] ready — awaiting prompt" },
    { kind: "say", text: "[stub] scripted reply: acknowledged" },
  ],
};
