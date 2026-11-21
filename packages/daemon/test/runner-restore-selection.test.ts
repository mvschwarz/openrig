import { expect, it, vi } from "vitest";
import os from "node:os";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

it.each(["pi", "omp"].flatMap(runtime => [false, true].map(selected => ({ runtime, selected }))))("legacy $runtime restore forwards selection guard when selected=$selected", async ({ runtime, selected }) => {
  const db = createFullTestDb();
  try {
    const app = createTestApp(db);
    const rig = app.rigRepo.createRig("owned-runner-selection");
    const node = app.rigRepo.addNode(rig.id, "worker", { runtime, cwd: os.tmpdir() });
    const resume = vi.fn(async () => ({ ok: false, code: "attention_required", message: "Controlled native refusal" }));
    Object.assign(app.restoreOrchestrator, {
      piResume: { canResume: (type: string) => type === "pi_session_file", resume },
      ompResume: { canResume: (type: string) => type === "omp_session_file", resume },
    });
    const guard = () => selected;
    const result = await (app.restoreOrchestrator as any).attemptResume(node.id, "owned-session", `${runtime}_session_file`, "/owned-session.jsonl",
      os.tmpdir(), undefined, undefined, "floor", undefined, [], undefined, guard);
    expect(result).toMatchObject({ kind: "attention_required" });
    expect(resume).toHaveBeenCalledTimes(selected ? 1 : 0);
    if (selected) expect((resume.mock.calls[0] as unknown[])[7]).toBe(guard);
  } finally { db.close(); }
});
