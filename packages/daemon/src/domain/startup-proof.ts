import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { NodeOriented } from "./types.js";

// OPR.0.4.3.06 — startup proof (challenge-verified orientation).
//
// The primitive: at a fresh (or fresh-fallback) managed launch the daemon
// issues a per-launch, content-derived CHALLENGE and persists its ground
// truth as an append-only `node.startup_challenged` event (challengeId +
// contractHash). The agent, after reading its startup contract, emits an
// identity-bound `startup_proof` carrying { challengeId, answer }. The daemon
// VERIFIES: identity resolves, the challengeId is THIS launch's (anti-replay),
// and the answer matches the expected answer recomputed from the persisted
// contract hash. Only a verified proof appends `node.startup_proof_verified`
// and projects `oriented: verified` — DISTINCT from `startup_status: ready`,
// which only ever means delivered/interactive. A bare ACK / empty / wrong /
// replayed / identity-mismatched answer is rejected (append-only) and NEVER
// renders oriented.
//
// The expected answer is a pure function of (challengeId, contractHash) and is
// never persisted — it is recomputed at verify time from the persisted hash,
// so later startup-file drift cannot change proof truth (the persisted
// contractHash freezes the launch-time contract).

export type { NodeOriented } from "./types.js";

/** Per-reason reject code (append-only audit; never collapses into ready). */
export type ProofRejectReason =
  | "identity_unbound"
  | "identity_mismatch"
  | "challenge_stale"
  | "contract_mismatch"
  | "bare_ack";

export interface IssuedChallenge {
  challengeId: string;
  contractHash: string;
  /** Recomputable; handed to the prompt so the agent can answer. Not persisted. */
  expectedAnswer: string;
  /** The block appended to / delivered as the startup prompt. */
  promptBlock: string;
}

/** A presence-floor ACK is never proof (business rule 2). */
const BARE_ACK_TOKENS = new Set(["", "ack", "ok", "ready", "done", "oriented", "acknowledged"]);

export function computeContractHash(contractSource: string): string {
  return createHash("sha256").update(contractSource).digest("hex");
}

export function computeExpectedAnswer(challengeId: string, contractHash: string): string {
  return createHash("sha256").update(`${challengeId}:${contractHash}`).digest("hex").slice(0, 32);
}

function buildProofSubmissionCommand(challengeId: string, expectedAnswer: string): string {
  return `rig startup-proof submit --challenge-id ${challengeId} --answer ${expectedAnswer}`;
}

function buildPromptBlock(challengeId: string, expectedAnswer: string): string {
  return [
    "--- OpenRig startup orientation challenge ---",
    `challengeId: ${challengeId}`,
    "After you have read your startup contract (all the files/identity above),",
    "prove you oriented by submitting an authenticated startup_proof with EXACTLY:",
    `  answer: ${expectedAnswer}`,
    "",
    "Run this command from your shell/tools after reading the contract:",
    buildProofSubmissionCommand(challengeId, expectedAnswer),
    "A bare acknowledgement (\"ack\"/\"ready\") is presence only, NEVER proof.",
    "--------------------------------------------",
  ].join("\n");
}

/**
 * Derive + persist (append-only event) a per-launch challenge and return the
 * prompt block. Call at fresh/fresh-fallback managed launch, BEFORE the
 * startup prompt is delivered, so the ground truth exists before any proof.
 */
export function issueStartupChallenge(
  eventBus: EventBus,
  input: { rigId: string; nodeId: string; contractSource: string },
): IssuedChallenge {
  const challengeId = randomBytes(16).toString("hex");
  const contractHash = computeContractHash(input.contractSource);
  const expectedAnswer = computeExpectedAnswer(challengeId, contractHash);

  eventBus.emit({
    type: "node.startup_challenged",
    rigId: input.rigId,
    nodeId: input.nodeId,
    challengeId,
    contractHash,
  });

  return { challengeId, contractHash, expectedAnswer, promptBlock: buildPromptBlock(challengeId, expectedAnswer) };
}

export interface StartupProofInput {
  sessionName?: string | null;
  nodeId?: string | null;
  runtime?: string | null;
  challengeId?: string | null;
  answer?: string | null;
}

export type StartupProofResult =
  | { ok: true; nodeId: string; rigId: string; challengeId: string }
  | { ok: false; code: ProofRejectReason; error: string };

interface ChallengeRow {
  payload: string;
  seq: number;
}

/**
 * Verify an agent-emitted startup proof against the persisted per-launch
 * challenge. Identity-bound + anti-replay + content-correct, or an
 * append-only rejection with a per-reason code. Never sets `ready`; never
 * routes through updateStartupStatus.
 */
