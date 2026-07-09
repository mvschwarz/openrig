// OPR.0.4.6.WF4 (C4) P3 — the ANTI-PROSE negative (arch Q6-P3, made mechanical).
//
// The ONLY workflow-identity join in the UI is the structured Q6 `row.workflow`
// pointer (stamped daemon-side). No UI module may derive an instance id for
// routing/navigation by parsing prose — the `identity` composed string, the
// `evidenceRef` CLI command, the summary, or a tag prefix. This source-level
// grep-negative makes that rule enforceable, not aspirational.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Resolve source files via import.meta.dirname (the vitest-stable anchor used by
// the other source-grep tests, e.g. focused-terminal-lifecycle.test.ts). The
// prior `fileURLToPath(new URL("../src/…", import.meta.url))` form resolved to
// `test/undefined` under this vitest setup — a test-harness path bug, not a
// product issue (OPR.0.4.6.WF4 leg-8 test-only fix).
function src(rel: string): string {
  return readFileSync(path.resolve(import.meta.dirname, "../src", rel), "utf8");
}

const WORKFLOW_UI_FILES = [
  "components/review/NeedsYouAccordion.tsx",
  "components/workflow/WorkflowsPage.tsx",
  "components/workflow/WorkflowInstancePage.tsx",
  "components/workflow/WorkflowInstancesBand.tsx",
  "components/workflow/InstanceTrailTimeline.tsx",
];

describe("WF-4 P3: workflow routing joins the structured pointer, never prose", () => {
  it("the NEEDS-YOU deep-link derives the instance id ONLY from item.workflow (the Q6 pointer)", () => {
    const accordion = src("components/review/NeedsYouAccordion.tsx");
    // The positive join: the structured pointer feeds the route params verbatim.
    expect(accordion).toContain("params={{ instanceId: item.workflow.instanceId }}");
    // The rejected twin field never resurfaces.
    expect(accordion).not.toContain("workflowInstanceRef");
  });

  it("no workflow UI module parses identity / evidenceRef / summary strings for navigation", () => {
    for (const rel of WORKFLOW_UI_FILES) {
      const s = src(rel);
      // A prose parse feeding an instance id (the exact failure the rule bans):
      // `.split(` producing an id, or evidenceRef/identity/summary used to build
      // a route param. None of these patterns may appear.
      expect(s, `${rel} must not derive an instanceId from a split() parse`).not.toMatch(
        /instanceId[^\n]*\.split\(|\.split\([^\n]*instanceId/,
      );
      expect(s, `${rel} must not route off the evidenceRef CLI string`).not.toMatch(
        /to=\{[^}]*evidenceRef|params=\{\{[^}]*evidenceRef/,
      );
      expect(s, `${rel} must not route off the composed identity string`).not.toMatch(
        /params=\{\{[^}]*identity[^}]*\}\}/,
      );
    }
  });

  it("the instance route param comes from a structured field, never a tag-prefix slice", () => {
    // Any `to="/workflow/instance/..."` navigation in these files must resolve
    // its instanceId from `.instanceId` (a structured field), never from a
    // string manipulation of a tag/prose value.
    for (const rel of WORKFLOW_UI_FILES) {
      const s = src(rel);
      const usesInstanceRoute = s.includes("/workflow/instance/$instanceId");
      if (!usesInstanceRoute) continue;
      // Every such file resolves the param from a `.instanceId` structured read.
      expect(s, `${rel} routes to the instance page but not via a structured .instanceId`).toMatch(
        /instanceId:\s*[A-Za-z0-9_.]*\.instanceId/,
      );
    }
  });
});
