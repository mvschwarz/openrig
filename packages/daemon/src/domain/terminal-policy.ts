import type Database from "better-sqlite3";
import { resolveCurrentSessionAddress } from "./session-registry.js";

export const TERMINAL_PRESETS = ["no-peer-interventions", "help-within-instructions", "full-control"] as const;
export type TerminalPreset = typeof TERMINAL_PRESETS[number];
export type TerminalScope = "self" | "openrig" | "peer";
export type TerminalAction = "compaction" | "model";
export type TerminalActor = { source: "openrig" } | { source: "caller"; session: string | null };
type Decision = "allow" | "deny";
export interface TerminalPolicyConfig {
  preset: TerminalPreset;
  helpers: string[];
  exceptions: Partial<Record<TerminalScope, Partial<Record<TerminalAction, Decision>>>>;
}
const CURRENT: TerminalPolicyConfig = { preset: "full-control", helpers: [], exceptions: {} };
const SCOPES: TerminalScope[] = ["self", "openrig", "peer"];
const ACTIONS: TerminalAction[] = ["compaction", "model"];

/** Deliberate choices, not a free-text instruction interpreter or native permission policy. */
export function parseTerminalPolicy(value: unknown): TerminalPolicyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supply a terminal policy object.");
  const v = value as Record<string, unknown>;
  if (!TERMINAL_PRESETS.includes(v.preset as TerminalPreset)) throw new Error(`preset must be ${TERMINAL_PRESETS.join(", ")}`);
  const helpers = v.helpers ?? [];
  if (!Array.isArray(helpers) || helpers.length > 100 || helpers.some(h => typeof h !== "string" || !h.trim() || h.length > 256))
    throw new Error("helpers must be a list of named seat addresses (at most 100).");
  const exceptions = v.exceptions ?? {};
  if (!exceptions || typeof exceptions !== "object" || Array.isArray(exceptions)) throw new Error("exceptions must be an object.");
  for (const [scope, actions] of Object.entries(exceptions)) {
    if (!SCOPES.includes(scope as TerminalScope) || !actions || typeof actions !== "object" || Array.isArray(actions))
      throw new Error("Exception scopes are self, openrig and peer.");
    for (const [action, decision] of Object.entries(actions)) {
      if (!ACTIONS.includes(action as TerminalAction) || typeof decision !== "string" || !["allow", "deny"].includes(decision))
        throw new Error("Exceptions select allow or deny for compaction or model (including effort).");
    }
  }
  return { preset: v.preset as TerminalPreset, helpers: [...new Set(helpers.map(h => h.trim()))],
    exceptions: JSON.parse(JSON.stringify(exceptions)) as TerminalPolicyConfig["exceptions"] };
}

export class TerminalPolicyRefusal extends Error {
  readonly code = "terminal_policy_refused";
  constructor(readonly actorClass: TerminalScope, readonly action: TerminalAction) {
    super(`This seat's terminal policy does not allow ${actorClass} ${action}${action === "model" ? " or effort changes" : ""}. Read rig seat status <seat>; change the explicit policy with rig seat set-terminal-policy if authorised. The existing rig send --dangerously-interact --reason path is unchanged; native prompt and interruption guards still apply.`);
  }
}

/** One node-owned choice survives occupant replacement. Missing old schemas retain the old behaviour. */
export class TerminalPolicyStore {
  constructor(private readonly db: Database.Database) {}

