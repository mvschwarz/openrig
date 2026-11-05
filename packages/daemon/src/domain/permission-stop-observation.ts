/** Diagnostic vocabulary accepted at the ingress, independently of the producer's sanitizer. */
const DESCRIPTORS = new Set([
  "Tool: details withheld", "Bash: details withheld",
  "Tool: Read", "Tool: Write", "Tool: Edit", "Tool: MultiEdit", "Tool: NotebookEdit", "Tool: Glob",
  "Tool: Grep", "Tool: LS", "Tool: WebFetch", "Tool: WebSearch", "Tool: Skill", "Tool: Task", "Tool: TodoWrite",
  ...["git", "npm", "node", "python3", "ls", "pwd", "cat", "sed", "find", "echo", "printf"]
    .map(tool => `Bash: ${tool} [arguments hidden]`),
]);

export type PermissionStopStatus =
  | { state: "unavailable"; command: "unavailable"; origin: "unknown" }
  | { state: "request_observed" | "completed"; command: string; origin: "harness";
      source: "PermissionRequest"; observed_at: string; actor: "main" | "subagent";
      pending: "unknown" | false };

export function unavailablePermissionStop(): PermissionStopStatus {
  return { state: "unavailable", command: "unavailable", origin: "unknown" };
}

interface ActorObservation {
  observedAt: number;
  command: string | null;
  completedAt: number;
}

/** An expiring diagnostic on the activity store, never an authority for execution or attention.
 * No raw input, timers, disk records or inferred request IDs. Restart loses evidence honestly. */
export class PermissionStopObservations {
  private readonly seats = new Map<string, { generation: string; actors: Map<string | null, ActorObservation> }>();
  constructor(private readonly now: () => Date, private readonly lifetimeMs = 5 * 60_000) {}

  observe(input: { nodeId: string; generation: string; actor: unknown; at: unknown; command?: unknown; completed: boolean }): void {
    const at = typeof input.at === "string" ? Date.parse(input.at) : NaN;
    const now = this.now().getTime();
    // Actor omission/invalid data is not a claim about the main session. Wire null explicitly means main.
    if (!(input.actor === null || (typeof input.actor === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.actor)))
      || !Number.isFinite(at) || at > now || now - at >= this.lifetimeMs) return;
    if (!input.completed && (typeof input.command !== "string" || !DESCRIPTORS.has(input.command))) return;
    for (const [key, value] of this.seats) {
      for (const [actor, observation] of value.actors) {
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
    const observation = previous ?? { observedAt: -Infinity, command: null, completedAt: -Infinity };
    if (input.completed) observation.completedAt = Math.max(observation.completedAt, at);
    else {
      // Duplicate plugin/managed posts and late older requests cannot replace newer or settled evidence.
      if (at <= Math.max(observation.observedAt, observation.completedAt)) return;
      observation.observedAt = at;
      observation.command = input.command as string;
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
      actor: latest.actor === null ? "main" : "subagent", pending: completed ? false : "unknown" };
  }

  forget(nodeId: string): void { this.seats.delete(nodeId); }
}
