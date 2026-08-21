// B1 ROUND 2 — the restore lifecycle RENDER. HIGH-4 discriminator: the done view puts each need on its
// OWN triage row (via the shipped renderTriage), so the exact need AND the not_attempted remediation are
// present in full — r2's probe found both ABSENT when they were crammed into one width-clipped footer.
import { describe, it, expect } from "vitest";
import { buildRestoreLifecycleVM, type RestoreFrame } from "../src/crash-cart/restore-lifecycle.js";
import { renderRestoreLifecycleView } from "../src/crash-cart/render-crash-cart.js";

function frame(over: Partial<RestoreFrame>): RestoreFrame {
  return {
    attemptId: "fleet-1",
    phase: over.phase ?? "done",
    done: over.done ?? true,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "mixed",
    rollup: over.rollup ?? { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
  };
}

describe("renderRestoreLifecycleView — done", () => {
  it("HIGH-4: the exact attention need AND the not_attempted remediation each render on their own row (unclipped)", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "done",
        verdict: "mixed",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 },
          sequence: [
            { rigId: "kernel", outcome: "fully_restored" },
            { rigId: "beta", outcome: "not_attempted", reason: "no restore-usable snapshot for this rig", remediation: "take a snapshot" },
          ],
          attention_required: [
            { rigId: "kernel", seat: "dev.guard", need: "original session not resumable and no --fresh — choose fresh-prime or skip" },
          ],
        },
      }),
    );
    const lines = renderRestoreLifecycleView(vm);
    const body = lines.map((l) => l.text).join("\n");
    expect(body).toContain("FLEET RESTORE: mixed");
    expect(body).toContain("NEEDS ATTENTION (2)"); // one attention seat + one not_attempted rig
    expect(body).toContain("dev.guard@kernel");
    expect(body).toContain("choose fresh-prime or skip"); // the exact need, in full
    expect(body).toContain("take a snapshot"); // the not_attempted remediation, in full
    // and each need is on its OWN line (not one crammed footer)
    const needLine = lines.find((l) => l.text.includes("choose fresh-prime or skip"))!;
    const remedLine = lines.find((l) => l.text.includes("take a snapshot"))!;
    expect(needLine).not.toBe(remedLine);
  });

  it("all-clean done → the triage all-clean line, no NEEDS ATTENTION", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        verdict: "all_fully_restored",
        rollup: { counts: { fully_restored: 3, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
      }),
    );
    const body = renderRestoreLifecycleView(vm).map((l) => l.text).join("\n");
    expect(body).toContain("all seats restored clean");
    expect(body).not.toContain("NEEDS ATTENTION");
  });
});

describe("renderRestoreLifecycleView — running (mid-run progress frame)", () => {
  it("shows a per-rig progress list + the cancel affordance while running", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "running",
        done: false,
        verdict: "none_attempted",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 0 },
          sequence: [{ rigId: "kernel", outcome: "fully_restored" }],
          attention_required: [],
        },
      }),
    );
    const body = renderRestoreLifecycleView(vm).map((l) => l.text).join("\n");
    expect(body).toContain("RESTORING FLEET");
    expect(body).toContain("kernel");
    expect(body).toContain("c cancel");
    expect(body).not.toContain("NEEDS ATTENTION"); // triage only on the done view
  });
});
