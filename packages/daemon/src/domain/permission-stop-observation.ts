/** Diagnostic vocabulary accepted at the ingress, independently of the producer's sanitizer. */
const DESCRIPTORS = new Set([
  "Tool: details withheld", "Bash: details withheld",
  "Tool: Read", "Tool: Write", "Tool: Edit", "Tool: MultiEdit", "Tool: NotebookEdit", "Tool: Glob",
  "Tool: Grep", "Tool: LS", "Tool: WebFetch", "Tool: WebSearch", "Tool: Skill", "Tool: Task", "Tool: TodoWrite",
  ...["git", "npm", "node", "python3", "ls", "pwd", "cat", "sed", "find", "echo", "printf"]
    .map(tool => `Bash: ${tool} [arguments hidden]`),
]);

export interface PermissionRuleSuggestion {
  type: "addRules" | "replaceRules" | "removeRules";
  rules: { toolName: string; ruleContent?: string }[];
  behavior: "allow" | "deny" | "ask";
  destination: "session" | "localSettings" | "projectSettings" | "userSettings";
}
export interface PermissionRuleEvidence {
  state: "missing" | "present" | "unavailable";
  entries: PermissionRuleSuggestion[];
  unsupported: boolean;
  size_cut: boolean;
}

// Independent ingress validation: never trust the producer's asserted supported/size labels.
function admittedRules(input: unknown): PermissionRuleEvidence {
  const unavailable = (): PermissionRuleEvidence => ({ state: "unavailable", entries: [], unsupported: true, size_cut: false });
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  try {
    if (!object(input) || !["missing", "present", "unavailable"].includes(input.state as string)
      || typeof input.unsupported !== "boolean" || typeof input.size_cut !== "boolean" || !Array.isArray(input.entries)
      || Object.keys(input).some(key => !["state", "entries", "unsupported", "size_cut"].includes(key))) return unavailable();
    const evidence: PermissionRuleEvidence = { state: input.state as PermissionRuleEvidence["state"], entries: [],
      unsupported: input.unsupported, size_cut: input.size_cut };
    if (evidence.state !== "present") return input.entries.length || input.unsupported || input.size_cut ? unavailable() : evidence;
    if (input.entries.length > 8) evidence.size_cut = true;
    for (const entry of input.entries.slice(0, 8)) {
      if (!object(entry) || !["addRules", "replaceRules", "removeRules"].includes(entry.type as string)
        || !["allow", "deny", "ask"].includes(entry.behavior as string)
        || !["session", "localSettings", "projectSettings", "userSettings"].includes(entry.destination as string)
        || !Array.isArray(entry.rules)
        || Object.keys(entry).some(key => !["type", "rules", "behavior", "destination"].includes(key))) {
        evidence.unsupported = true; continue;
      }
      if (entry.rules.length > 16) { evidence.size_cut = true; continue; }
      const rules: PermissionRuleSuggestion["rules"] = [];
      let rejected = false;
      for (const rule of entry.rules) {
        if (!object(rule) || typeof rule.toolName !== "string" || !rule.toolName.length
          || Object.keys(rule).some(key => !["toolName", "ruleContent"].includes(key))
          || (Object.hasOwn(rule, "ruleContent") && typeof rule.ruleContent !== "string")) {
          evidence.unsupported = true; rejected = true; break;
        }
        if (rule.toolName.length > 128 || (typeof rule.ruleContent === "string" && rule.ruleContent.length > 2048)) {
          evidence.size_cut = true; rejected = true; break;
        }
        rules.push({ toolName: rule.toolName,
          ...(Object.hasOwn(rule, "ruleContent") ? { ruleContent: rule.ruleContent as string } : {}) });
      }
      if (rejected) continue;
      const supported = { type: entry.type, rules, behavior: entry.behavior, destination: entry.destination } as PermissionRuleSuggestion;
      if (Buffer.byteLength(JSON.stringify({ ...evidence, entries: [...evidence.entries, supported] }), "utf8") > 16384) {
        evidence.size_cut = true; continue;
      }
      evidence.entries.push(supported);
    }
    return evidence;
  } catch { return unavailable(); }
}

export type PermissionStopStatus =
  | { state: "unavailable"; command: "unavailable"; origin: "unknown" }
  | { state: "request_observed" | "completed"; command: string; origin: "harness";
      source: "PermissionRequest"; observed_at: string; actor: "main" | "subagent";
      pending: "unknown" | false; suggested_rules?: PermissionRuleEvidence };