  available(): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seat_terminal_policies'").get();
  }

  read(nodeId: string) {
    const row = this.available() ? this.db.prepare("SELECT * FROM seat_terminal_policies WHERE node_id=?").get(nodeId) as
      { config_json: string; source: string; actor: string | null; instruction: string; changed_at: string } | undefined : undefined;
    return { config: row ? parseTerminalPolicy(JSON.parse(row.config_json)) : CURRENT,
      source: row?.source ?? "schema_unavailable", actor: row?.actor ?? null,
      instruction: row?.instruction ?? "Terminal policy unavailable; current behaviour retained.", changedAt: row?.changed_at ?? null };
  }

  write(nodeId: string, config: TerminalPolicyConfig, actor: string, instruction: string, rigDefault = false): void {
    if (!this.available()) throw new Error("Terminal policy schema unavailable; upgrade the daemon before selecting a policy.");
    const node = this.db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(nodeId) as { rig_id: string } | undefined;
    if (!node) throw new Error("Seat no longer exists.");
    const table = rigDefault ? "rig_terminal_policy_defaults" : "seat_terminal_policies";
    const key = rigDefault ? "rig_id" : "node_id";
    this.db.prepare(`INSERT INTO ${table}(${key},config_json,actor,instruction${rigDefault ? "" : ",source"})
      VALUES (?,?,?,?${rigDefault ? "" : ",'explicit'"}) ON CONFLICT(${key}) DO UPDATE SET
      config_json=excluded.config_json,actor=excluded.actor,instruction=excluded.instruction,changed_at=datetime('now')
      ${rigDefault ? "" : ",source='explicit'"}`)
      .run(rigDefault ? node.rig_id : nodeId, JSON.stringify(parseTerminalPolicy(config)), actor, instruction);
  }

  private sameSeat(a: string, b: string): boolean {
    if (a === b) return true;
    const left = resolveCurrentSessionAddress(this.db, a);
    return !!left && left.nodeId === resolveCurrentSessionAddress(this.db, b)?.nodeId;
  }

  classify(nodeId: string, actor: TerminalActor): TerminalScope | "unknown" {
    if (actor.source === "openrig") return "openrig";
    if (!actor.session) return "unknown";
    return resolveCurrentSessionAddress(this.db, actor.session)?.nodeId === nodeId ? "self" : "peer";
  }

  check(nodeId: string, action: TerminalAction, actor: TerminalActor) {
    const { config, source } = this.read(nodeId);
    if (source === "schema_unavailable") return { actorClass: "unknown" as const, actor: null, preset: config.preset };
    const actorClass = this.classify(nodeId, actor);
    // No authenticated identity is invented for a plain shell or old caller. This is cooperative policy.
    if (actorClass === "unknown") return { actorClass, actor: null, preset: config.preset };
    const exception = config.exceptions[actorClass]?.[action];
    const allowed = exception ? exception === "allow" : actorClass !== "peer" || config.preset === "full-control"
      || (config.preset === "help-within-instructions" && actor.source === "caller" && actor.session !== null
        && config.helpers.some(helper => this.sameSeat(helper, actor.session!)));
    if (!allowed) throw new TerminalPolicyRefusal(actorClass, action);
    return { actorClass, actor: actor.source === "caller" ? actor.session : "OpenRig", preset: config.preset };
  }

  account(nodeId: string, runtime: string | null) {
    const saved = this.read(nodeId);
    const rules = Object.fromEntries(SCOPES.map(scope => [scope, Object.fromEntries(ACTIONS.map(action => [action,
      saved.config.exceptions[scope]?.[action] ?? (scope !== "peer" || saved.config.preset === "full-control" ? "allow"
        : saved.config.preset === "no-peer-interventions" ? "deny" : "named helpers only")]))]));
    const label = Object.values(saved.config.exceptions).some(actions => Object.keys(actions ?? {}).length > 0) ? "Custom" : saved.config.preset;
    const rigDefault = this.available() ? this.db.prepare(`SELECT d.config_json,d.actor,d.instruction
      FROM nodes n JOIN rig_terminal_policy_defaults d ON d.rig_id=n.rig_id WHERE n.id=?`).get(nodeId) as
        { config_json: string; actor: string; instruction: string } | undefined : undefined;
    const { config: _config, ...metadata } = saved;
    return { state: saved.source === "schema_unavailable" ? "unknown" as const : "planned" as const,
      ...metadata, preset: saved.config.preset, label, helpers: saved.config.helpers, rules,
      rigDefault: { config: rigDefault ? parseTerminalPolicy(JSON.parse(rigDefault.config_json)) : CURRENT,
        actor: rigDefault?.actor ?? null, instruction: rigDefault?.instruction ?? "Current behaviour", appliesTo: "newly added seats only" },
      supported: { compaction: runtime === "claude-code" ? "managed" : "not applicable", model: "saved setting; native effect unverified" },
      enforced: ["managed compaction", "saved model and effort changes"],
      guidanceOnly: ["other terminal interventions", "standing instruction interpretation"],
      limits: "Cooperative caller attribution, not authentication. Unattributed callers retain current behaviour. No native permission, interruption-level or override change. OpenRig compaction authority and self behaviour remain allowed unless explicitly changed.",
    };
  }
}
