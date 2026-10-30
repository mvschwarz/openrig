import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createPrivateTextFile } from "./private-text-file.js";
import { replaceWindowsFilePreservingMetadata } from "./windows-owned-text.js";
import { join } from "node:path";

export const HEALTH_DETECTORS = ["process.ceremony-amplification", "process.review-carousel", "process.redundant-wake-storm", "governance.stale-directive", "governance.scope-admission-drift", "context.pressure"] as const;
export interface HealthPolicy {
  schema: "openrig.health-policy/v0alpha1";
  disabledDetectors: string[];
  thresholds: { ceremonyTransitions: number; ceremonyRatio: number; reviewReturns: number; redundantWakes: number };
  observationWindowSeconds: number;
  freshnessSeconds: number;
  diagnosis: { enabled: boolean; owner: string | null; detectors: string[]; cooldownSeconds: number; maxRepresentations: number };
  human: { address: string | null; conditions: Array<"critical" | "established pathology" | "confirmed ceremony"> };
}
export interface EffectiveHealthPolicy {
  version: string;
  policy: HealthPolicy;
  contextPressure: { warningPercent: number; criticalPercent: number };
}
export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  schema: "openrig.health-policy/v0alpha1", disabledDetectors: [],
  thresholds: { ceremonyTransitions: 20, ceremonyRatio: 12, reviewReturns: 4, redundantWakes: 4 },
  observationWindowSeconds: 86400, freshnessSeconds: 600,
  diagnosis: { enabled: false, owner: null, detectors: ["process.ceremony-amplification"], cooldownSeconds: 3600, maxRepresentations: 1 },
  human: { address: null, conditions: [] },
};
export function healthHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((k) => !keys.includes(k)) || keys.some((k) => !(k in result))) throw new Error(`Expected exactly: ${keys.join(", ")}`);
  return result;
}
function number(value: unknown, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer ${min}..${max}`);
}
export function validateHealthPolicy(value: unknown): HealthPolicy {
  const p = object(value, ["schema", "disabledDetectors", "thresholds", "observationWindowSeconds", "freshnessSeconds", "diagnosis", "human"]);
  if (p.schema !== DEFAULT_HEALTH_POLICY.schema) throw new Error("Unsupported health policy schema");
  for (const list of [p.disabledDetectors, (p.diagnosis as HealthPolicy["diagnosis"])?.detectors]) {
    if (!Array.isArray(list) || list.some((x) => !HEALTH_DETECTORS.includes(x)) || new Set(list).size !== list.length) throw new Error("Unknown or duplicate detector");
  }
  const t = object(p.thresholds, ["ceremonyTransitions", "ceremonyRatio", "reviewReturns", "redundantWakes"]);
  Object.values(t).forEach((v) => number(v, 1, 100000));
  number(p.observationWindowSeconds, 60, 604800); number(p.freshnessSeconds, 1, 86400);
  const d = object(p.diagnosis, ["enabled", "owner", "detectors", "cooldownSeconds", "maxRepresentations"]);
  if (typeof d.enabled !== "boolean" || (d.owner !== null && (typeof d.owner !== "string" || !/^[^\s@]+@[^\s@]+$/.test(d.owner) || d.owner.endsWith("@external")))) throw new Error("Diagnosis owner must be an agent seat address");
  if (d.enabled && !d.owner) throw new Error("Enabled diagnosis requires an owner");
  number(d.cooldownSeconds, 60, 604800); number(d.maxRepresentations, 0, 10);
  const h = object(p.human, ["address", "conditions"]);
  if (h.address !== null && (typeof h.address !== "string" || !/^[a-z0-9._-]+@external$/.test(h.address))) throw new Error("Human address must be registered @external");
  if (!Array.isArray(h.conditions) || h.conditions.some((c) => c !== "critical" && c !== "established pathology" && c !== "confirmed ceremony")) throw new Error("Unknown human escalation condition");
  if (h.conditions.length && !h.address) throw new Error("Human escalation requires a registered address");
  return structuredClone(value as HealthPolicy);
}
export class HealthPolicyStore {
  readonly path: string;
  constructor(private readonly home: string, private readonly contextPressure: () => EffectiveHealthPolicy["contextPressure"]) {
    this.path = join(home, "health", "policy.json");
  }
  read(): EffectiveHealthPolicy {
    const policy = existsSync(this.path) ? validateHealthPolicy(JSON.parse(readFileSync(this.path, "utf8"))) : structuredClone(DEFAULT_HEALTH_POLICY);
    const contextPressure = this.contextPressure();
    return { policy, contextPressure, version: healthHash({ policy, contextPressure }) };
  }
  apply(value: unknown, actor: string): EffectiveHealthPolicy {
    if (!actor.trim()) throw new Error("Policy change needs an actor");
    const policy = validateHealthPolicy(value);
    const previous = this.read();
    if (healthHash(policy) === healthHash(previous.policy)) return previous;
    const dir = join(this.home, "health");
    mkdirSync(join(dir, "policy-history"), { recursive: true });
    const id = randomUUID();
    // Retain the proposed bytes and predecessor before atomically replacing the live policy.
    writeFileSync(join(dir, "policy-history", `${id}.json`), JSON.stringify({ actor, at: new Date().toISOString(), previous, policy }, null, 2), { flag: "wx" });
    const temporary = join(dir, `policy-${id}.tmp`);
    const content = JSON.stringify(policy, null, 2) + "\n";
    if (process.platform === "win32" && existsSync(this.path) && lstatSync(this.path).isFile()) {
      createPrivateTextFile(temporary, content);
      try { replaceWindowsFilePreservingMetadata(this.path, temporary); }
      finally { try { unlinkSync(temporary); } catch { /* Published or retained private staging. */ } }
    } else {
      writeFileSync(temporary, content);
      renameSync(temporary, this.path);
    }
    return this.read();
  }
}
