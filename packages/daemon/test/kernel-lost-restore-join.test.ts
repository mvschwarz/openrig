// #1078 — what a manual `rig up kernel --existing` does while daemon start is restoring the kernel.
// The same restore waits for the running one and reports its outcome; a request for something else
// (non-interruptive choice, plan) or for a target that has changed since (an operator's token
// correction, with or without a new snapshot) is not merged. Real SQLite, reconcile, restore and HTTP
// routes; terminal and provider I/O are fixtures, with the automatic launch held at a gate.
// Derived from dev-review's boundary reproductions in its reviews of bc72e6bf and 0bd8f934.

import { describe, it, expect } from "vitest";
import { corrected, heldRestore, name, token } from "./helpers/held-kernel-restore.js";

describe("manual up while daemon start restores the kernel", () => {
  it.each([true, false])("a non-interruptive choice (%s) is not merged", async (nonInterruptive) => {
    const h = await heldRestore({ at: "create" });
    try {
      // It waits on the seat leases the automatic restore holds; it is never reported as that
      // restore's outcome and launches nothing of its own while the rig is up.
      const collision = h.up({ nonInterruptive });
      await h.finish();
      const response = await collision;
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json())).not.toContain("no second restore");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("a plan stays read-only and is not merged", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      const before = h.snapshots();
      const response = await h.up({ plan: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "plan", mutated: false });
      expect(h.snapshots()).toBe(before);
      await h.finish();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("a failed automatic restore is the joined request's outcome, without rig down advice", async () => {
    const h = await heldRestore({ at: "create", launchFails: true });
    try {
      const joined = await h.upWhileHeld();
      expect(joined.settledWhileHeld).toBe(false);
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body).toMatchObject({ status: "restored", rigResult: "failed" });
      expect(joined.body.warnings[0]).toContain("no second restore was started");
      expect(JSON.stringify(joined.body)).not.toMatch(/rig down|guard_target_changed|rig_not_stopped/);
      expect((await h.automatic()).errors.length).toBeGreaterThan(0);
      await new Promise<void>(r => setImmediate(r));
      expect(h.tracker.getStatus().kernelState).toBe("bootstrap_failed");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it.each([
    ["an operator's token correction", corrected, false, false],
    ["a token correction and a new snapshot of it", corrected, true, false],
    ["the same token and a new snapshot", token, true, true],
  ] as const)("after %s: joins only for the same target", async (_label, attested, snapshot, joins) => {
    const h = await heldRestore({ at: "launch" });
    try {
      const correction = await h.post(`/api/sessions/${encodeURIComponent(name)}/resume-token`,
        { token: attested, reason: "correct the current restore target" });
      expect(correction.status, JSON.stringify(await correction.clone().json())).toBe(200);
      if (snapshot) expect((await h.post(`/api/rigs/${h.rig.id}/snapshots`, { kind: "manual" })).status).toBe(201);
      const answer = await h.upWhileHeld();
      if (joins) {
        expect(answer.settledWhileHeld).toBe(false);
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(answer.body).toMatchObject({ status: "restored", rigResult: "fully_restored" });
        expect(answer.body.warnings[0]).toContain("no second restore was started");
      } else {
        expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(answer.body.warnings ?? [])).not.toContain("no second restore");
      }
      await h.finish();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });
});
