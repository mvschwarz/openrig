import { describe, it, expect, vi } from "vitest";
import { heldRestore } from "./helpers/held-kernel-restore.js";

describe("explicit requests meeting a rejected automatic restore", () => {
  it.each(["up", "fresh", "explorer", "explorer-fresh", "restore"])("%s falls back to ordinary restore after rejection", async door => {
    const h = await heldRestore({ at: "create", automaticReject: true });
    try {
      const fresh = door.endsWith("fresh") || door === "fresh";
      const body = fresh ? { freshLogicalIds: ["operator.agent"] } : {};
      let settled = false;
      const pending = (door === "restore" ? h.post(`/api/rigs/${h.rig.id}/restore/${h.snapshot.id}`, {})
        : door.startsWith("explorer") ? h.post(`/api/rigs/${h.rig.id}/up`, body) : h.up(body))
        .then(response => { settled = true; return response; });
      await new Promise(r => setTimeout(r, 20));
      expect(settled).toBe(false);
      await expect(h.finish()).rejects.toThrow("fixture automatic restore rejected");
      const response = await pending;
      const answer = await response.json();
      expect(response.status, JSON.stringify(answer)).toBe(door === "restore" ? 202 : 200);
      await vi.waitFor(() => expect(h.restoresCompleted()).toBe(1));
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
      expect(h.tmux.killSession).not.toHaveBeenCalled();
      expect(h.sessionRegistry.getSessionsForRig(h.rig.id).filter(s => s.status === "running")).toHaveLength(1);
      if (door !== "restore") expect(answer.nodes).toEqual([expect.objectContaining({ logicalId: "operator.agent", status: fresh ? "fresh-primed" : "resumed" })]);
      expect(JSON.stringify(answer)).not.toContain("no second restore");
    } finally { h.close(); }
  });
});
