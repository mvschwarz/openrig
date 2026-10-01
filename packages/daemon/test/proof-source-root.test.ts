import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { watchProofSources } from "../src/domain/proof/source-watch.js";
import { readSliceReadiness, recordJudgment } from "../src/domain/proof/judgments.js";
import type { EventBus } from "../src/domain/event-bus.js";

it("watches the owning project policy above a nested missions root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-nested-root-"));
  const missions = path.join(root, "work", "initiatives");
  const slice = path.join(missions, "trial", "slices", "01-alpha");
  fs.mkdirSync(path.join(slice, "proof"), { recursive: true });
  const project = "kind: project\nmissions:\n  root: work/initiatives\nproofPolicy:\n  judges: [judge@trial]\n";
  const projectFile = path.join(root, "project.yaml");
  fs.writeFileSync(projectFile, project);
  fs.writeFileSync(path.join(missions, "trial", "mission.yaml"), "kind: mission\ncomposition:\n  slices:\n    - ref: slices/01-alpha/slice.yaml\n      order: 1\n");
  fs.writeFileSync(path.join(slice, "slice.yaml"), "kind: slice\nmetadata:\n  id: alpha\n");
  fs.writeFileSync(path.join(slice, "SPEC.md"), "# Alpha\n\n## Proof contract\n- [ ] Prove alpha.\n");
  fs.writeFileSync(path.join(slice, "proof", "evidence.md"), "Observed outcome.\n");
  const item = readSliceReadiness(slice).items[0]!;
  recordJudgment(missions, { scope: "trial/slices/01-alpha", item: item.id, verdict: "accept",
    evidence: ["proof/evidence.md"], reason: "Observed fixture", expectedRevision: item.revision,
    expectedPrevious: null }, "judge@trial", "fixture");
  expect(readSliceReadiness(slice).state).toBe("ready");
  const events: unknown[] = [];
  let invalidated = 0;
  const watch = watchProofSources(missions, () => invalidated++, {
    emit: (event: unknown) => events.push(event),
  } as unknown as EventBus);
  try {
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(events).toHaveLength(0);
    const before = watch.observation().revision;
    fs.writeFileSync(projectFile, project.replace("judge@trial", "other-judge@trial"));
    expect(readSliceReadiness(slice).state).toBe("unknown");
    await expect.poll(() => events.length, { timeout: 5000 }).toBe(1);
    expect(invalidated).toBe(1);
    expect(watch.observation().revision).not.toBe(before);
    fs.writeFileSync(projectFile, fs.readFileSync(projectFile));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(events).toHaveLength(1);
  } finally { watch.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("retains the existing watch boundary for roots without project.yaml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-legacy-root-"));
  const missions = path.join(root, "missions");
  fs.mkdirSync(missions);
  const watch = watchProofSources(missions, () => {}, { emit() {} } as unknown as EventBus);
  try { expect(watch.observation().state).toBe("watching"); }
  finally { watch.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
