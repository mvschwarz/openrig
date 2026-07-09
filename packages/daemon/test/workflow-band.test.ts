// OPR.0.4.6.WF5 FR-3: the workflow-aware ▲ band + THE AWARENESS CHANNEL —
// pure composition tests over recorded views (the gatherer assembles;
// this derives). One-count across channels: human-routed ● item → ZERO
// rows here; orchestrator-routed ● item → exactly ONE awareness row;
// item-less exception → the ▲ backstop naming the missing-item anomaly;
// non-open frontier ref → the anomaly row; healthy → zero rows.

import { describe, expect, it } from "vitest";

import {
  composeNeedsYou,
  deriveWorkflowExceptions,
  type AttentionInput,
  type WorkflowExceptionInput,
} from "../src/domain/review/compose.js";

const NOW = "2026-07-07T06:00:00.000Z";

const wf = (over: Partial<WorkflowExceptionInput> = {}): WorkflowExceptionInput => ({
  instanceId: "01WFX",
  workflowName: "wf5-pipeline",
  status: "failed",
  currentStepId: null,
  deadlineState: "healthy",
  deadlineEvidence: null,
  frontierRefsNonOpenPacket: false,
  openItem: null,
  ...over,
});

const orchItem = {
  qitemId: "qitem-exc-1",
  destinationSession: "orch-lead@rig",
  humanRouted: false,
  createdAtIso: "2026-07-07T05:30:00.000Z",
  summary: "workflow step failed with no remediation branch",
};

describe("WF-5 FR-3: deriveWorkflowExceptions", () => {
  it("healthy instances render ZERO rows (the band's zero-noise negative)", () => {
    expect(
      deriveWorkflowExceptions([wf({ status: "active" })], "rig", NOW),
    ).toHaveLength(0);
  });

  it("ORCHESTRATOR-routed exception → exactly ONE awareness row: holder + age + evidence, distinct-from-to-do", () => {
    const rows = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.derived?.kind).toBe("awareness");
    expect(r.summary).toContain("held by orch-lead@rig");
    expect(r.derived?.evidence).toContain("qitem-exc-1");
    expect(r.derived?.evidence).toContain("30m");
    expect(r.derived?.threshold).toContain("awareness");
    expect(r.evidenceRef).toContain("rig workflow trace 01WFX");
  });

  it("HUMAN-routed exception → NO row (the ● item IS the human's row — no double render)", () => {
    const rows = deriveWorkflowExceptions(
      [wf({ openItem: { ...orchItem, destinationSession: "human@host", humanRouted: true } })],
      "rig",
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("failed with NO item → the ▲ backstop naming the exception AND the missing-item anomaly", () => {
    const rows = deriveWorkflowExceptions([wf()], "rig", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derived?.kind).toBe("workflow-failed");
    expect(rows[0]!.derived?.evidence).toContain("MISSING-ITEM ANOMALY");
  });

  it("stuck (in-flight past threshold) with no item → ▲ row carrying the evaluator's evidence + threshold", () => {
    const rows = deriveWorkflowExceptions(
      [
        wf({
          status: "active",
          deadlineState: "overdue-unclaimed",
          deadlineEvidence: "step review packet qitem-9 held by reviewer@rig — 3600s past the created_at anchor",
        }),
      ],
      "rig",
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derived?.kind).toBe("stuck");
    expect(rows[0]!.derived?.evidence).toContain("3600s past the created_at anchor");
  });

  it("frontier-references-non-open-packet → the ANOMALY row (detection behind the WF-3 FR-6 prevention guard)", () => {
    const rows = deriveWorkflowExceptions(
      [wf({ status: "active", frontierRefsNonOpenPacket: true })],
      "rig",
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derived?.kind).toBe("anomaly");
    expect(rows[0]!.derived?.evidence).toContain("close-path guard");
  });

  it("recomposition clears: the same instance recomposed after resolution renders nothing (state-exit, never hand-clearing)", () => {
    const before = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    expect(before).toHaveLength(1);
    const after = deriveWorkflowExceptions([wf({ status: "active", openItem: null })], "rig", NOW);
    expect(after).toHaveLength(0);
  });

  it("one-count through the band: the awareness row survives composeNeedsYou dedup exactly once", () => {
    const derived = deriveWorkflowExceptions(
      [wf({ openItem: orchItem }), wf({ openItem: orchItem })],
      "rig",
      NOW,
    );
    const band = composeNeedsYou([], derived, [], "test", NOW);
    expect(band.items.filter((i) => i.derived?.kind === "awareness")).toHaveLength(1);
  });
});

// OPR.0.4.6.WF4 Q6 — the row.workflow identity stamp: ONE structured pointer,
// derived once daemon-side, POINTER-ONLY (the three identity keys, never
// status/deadline/class), OMITTED for non-workflow rows (byte-identity).
const att = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  qitemId: "qitem-1",
  summary: "a plain non-workflow attention row",
  leg: "human-routed",
  where: "human@host",
  createdAtIso: NOW,
  priority: null,
  tier: "human-gate",
  evidenceRef: null,
  unblocks: null,
  destinationSession: "human@host",
  closureRequiredAtIso: null,
  ...over,
});

