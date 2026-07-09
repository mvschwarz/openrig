// OPR.0.4.6.WF4 Q6 — the ● (agent-leg) workflow-identity stamp is derived from
// the item's OWN STRUCTURED TAGS (the WF-5-ratified queryable identity), never
// from summary/identity/evidenceRef prose. This pins that derivation:
// both required keys → a pointer; a missing key or a non-workflow row →
// undefined (so the AttentionInput stays byte-identical, omit-when-absent).

import { describe, expect, it } from "vitest";

import { workflowRefFromTags } from "../src/domain/review/gather.js";

const tags = (...t: string[]) => JSON.stringify(t);

describe("WF-4 Q6: workflowRefFromTags", () => {
  it("derives the full pointer from workflow: + instance: + step: tags", () => {
    expect(
      workflowRefFromTags(
        tags("workflow-exception", "workflow:branched-remediation", "instance:01WFX", "step:verify", "exception:failed"),
      ),
    ).toEqual({ instanceId: "01WFX", workflowName: "branched-remediation", stepId: "verify" });
  });

  it("omits stepId when no step: tag is present", () => {
    const ref = workflowRefFromTags(tags("workflow-exception", "workflow:conveyor", "instance:01WFY"));
    expect(ref).toEqual({ instanceId: "01WFY", workflowName: "conveyor" });
    expect("stepId" in ref!).toBe(false);
  });

  it("is POINTER-ONLY — exactly the identity keys, no exception/occurrence leakage", () => {
    const ref = workflowRefFromTags(
      tags("workflow:gated-release", "instance:01WFZ", "step:gate", "exception:blocked", "occurrence:qitem-9"),
    );
    expect(Object.keys(ref!).sort()).toEqual(["instanceId", "stepId", "workflowName"]);
  });

  it("returns undefined when the instance: key is absent (incomplete pointer, never partial)", () => {
    expect(workflowRefFromTags(tags("workflow:conveyor", "step:build"))).toBeUndefined();
  });

  it("returns undefined when the workflow: key is absent", () => {
    expect(workflowRefFromTags(tags("instance:01WFX", "step:build"))).toBeUndefined();
  });

  it("returns undefined for a non-workflow row (byte-identity-by-omission)", () => {
    expect(workflowRefFromTags(tags("slice:mh-2", "mission:release-0.4.6"))).toBeUndefined();
  });

  it("returns undefined for null / empty / malformed tags", () => {
    expect(workflowRefFromTags(null)).toBeUndefined();
    expect(workflowRefFromTags("[]")).toBeUndefined();
    expect(workflowRefFromTags("not json")).toBeUndefined();
  });
});