export function unavailablePermissionStop(): PermissionStopStatus {
  return { state: "unavailable", command: "unavailable", origin: "unknown" };
}

interface ActorObservation {
  observedAt: number;
  command: string | null;
  completedAt: number;
  suggestedRules?: PermissionRuleEvidence;
}

/** An expiring diagnostic on the activity store, never an authority for execution or attention.
 * No raw input, timers, disk records or inferred request IDs. Restart loses evidence honestly. */
export class PermissionStopObservations {
  private readonly seats = new Map<string, { generation: string; actors: Map<string | null, ActorObservation> }>();
  constructor(private readonly now: () => Date, private readonly lifetimeMs = 5 * 60_000) {}

  observe(input: { nodeId: string; generation: string; actor: unknown; at: unknown; command?: unknown;
    ruleSuggestions?: unknown; completed: boolean }): void {
    const at = typeof input.at === "string" ? Date.parse(input.at) : NaN;
    const now = this.now().getTime();
    // Actor omission/invalid data is not a claim about the main session. Wire null explicitly means main.
    if (!(input.actor === null || (typeof input.actor === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.actor)))
      || !Number.isFinite(at) || at > now || now - at >= this.lifetimeMs) return;
    if (!input.completed && (typeof input.command !== "string" || !DESCRIPTORS.has(input.command))) return;
    for (const [key, value] of this.seats) {
      for (const [actor, observation] of value.actors) {
        if (now - observation.observedAt >= this.lifetimeMs) observation.suggestedRules = undefined;
        if (now - Math.max(observation.observedAt, observation.completedAt) >= this.lifetimeMs) value.actors.delete(actor);
      }
      if (!value.actors.size) this.seats.delete(key);
    }
    let seat = this.seats.get(input.nodeId);
    if (seat?.generation !== input.generation) {
      this.seats.delete(input.nodeId);
      if (this.seats.size >= 256) return;
      seat = { generation: input.generation, actors: new Map() };
      this.seats.set(input.nodeId, seat);
    }
    const actor = input.actor as string | null;
    const previous = seat.actors.get(actor);
    if (!previous && seat.actors.size >= 16) return;
    const observation: ActorObservation = previous ?? { observedAt: -Infinity, command: null, completedAt: -Infinity };
    if (input.completed) observation.completedAt = Math.max(observation.completedAt, at);
    else {
      // Duplicate plugin/managed posts and late older requests cannot replace newer or settled evidence;
      // a newer request at the same timestamp as a completion remains ambiguous (pending: "unknown").
      if (at <= observation.observedAt || at < observation.completedAt) return;
      observation.observedAt = at;
      observation.command = input.command as string;
      observation.suggestedRules = Object.hasOwn(input, "ruleSuggestions") ? admittedRules(input.ruleSuggestions) : undefined;
    }
    seat.actors.set(actor, observation);
  }

  read(nodeId: string, generation: string): PermissionStopStatus {
    const seat = this.seats.get(nodeId);
    if (seat?.generation !== generation) { this.forget(nodeId); return unavailablePermissionStop(); }
    const now = this.now().getTime();
    let latest: { actor: string | null; value: ActorObservation } | undefined;
    let ambiguous = false;
    for (const [actor, value] of seat.actors) {
      if (now - value.observedAt >= this.lifetimeMs) value.suggestedRules = undefined;
      if (now - Math.max(value.observedAt, value.completedAt) >= this.lifetimeMs) seat.actors.delete(actor);
      if (value.command && now >= value.observedAt && now - value.observedAt < this.lifetimeMs
        && (!latest || value.observedAt >= latest.value.observedAt)) {
        if (latest && value.observedAt === latest.value.observedAt) ambiguous = true;
        else { latest = { actor, value }; ambiguous = false; }
      }
    }
    if (!latest || ambiguous) return unavailablePermissionStop();
    const completed = latest.value.completedAt > latest.value.observedAt;
    return { state: completed ? "completed" : "request_observed", command: latest.value.command!,
      origin: "harness", source: "PermissionRequest", observed_at: new Date(latest.value.observedAt).toISOString(),
      actor: latest.actor === null ? "main" : "subagent", pending: completed ? false : "unknown",
      ...(latest.value.suggestedRules ? { suggested_rules: structuredClone(latest.value.suggestedRules) } : {}) };
  }

  forget(nodeId: string): void { this.seats.delete(nodeId); }
}
