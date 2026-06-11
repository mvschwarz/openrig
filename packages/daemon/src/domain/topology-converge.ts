import type { PodRigInstantiator, AddMemberOutcome } from "./rigspec-instantiator.js";

/**
 * Topology-mutation converge spine (OPR.0.3.3.24, AC-6 scaffold).
 *
 * The reconciler model is: diff(declaredSpec, liveTopology) -> Op[]; converge(op)
 * applies each supported op. This release IMPLEMENTS one op — `add_member` —
 * built on the extracted create-node + launch-binding primitives. The Op union
 * is COMPLETE-shaped (all reshape kinds typed) and the differ CLASSIFIES the
 * full set, but the identity-migrating kinds (remove/move/fork/change_runtime)
 * are CLASSIFIED-deferred to the 0.4.0 identity theme: they migrate or clone an
 * existing seat's identity (logical-id re-key + continuity_state migration +
 * queue re-route), which add_member deliberately does not.
 *
 * This is a SCAFFOLD, not a reconciler build: there is no `rig apply` loop here
 * (that is a design sketch this release). converge() never silently skips an
 * unsupported op — it reports it honestly as "detected, not yet supported".
 */

/** The complete topology-mutation op-kind set. */
export type TopologyOp =
  | { kind: "add_member"; pod: string; member: Record<string, unknown>; edges?: Array<{ from: string; to: string; kind: string }> }
  | { kind: "remove_member"; logicalId: string }
  | { kind: "move_member"; logicalId: string; toPod: string }
  | { kind: "fork_member"; logicalId: string; toMember: string }
  | { kind: "change_runtime"; logicalId: string; runtime: string };

export type TopologyOpKind = TopologyOp["kind"];

/** The op-kinds converge() implements this release. The rest are classified-deferred. */
export const SUPPORTED_OP_KINDS: readonly TopologyOpKind[] = ["add_member"];

export function isSupportedOpKind(kind: TopologyOpKind): boolean {
  return SUPPORTED_OP_KINDS.includes(kind);
}

/** Honest message for a classified-but-unsupported op-kind (never silently skipped). */
export const DEFERRED_OP_REASON = "detected, not yet supported in this release";

export type ConvergeResult =
  | { kind: "add_member"; supported: true; outcome: AddMemberOutcome }
  | { kind: TopologyOpKind; detected: true; supported: false; reason: string };

/** A member as DECLARED in the desired spec (one pod-scoped member fragment). */
export interface DeclaredMember {
  pod: string;
  id: string;
  runtime: string;
  fragment: Record<string, unknown>;
}

/** A member as it exists LIVE in the rig today. */
export interface LiveMember {
  logicalId: string;
  runtime: string;
}

/**
 * Classify the difference between the declared members and the live topology
 * into the complete op-kind set. Scaffold semantics:
 *   - declared but not live              -> add_member        (IMPLEMENTED)
 *   - live but not declared              -> remove_member     (classified-deferred)
 *   - present in both, runtime differs   -> change_runtime    (classified-deferred)
 *
 * move_member and fork_member are part of the Op union (complete-shaped) but are
 * NOT auto-derivable from a flat declarative membership diff: a move is
 * indistinguishable from remove+add without stable-identity tracking, and a fork
 * is imperative-only (no declarative trigger). Detecting them needs the 0.4.0
 * identity model (durable state keyed on the stable node-id). convergeOp still
 * classifies them honestly when handed one directly.
 */
export function diffTopology(declared: DeclaredMember[], live: LiveMember[]): TopologyOp[] {
  const ops: TopologyOp[] = [];
  const liveById = new Map(live.map((m) => [m.logicalId, m]));
  const declaredIds = new Set(declared.map((m) => `${m.pod}.${m.id}`));

  for (const m of declared) {
    const qualifiedId = `${m.pod}.${m.id}`;
    const liveMatch = liveById.get(qualifiedId);
    if (!liveMatch) {
      ops.push({ kind: "add_member", pod: m.pod, member: m.fragment });
    } else if (liveMatch.runtime !== m.runtime) {
      ops.push({ kind: "change_runtime", logicalId: qualifiedId, runtime: m.runtime });
    }
  }

  for (const m of live) {
    if (!declaredIds.has(m.logicalId)) {
      ops.push({ kind: "remove_member", logicalId: m.logicalId });
    }
  }

  return ops;
}

/**
 * Apply a single topology op. `add_member` runs the extracted create-node +
 * launch-binding seam via PodRigInstantiator.addMemberToPod. Every other kind is
 * reported honestly as detected-but-unsupported (NEVER silently skipped). The
 * agent-ergonomics (json + honest 3-part errors) the CLI and MCP expose live ON
 * this converge boundary, so future verbs inherit human/agent parity.
 */
export async function convergeOp(
  instantiator: PodRigInstantiator,
  rigId: string,
  op: TopologyOp,
  rigRoot: string,
  opts?: { cwdOverride?: string },
): Promise<ConvergeResult> {
  switch (op.kind) {
    case "add_member": {
      const outcome = await instantiator.addMemberToPod(rigId, op.pod, op.member, rigRoot, {
        cwdOverride: opts?.cwdOverride,
        edges: op.edges,
      });
      return { kind: "add_member", supported: true, outcome };
    }
    case "remove_member":
    case "move_member":
    case "fork_member":
    case "change_runtime":
      return { kind: op.kind, detected: true, supported: false, reason: DEFERRED_OP_REASON };
    default: {
      const _exhaustive: never = op;
      throw new Error(`Unknown topology op kind: ${(_exhaustive as TopologyOp).kind}`);
    }
  }
}
