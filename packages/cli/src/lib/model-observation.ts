/** Wire observation from the serving host. Never infer it from a configured model. */
export interface ModelObservation {
  status: "observed" | "unknown";
  model: string | null;
  source: string | null;
  observedAt: string | null;
  generation: string | null;
  reason: string | null;
}

export function unknownModelObservation(reason: string): ModelObservation {
  return { status: "unknown", model: null, source: null, observedAt: null, generation: null, reason };
}

export function modelObservation(value: unknown, running = true): ModelObservation {
  if (!running) return unknownModelObservation("seat-not-running");
  if (!value || typeof value !== "object") return unknownModelObservation("observer-unavailable");
  const v = value as Record<string, unknown>;
  const generation = typeof v.generation === "string" ? v.generation : null;
  if (v.status === "observed" && typeof v.model === "string" && (v.source === "runner_reported"
      ? v.model.length > 0 && v.model.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(v.model)
      : /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]{0,199}$/.test(v.model))
    && ["claude-assistant-response", "codex-turn-context", "codex-world-state", "pi-assistant-response", "runner_reported"].includes(String(v.source))
    && typeof v.observedAt === "string" && Number.isFinite(Date.parse(v.observedAt)) && generation) {
    return { status: "observed", model: v.model, source: String(v.source), observedAt: v.observedAt, generation, reason: null };
  }
  const reason = v.status === "unknown" && typeof v.reason === "string" && /^[a-z-]{1,80}$/.test(v.reason)
    ? v.reason : "observation-unreadable";
  return { ...unknownModelObservation(reason), generation };
}

export function formatModelObservation(value: ModelObservation): string {
  // Escape only the human display, following seat's terminal JSON convention; wire identifiers stay exact.
  const model = value.model?.replace(/\p{Cf}/gu,
    character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")) ?? value.model;
  return value.status === "observed"
    ? value.source === "runner_reported"
      ? `${model} (runner-reported; sample ${value.observedAt})`
      : `${model} (${value.source}; native record ${value.observedAt})`
    : `UNKNOWN (${value.reason})`;
}