describe("WF-4 Q6: row.workflow identity stamp", () => {
  it("P2 pointer-only — a derived row's workflow is EXACTLY the identity keys (no status/deadline/class)", () => {
    const rows = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    // currentStepId null → stepId OMITTED (never null-stamped)
    expect(rows[0]!.workflow).toEqual({ instanceId: "01WFX", workflowName: "wf5-pipeline" });
    expect(Object.keys(rows[0]!.workflow!).sort()).toEqual(["instanceId", "workflowName"]);
  });

  it("P2 — stepId rides the pointer when the instance carries a current step", () => {
    const rows = deriveWorkflowExceptions(
      [wf({ status: "active", currentStepId: "verify", frontierRefsNonOpenPacket: true })],
      "rig",
      NOW,
    );
    expect(rows[0]!.workflow).toEqual({ instanceId: "01WFX", workflowName: "wf5-pipeline", stepId: "verify" });
  });

  it("uniform stamp — all THREE derived kinds (anomaly / awareness / backstop) carry the pointer", () => {
    const anomaly = deriveWorkflowExceptions([wf({ status: "active", frontierRefsNonOpenPacket: true })], "rig", NOW);
    const awareness = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    const backstop = deriveWorkflowExceptions([wf()], "rig", NOW);
    expect(anomaly[0]!.derived?.kind).toBe("anomaly");
    expect(awareness[0]!.derived?.kind).toBe("awareness");
    expect(backstop[0]!.derived?.kind).toBe("workflow-failed");
    for (const rows of [anomaly, awareness, backstop]) {
      expect(rows[0]!.workflow?.instanceId).toBe("01WFX");
    }
  });

  it("the ● agent leg carries the gatherer's pointer verbatim through composeNeedsYou", () => {
    const workflow = { instanceId: "01WFX", workflowName: "wf5-pipeline", stepId: "verify" };
    const band = composeNeedsYou([att({ workflow })], [], [], "test", NOW);
    const row = band.items.find((i) => i.source === "agent")!;
    expect(row.workflow).toEqual(workflow);
  });

  it("P1 omit-when-absent — a NON-workflow ● row has NO workflow key (byte-identity)", () => {
    const band = composeNeedsYou([att()], [], [], "test", NOW);
    const row = band.items.find((i) => i.source === "agent")!;
    expect("workflow" in row).toBe(false);
  });

  it("P1 omit-when-absent — a workflow-free composition serializes with ZERO workflow keys", () => {
    const band = composeNeedsYou([att(), att({ qitemId: "qitem-2" })], [], [], "test", NOW);
    expect(JSON.stringify(band).includes('"workflow"')).toBe(false);
  });
});
