import type { RigSpec } from "./types.js";

/**
 * Build B — spec-vs-live topology conformance.
 *
 * A rig spec is consumed as AUTHORITATIVE by everything that recreates or describes a rig
 * (instantiation, `rig validate`, bundle export, pod-bundle vendoring) and is MAINTAINED by nothing
 * that mutates one. `rig expand` adds a pod to a running rig through the daemon; no code path writes
 * the rigRoot spec back. So drift is not an accident to be prevented here — with no writer it is
 * guaranteed — and this module does not try to prevent it.
 *
 * What it does is make the drift SAYABLE at the two moments it causes damage: a bundle export, which
 * copies the spec verbatim and would otherwise ship a smaller rig than the one running, in silence;
 * and an explicit conformance check, which is how a later spec write-back gets VERIFIED instead of
 * eyeballed.
 *
 * REPORTING ONLY. Nothing here mutates a spec or blocks an export.
 */

export interface Topology {
  /** Pod ids, e.g. `orch`. */
  pods: string[];
  /** Fully-qualified seat ids, e.g. `orch.lead`. */
  seats: string[];
}

export interface ConformanceResult {
  conforms: boolean;
  spec: { pods: number; seats: number };
  live: { pods: number; seats: number };
  /** Running but undeclared — what a bundle export would silently DROP. */
  podsMissingFromSpec: string[];
  seatsMissingFromSpec: string[];
  /** Declared but not running — what a re-instantiation would try to bring up. */
  podsMissingFromLive: string[];
  seatsMissingFromLive: string[];
  /**
   * A single actionable line naming the REAL delta, or null when the topologies agree.
   *
   * Null-on-conformance is the contract, not an implementation detail. A check that warns every
   * time trains its reader to skim, and the one export that matters then reads like the ninety-six
   * before it. Callers may print this whenever it is non-null and print nothing when it is not.
   */
  message: string | null;
}

/** Sorted, de-duplicated, blank-free — so ordering never manufactures a delta. */
function normalize(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === "string" && v.trim() !== ""))).sort();
}

function missing(from: readonly string[], against: readonly string[]): string[] {
  const present = new Set(against);
  return from.filter((v) => !present.has(v));
}

export function compareSpecToLive(spec: Topology, live: Topology): ConformanceResult {
  const specPods = normalize(spec.pods);
  const specSeats = normalize(spec.seats);
  const livePods = normalize(live.pods);
  const liveSeats = normalize(live.seats);

  const podsMissingFromSpec = missing(livePods, specPods);
  const seatsMissingFromSpec = missing(liveSeats, specSeats);
  const podsMissingFromLive = missing(specPods, livePods);
  const seatsMissingFromLive = missing(specSeats, liveSeats);

  const conforms =
    podsMissingFromSpec.length === 0 &&
    seatsMissingFromSpec.length === 0 &&
    podsMissingFromLive.length === 0 &&
    seatsMissingFromLive.length === 0;

  const result: ConformanceResult = {
    conforms,
    spec: { pods: specPods.length, seats: specSeats.length },
    live: { pods: livePods.length, seats: liveSeats.length },
    podsMissingFromSpec,
    seatsMissingFromSpec,
    podsMissingFromLive,
    seatsMissingFromLive,
    message: null,
  };
  if (conforms) return result;

  // Name the actual delta. A generic "topology may differ" is the caution a reader learns to skip.
  const parts = [
    `spec declares ${result.spec.pods} pods/${result.spec.seats} seats; live rig has ${result.live.pods}/${result.live.seats}`,
  ];
  if (podsMissingFromSpec.length) parts.push(`pods running but ABSENT FROM THE SPEC: ${podsMissingFromSpec.join(", ")}`);
  if (seatsMissingFromSpec.length) parts.push(`seats absent from the spec: ${seatsMissingFromSpec.join(", ")}`);
  if (podsMissingFromLive.length) parts.push(`pods declared but NOT RUNNING: ${podsMissingFromLive.join(", ")}`);
  if (seatsMissingFromLive.length) parts.push(`seats declared but not running: ${seatsMissingFromLive.join(", ")}`);
  result.message = parts.join("; ");
  return result;
}

/** Pods and seats as the SPEC declares them. */
export function topologyFromRigSpec(spec: Pick<RigSpec, "pods">): Topology {
  const pods: string[] = [];
  const seats: string[] = [];
  for (const pod of spec.pods ?? []) {
    if (!pod?.id) continue;
    pods.push(pod.id);
    for (const member of pod.members ?? []) {
      if (member?.id) seats.push(`${pod.id}.${member.id}`);
    }
  }
  return { pods, seats };
}

/**
 * Pods and seats as the DAEMON is actually running them, derived from node logical ids
 * (`<pod>.<member>`). Malformed or empty ids are skipped rather than guessed at — an id we cannot
 * parse is not evidence of a pod.
 */
export function topologyFromLiveLogicalIds(logicalIds: readonly (string | null | undefined)[]): Topology {
  const pods: string[] = [];
  const seats: string[] = [];
  for (const id of logicalIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    const dot = trimmed.indexOf(".");
    if (dot <= 0 || dot === trimmed.length - 1) continue;
    const pod = trimmed.slice(0, dot);
    if (!pods.includes(pod)) pods.push(pod);
    seats.push(trimmed);
  }
  return { pods, seats };
}

/**
 * Seats as a LEGACY (v1) spec declares them — a flat `nodes:` list with no pods.
 *
 * A v1 spec exports through the same create endpoint and produces the same confidently-wrong
 * artifact, so it needs the same comparison. It does not need a second comparator: a legacy rig is
 * just a topology with no pod level, and `compareSpecToLive` already handles an empty pod list.
 */
export function topologyFromLegacyRigSpec(spec: { nodes?: ReadonlyArray<{ id?: unknown }> }): Topology {
  const seats: string[] = [];
  for (const node of spec.nodes ?? []) {
    if (typeof node?.id === "string" && node.id.trim() !== "") seats.push(node.id.trim());
  }
  return { pods: [], seats };
}

/**
 * Seats as the daemon is running them, read FLAT — the legacy counterpart to
 * `topologyFromLiveLogicalIds`.
 *
 * For a legacy rig a node's `logical_id` IS the spec's `node.id`; there is no `<pod>.<member>` to
 * split. Reusing the pod-aware reader here would parse every flat id as malformed and report an
 * empty live rig, which reads as "nothing is running" — a false absence, and the most dangerous
 * possible answer for a guard whose whole job is noticing what would be dropped.
 */
export function topologyFromLiveNodeIds(logicalIds: readonly (string | null | undefined)[]): Topology {
  const seats: string[] = [];
  for (const id of logicalIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed !== "") seats.push(trimmed);
  }
  return { pods: [], seats };
}

/** The one-line export banner. Null when there is nothing to say. */
export function bundleExportWarning(result: ConformanceResult): string | null {
  if (result.message === null) return null;
  return `WARNING: this bundle describes the SPEC, not the live rig — ${result.message}. The bundle will instantiate ${result.spec.pods} pods/${result.spec.seats} seats.`;
}
