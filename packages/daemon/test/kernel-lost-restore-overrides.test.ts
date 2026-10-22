import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { heldRestore, name, corrected } from "./helpers/held-kernel-restore.js";

describe("explicit changes after automatic kernel restore", () => {
  it.each(["up", "explorer"])("%s waits for startup then fresh-primes only the named automatically launched seat", async door => {
    const h = await heldRestore({ at: "create", sibling: true });
    try {
      let settled = false;
      const request = door === "up" ? h.up({ freshLogicalIds: ["operator.agent"] })
        : h.post(`/api/rigs/${h.rig.id}/up`, { freshLogicalIds: ["operator.agent"] });
      const response = request.then(r => { settled = true; return r; });
      await new Promise(r => setTimeout(r, 20));
      expect(settled).toBe(false);
      expect(h.tmux.killSession).not.toHaveBeenCalled();
      await h.finish();
      const answer = await response;
      const body = await answer.json();
      expect(answer.status, JSON.stringify(body)).toBe(200);
      expect(body.nodes).toEqual([expect.objectContaining({ logicalId: "operator.agent", status: "fresh-primed" })]);
      expect(body.warnings.join(" ")).toContain("Stopped operator.agent");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(3);
      expect(h.tmux.killSession).toHaveBeenCalledTimes(1);
      expect(h.tmux.killSession).toHaveBeenCalledWith(name);
      expect(h.live.has("advisor-agent@kernel")).toBe(true);
    } finally { h.close(); }
  });

  it.each(["up", "explorer", "restore"])("explicit %s applies an operator correction only to that startup seat", async door => {
    const h = await heldRestore({ at: "launch", sibling: true });
    try {
      const update = await h.post(`/api/sessions/${name}/resume-token`, { token: corrected, reason: "operator correction" });
      expect(update.status).toBe(200);
      expect(h.tmux.killSession).not.toHaveBeenCalled(); // A token edit alone has no effect.
      const response = door === "up" ? h.up() : door === "explorer" ? h.post(`/api/rigs/${h.rig.id}/up`, {})
        : h.post(`/api/rigs/${h.rig.id}/restore/${h.snapshot.id}`, {});
      await h.finish();
      const answer = await response;
      const body = await answer.json();
      expect(answer.status, JSON.stringify(body)).toBe(door === "restore" ? 202 : 200);
      // The explicit restore HTTP door returns its started receipt before the per-seat effect.
      await vi.waitFor(() => expect(h.restoresCompleted()).toBe(2));
      expect(h.adapter.launchHarness.mock.calls.at(-1)?.[1].resumeToken).toBe(corrected);
      expect(h.tmux.createSession).toHaveBeenCalledTimes(3);
      expect(h.tmux.killSession).toHaveBeenCalledTimes(1);
      expect(h.tmux.killSession).toHaveBeenCalledWith(name);
      expect(h.live.has("advisor-agent@kernel")).toBe(true);
    } finally { h.close(); }
  });

  it.each([false, true])("refuses a changed non-interruptive choice from %s without replacing any startup seat", async current => {
    const h = await heldRestore({ at: "launch", nonInterruptive: current });
    try {
      const response = h.up({ nonInterruptive: !current });
      await h.finish();
      const answer = await response;
      const body = await answer.json();
      expect(answer.status).toBe(409);
      expect(body.error).toMatch(/launch choice.*unchanged/i);
      expect(body.error).toMatch(/stop.*rig.*rerun/i);
      expect(h.db.prepare("SELECT non_interruptive FROM rigs WHERE id = ?").get(h.rig.id)).toEqual({ non_interruptive: current ? 1 : 0 });
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
      expect(h.tmux.killSession).not.toHaveBeenCalled();
    } finally { h.close(); }
  });
  it.each(["unknown", "pane", "occupant", "correction", "stop-failed", "absence-unknown", "launch-failed"])("replacement stops safely on %s", async fault => {
    const h = await heldRestore({ at: "launch" });
    try {
      await h.finish();
      const own = h.sessionRegistry.getSessionsForRig(h.rig.id).find(s => s.status === "running")!;
      if (fault === "unknown") vi.mocked(h.tmux.probeSession).mockResolvedValue({ state: "transport_unavailable", detail: "fixture unavailable" } as never);
      if (fault === "pane") vi.mocked(h.tmux.listPanes).mockResolvedValue([{ id: "%other" }] as never);
      if (fault === "occupant" || fault === "correction") vi.mocked(h.tmux.probeSession).mockImplementationOnce(async () => {
        if (fault === "occupant") {
          const other = h.sessionRegistry.registerSession(h.node.id, name);
          h.sessionRegistry.updateStatus(other.id, "running");
        } else h.sessionRegistry.updateResumeToken(own.id, "claude_id", corrected, "operator");
        return { state: "present" };
      });
      if (fault === "stop-failed") vi.mocked(h.tmux.killSession).mockResolvedValue({ ok: false, code: "fixture_stop_failed" } as never);
      if (fault === "absence-unknown") vi.mocked(h.tmux.probeSession)
        .mockResolvedValueOnce({ state: "present" }).mockResolvedValueOnce({ state: "present" })
        .mockResolvedValue({ state: "transport_unavailable" } as never);
      if (fault === "launch-failed") vi.mocked(h.tmux.createSession).mockResolvedValue({ ok: false, code: "fixture_launch_failed" } as never);
      const response = await h.up({ freshLogicalIds: ["operator.agent"] });
      const body = await response.json();
      if (fault === "unknown") expect(response.status).toBe(409);
      else expect(body.nodes).toEqual([expect.objectContaining({ status: "failed" })]);
      const stopped = ["absence-unknown", "launch-failed"].includes(fault);
      expect(h.tmux.killSession).toHaveBeenCalledTimes(stopped || fault === "stop-failed" ? 1 : 0);
      expect(h.tmux.createSession).toHaveBeenCalledTimes(fault === "launch-failed" ? 2 : 1);
      expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(own.id)).toEqual({ status: stopped ? "exited" : "running" });
    } finally { h.close(); }
  });

  it("a plan after a correction and --fresh remains read-only", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      await h.finish();
      const own = h.sessionRegistry.getSessionsForRig(h.rig.id).find(s => s.status === "running")!;
      h.sessionRegistry.updateResumeToken(own.id, "claude_id", corrected, "operator");
      const before = h.snapshots();
      const response = await h.up({ plan: true, freshLogicalIds: ["operator.agent"], nonInterruptive: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "plan", mutated: false });
      expect(h.snapshots()).toBe(before);
      expect(h.tmux.killSession).not.toHaveBeenCalled();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("an edit alone leaves startup running until an explicit request after completion", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      await h.finish();
      const correction = await h.post(`/api/sessions/${name}/resume-token`, { token: corrected, reason: "operator correction" });
      expect(correction.status).toBe(200);
      await new Promise<void>(r => setImmediate(r));
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
      expect(h.tmux.killSession).not.toHaveBeenCalled();
      const response = await h.up();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ nodes: [{ logicalId: "operator.agent", status: "resumed" }] });
      expect(h.adapter.launchHarness.mock.calls.at(-1)?.[1].resumeToken).toBe(corrected);
      expect(h.tmux.createSession).toHaveBeenCalledTimes(2);
    } finally { h.close(); }
  });

  it("--fresh does not include an independently corrected sibling", async () => {
    const h = await heldRestore({ at: "launch", sibling: true });
    try {
      await h.finish();
      const update = await h.post("/api/sessions/advisor-agent@kernel/resume-token", { token: corrected, reason: "advisor correction" });
      expect(update.status).toBe(200);
      const before = h.sessionRegistry.getSessionsForRig(h.rig.id).find(s => s.sessionName === "advisor-agent@kernel" && s.status === "running")!;
      const response = await h.up({ freshLogicalIds: ["operator.agent"] });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.nodes).toEqual([expect.objectContaining({ logicalId: "operator.agent", status: "fresh-primed" })]);
      expect(h.tmux.killSession).toHaveBeenCalledTimes(1);
      expect(h.tmux.killSession).toHaveBeenCalledWith(name);
      expect(h.tmux.createSession).toHaveBeenCalledTimes(3);
      expect(h.db.prepare("SELECT status, resume_token FROM sessions WHERE id = ?").get(before.id)).toEqual({ status: "running", resume_token: corrected });
    } finally { h.close(); }
  });

  it("a collapsed false liveness check cannot detach an unreadable startup occupant", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      await h.finish();
      const own = h.sessionRegistry.getSessionsForRig(h.rig.id).find(s => s.status === "running")!;
      vi.mocked(h.tmux.hasSession).mockImplementation(n => TmuxAdapter.prototype.hasSession.call(h.tmux, n));
      vi.mocked(h.tmux.probeSession).mockResolvedValue({ state: "transport_unavailable", detail: "fixture transport unavailable" } as never);
      const response = await h.up({ freshLogicalIds: ["operator.agent"] });
      expect(h.tmux.killSession).not.toHaveBeenCalled();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
      expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(own.id)).toEqual({ status: "running" });
      expect(response.status).toBe(409);
    } finally { h.close(); }
  });

});