export function verifyStartupProof(
  deps: { store: AgentActivityStore; eventBus: EventBus },
  input: StartupProofInput,
): StartupProofResult {
  const { store, eventBus } = deps;
  const db = store.db;

  // (a) IDENTITY — resolve {sessionId,nodeId,rigId}; an unknown identity is
  // rejected and NO node-scoped state is projected (we cannot attribute an
  // event to an unknown node).
  const resolved = store.resolveSession({ sessionName: input.sessionName, nodeId: input.nodeId, runtime: input.runtime });
  if (!resolved) {
    return { ok: false, code: "identity_unbound", error: "startup_proof did not resolve to a managed session/node" };
  }

  // (a2) IDENTITY BINDING — the proof must bind to BOTH nodeId AND sessionName.
  // `resolveSession` prioritizes nodeId and does NOT cross-check a supplied
  // sessionName, so a proof carrying nodeId=node-a + sessionName=node-b would
  // otherwise resolve to (and false-verify) node-a while claiming node-b's
  // identity. Reject any conflict. We do NOT emit a node-scoped rejection for
  // the resolved node here (mirroring identity_unbound): a mismatched /
  // cross-seat / malformed proof must not touch the resolved node's projection
  // at all — never verify it, and never downgrade it to `rejected` either.
  // (runtime is a non-authoritative hint used for hook classification, not an
  // identity key — the seat identity is the nodeId<->sessionName binding.)
  if (input.sessionName && input.sessionName !== resolved.sessionName) {
    return { ok: false, code: "identity_mismatch", error: "startup_proof nodeId and sessionName resolve to different seats" };
  }

  // Ground truth: the latest challenge issued for THIS node.
  const challengeRow = db.prepare(
    "SELECT payload, seq FROM events WHERE node_id = ? AND type = 'node.startup_challenged' ORDER BY seq DESC LIMIT 1"
  ).get(resolved.nodeId) as ChallengeRow | undefined;
  if (!challengeRow) {
    // Never challenged (e.g. a resumed restore, or a non-agent path). A proof
    // has nothing to verify against — reject as stale WITHOUT appending an
    // event, so the node's oriented projection stays honest (`n-a`).
    return { ok: false, code: "challenge_stale", error: "no active startup challenge for this node" };
  }

  let current: { challengeId: string; contractHash: string };
  try {
    current = JSON.parse(challengeRow.payload) as { challengeId: string; contractHash: string };
  } catch {
    return { ok: false, code: "challenge_stale", error: "startup challenge payload unreadable" };
  }

  const answer = (input.answer ?? "").trim();
  const emitRejected = (reason: ProofRejectReason) => {
    eventBus.emit({
      type: "node.startup_proof_rejected",
      rigId: resolved.rigId,
      nodeId: resolved.nodeId,
      challengeId: input.challengeId ?? null,
      reason,
    });
  };

  // (b) THIS-LAUNCH — the answered challenge must be the current one. A
  // replayed prior-launch answer carries a stale challengeId.
  if (!input.challengeId || input.challengeId !== current.challengeId) {
    emitRejected("challenge_stale");
    return { ok: false, code: "challenge_stale", error: "challengeId does not match this launch's challenge (replay/stale)" };
  }

  // (d) bare-ACK / empty / presence-floor is never proof.
  if (BARE_ACK_TOKENS.has(answer.toLowerCase())) {
    emitRejected("bare_ack");
    return { ok: false, code: "bare_ack", error: "a bare acknowledgement is presence only, never proof" };
  }

  // (c) CONTRACT — recompute the expected answer from the persisted contract
  // hash. A plausible-but-content-wrong answer is rejected.
  const expected = computeExpectedAnswer(current.challengeId, current.contractHash);
  if (answer !== expected) {
    emitRejected("contract_mismatch");
    return { ok: false, code: "contract_mismatch", error: "proof answer does not match the delivered startup contract" };
  }

  eventBus.emit({
    type: "node.startup_proof_verified",
    rigId: resolved.rigId,
    nodeId: resolved.nodeId,
    sessionId: resolved.sessionId,
    challengeId: current.challengeId,
    contractHash: current.contractHash,
  });

  return { ok: true, nodeId: resolved.nodeId, rigId: resolved.rigId, challengeId: current.challengeId };
}

/**
 * Project the oriented signal for a node from the append-only proof events.
 * `verified` requires a verified proof for the CURRENT (latest) challenge;
 * `missing` = challenged but not yet proven; `rejected` = the latest proof for
 * the current challenge was rejected; `n-a` = never challenged (resumed /
 * non-agent / skip-harness). NEVER derived from startup_status.
 */
export function deriveOriented(db: Database.Database, nodeId: string): NodeOriented {
  const rows = db.prepare(
    "SELECT type, payload, seq FROM events WHERE node_id = ? AND type IN ('node.startup_challenged','node.startup_proof_verified','node.startup_proof_rejected') ORDER BY seq DESC"
  ).all(nodeId) as Array<{ type: string; payload: string; seq: number }>;

  // Latest challenge governs.
  const challengeRow = rows.find((r) => r.type === "node.startup_challenged");
  if (!challengeRow) return "n-a";
  let currentChallengeId: string;
  try {
    currentChallengeId = (JSON.parse(challengeRow.payload) as { challengeId: string }).challengeId;
  } catch {
    return "n-a";
  }

  // The most-recent proof event referencing the current challenge decides
  // verified-vs-rejected (a later verify overrides an earlier reject).
  for (const row of rows) {
    if (row.type === "node.startup_challenged") continue;
    let cid: string | null = null;
    try { cid = (JSON.parse(row.payload) as { challengeId: string | null }).challengeId; } catch { continue; }
    if (cid !== currentChallengeId) continue;
    return row.type === "node.startup_proof_verified" ? "verified" : "rejected";
  }
  return "missing";
}
