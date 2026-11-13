// The roll call of `rig ps --nodes --summary`: agent seats by what the daemon already reports, with what each bucket counts.
import { describe, expect, it } from "vitest";
import { rollCall, rollCallBucket, ROLL_CALL_EVIDENCE } from "../src/commands/ps.js";

type Node = Parameters<typeof rollCallBucket>[0];
const seat = (over: Partial<Node>): Node => ({
  rigId: "r1", rigName: "rig", logicalId: "dev.one", podId: null, canonicalSessionName: "dev-one@rig", nodeKind: "agent", runtime: "claude-code",
  model: null, sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null,
  latestError: null, ...over,
} as Node);
// The daemon's served verdict when the pane's process contradicts the seat (seat-identity-reconciler.ts).
const shellCheck = (observedCommand: string) =>
  ({ verdict: "mismatch", reason: "process_identity_mismatch", evidence: { observedCommand } });
const ambiguousCheck = { ...shellCheck("zsh"), reason: "process_identity_ambiguous" };
const hook = (state: "running" | "idle" | "needs_input" | "unknown", extra: Record<string, unknown> = {}) =>
  ({ state, reason: "hook", evidenceSource: "runtime_hook", sampledAt: "2026-11-13T22:00:00.000Z", evidence: null, ...extra });

describe("the node summary's roll call", () => {
  it.each([
    ["an agent a hook reports, with its original conversation resumed", { agentActivity: hook("idle"), continuityOutcome: "resumed" }, "originalConversation"],
    ["an agent a hook reports, with no resume recorded", { agentActivity: hook("running"), continuityOutcome: "fresh" }, "agentRunningConversationUnproven"],
    ["restore's bare shell", { startupStatus: "attention_required", latestErrorStage: "harness_not_started", agentActivity: hook("idle") }, "bareShell"],
    ["other startup attention", { startupStatus: "attention_required", latestErrorStage: "proof_selection" }, "unknown"],
    ["no session", { sessionStatus: "stopped" }, "sessionMissing"],
    ["a session tmux reports missing, which the daemon serves as detached", { sessionStatus: "detached", identityVerdict: { verdict: "pane_missing", reason: "session_missing" } }, "sessionMissing"],
    ["the identity check seeing a shell, with a recent hook", { startupStatus: "attention_required", identityVerdict: shellCheck("zsh"), agentActivity: hook("idle"), continuityOutcome: "resumed" }, "bareShell"],
    ["the identity check seeing a login shell, with no hook", { startupStatus: "attention_required", identityVerdict: shellCheck("-bash") }, "bareShell"],
    ["an ambiguous identity check, with no hook", { startupStatus: "attention_required", identityVerdict: ambiguousCheck }, "unknown"],
    ["an ambiguous identity check, with a fresh hook", { startupStatus: "attention_required", identityVerdict: ambiguousCheck, agentActivity: hook("running") }, "agentRunningConversationUnproven"],
    ["another agent in the pane, with no hook", { startupStatus: "attention_required", identityVerdict: shellCheck("codex") }, "unknown"],
    ["another agent in the pane, with a fresh hook and a resume", { startupStatus: "attention_required", identityVerdict: shellCheck("codex"), agentActivity: hook("idle"), continuityOutcome: "resumed" }, "unknown"],
    ["an identity check tmux couldn't answer, with no hook", { identityVerdict: { verdict: "tmux_unavailable", reason: "tmux_unavailable" } }, "unknown"],
    ["an identity check tmux couldn't answer, with a fresh hook and a resume", { identityVerdict: { verdict: "tmux_unavailable", reason: "tmux_unavailable" }, agentActivity: hook("idle"), continuityOutcome: "resumed" }, "originalConversation"],
    ["a Codex seat's unavailable check, with a fresh hook", { runtime: "codex", startupStatus: "attention_required", identityVerdict: { verdict: "mismatch", reason: "tmux_unavailable" }, agentActivity: hook("idle") }, "agentRunningConversationUnproven"],
    ["a live session with no agent evidence", {}, "unknown"],
    ["a pane heuristic, not a hook", { agentActivity: { ...hook("running"), evidenceSource: "pane_heuristic" } }, "unknown"],
    ["a stale hook report", { agentActivity: hook("idle", { stale: true }), continuityOutcome: "resumed" }, "unknown"],
    ["a fallback hook report", { agentActivity: hook("idle", { fallback: true }) }, "unknown"],
    ["a hook reporting unknown", { agentActivity: hook("unknown") }, "unknown"],
  ] as const)("reads %s", (_label, over, bucket) => {
    expect(rollCallBucket(seat(over as Partial<Node>))).toBe(bucket);
  });

  it("says in each bucket's evidence how identity evidence weighs against a hook", () => {
    expect(ROLL_CALL_EVIDENCE.unknown).toContain("different agent than the seat's, which conflicts with any hook report");
    expect(ROLL_CALL_EVIDENCE.originalConversation).toContain("An ambiguous or unavailable identity check doesn't outweigh the hook");
    expect(ROLL_CALL_EVIDENCE.agentRunningConversationUnproven).toContain("An ambiguous or unavailable identity check doesn't outweigh the hook");
  });

  it("counts agent seats only, names them, and says what each bucket counts", () => {
    const call = rollCall([
      seat({ canonicalSessionName: "a@rig", agentActivity: hook("idle") as Node["agentActivity"], continuityOutcome: "resumed" }),
      seat({ canonicalSessionName: "b@rig", startupStatus: "attention_required", latestErrorStage: "harness_not_started" }),
      seat({ canonicalSessionName: "c@rig" }),
      seat({ canonicalSessionName: "term@rig", nodeKind: "infrastructure", sessionStatus: "running" }),
    ]);
    expect(call.agentSeats).toBe(3);
    expect(call.originalConversation).toEqual({ count: 1, seats: ["a@rig"], evidence: ROLL_CALL_EVIDENCE.originalConversation });
    expect(call.bareShell).toMatchObject({ count: 1, seats: ["b@rig"] });
    expect(call.unknown).toMatchObject({ count: 1, seats: ["c@rig"] });
    expect(call.agentRunningConversationUnproven.count + call.sessionMissing.count).toBe(0);
  });
});
