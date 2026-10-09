// #1078 round 3 — requests that meet daemon start's automatic restore of a kernel a reboot left down:
// a stop made during it wins, an equivalent `rig up kernel --existing` made just after it finished gets
// its outcome, the Explorer's restore route shares that handling, and a join counts only the sessions
// the automatic attempt itself launched. Derived from the maintainer's round-3 cases on a test build.

import { describe, it, expect, vi } from "vitest";
import { classifyManagedKernel } from "../src/domain/kernel-boot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { heldRestore, name, token } from "./helpers/held-kernel-restore.js";

type Held = Awaited<ReturnType<typeof heldRestore>>;

/** Each seat's newest session: what is left running of the rig. */
function newest(h: Held) {
  return h.db.prepare(`SELECT id, status, resume_token AS token FROM sessions WHERE node_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(h.node.id) as { id: string; status: string; token: string | null };
}

async function settledWhileHeld(h: Held, request: Promise<Response>) {
  let settled = false;
  const answer = request.then((response) => { settled = true; return response; });
  await new Promise<void>(r => setTimeout(r, 20));
  const before = settled;
  await h.finish();
  const response = await answer;
  return { settledWhileHeld: before, status: response.status, body: await response.json() };
}

describe("rig down during the automatic kernel restore", () => {
  it.each([
    ["a successful", false],
    ["a failed", true],
  ] as const)("the stop wins over %s restore and holds at the next boot", async (_label, launchFails) => {
    const h = await heldRestore({ at: "create", launchFails });
    try {
      const down = await settledWhileHeld(h, h.post("/api/down", { rigId: h.rig.id }));
      // Pending until the restore settles, so it is never reported done early.
      expect(down.settledWhileHeld, JSON.stringify(down.body)).toBe(false);
      expect(down.status, JSON.stringify(down.body)).toBe(200);
      expect(JSON.stringify(down.body)).not.toMatch(/guard_target_changed/);
      expect(h.live.has(name)).toBe(false);
      expect(newest(h).status).toBe("exited");
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'").get()).toEqual({ n: 0 });
      expect(classifyManagedKernel(new RigRepository(h.db), new SessionRegistry(h.db)).kind).toBe("stopped");
      const again = await h.bootAgain();
      expect(again.restoreLostKernel).not.toHaveBeenCalled();
      expect(again.kernelState).toBe("skipped");
    } finally { h.close(); }
  });
});

describe("rig up kernel --existing just after the automatic restore finished", () => {
  it("reports that restore's outcome: no second launch and no snapshot of its own", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      await h.finish();
      const before = h.snapshots();
      const response = await h.up();
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({ status: "restored", rigResult: "fully_restored" });
      expect(body.warnings[0]).toContain("no second restore was started");
      expect(JSON.stringify(body)).not.toMatch(/rig down|rig_not_stopped/);
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
      expect(h.snapshots()).toBe(before);
    } finally { h.close(); }
  });

  it("does not report a restore that failed: the request restores as on main", async () => {
    const h = await heldRestore({ at: "create", launchFails: true });
    try {
      await h.finish();
      const body = await (await h.up()).json();
      expect(JSON.stringify(body)).not.toContain("no second restore");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(2);
    } finally { h.close(); }
  });

  it("does not report a success whose seat has since gone", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      await h.finish();
      h.live.clear();
      const body = await (await h.up()).json();
      expect(JSON.stringify(body)).not.toContain("no second restore");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(2);
    } finally { h.close(); }
  });

  it("does not report a success once another occupant holds the seat", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      await h.finish();
      const other = h.sessionRegistry.registerSession(h.node.id, name);
      h.sessionRegistry.updateStatus(other.id, "running");
      const response = await h.up();
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("no second restore");
      expect(response.status).toBe(409);
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });
});

describe("the Explorer's POST /api/rigs/:id/up meets the automatic restore", () => {
  it("during it: waits and reports that restore's outcome", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      const joined = await settledWhileHeld(h, h.post(`/api/rigs/${h.rig.id}/up`, {}));
      expect(joined.settledWhileHeld).toBe(false);
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body).toMatchObject({ status: "restored", rigResult: "fully_restored", rigName: "kernel" });
      expect(joined.body.warnings[0]).toContain("no second restore was started");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("after it: reports that restore's outcome", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      await h.finish();
      const response = await h.post(`/api/rigs/${h.rig.id}/up`, {});
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({ status: "restored", rigResult: "fully_restored" });
      expect(body.warnings[0]).toContain("no second restore was started");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("a plan stays read-only and is not merged", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      const before = h.snapshots();
      const response = await h.post(`/api/rigs/${h.rig.id}/up`, { plan: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "plan", mutated: false });
      expect(h.snapshots()).toBe(before);
      await h.finish();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });
});

describe("a join counts only the automatic attempt's own sessions", () => {
  it("joins the attempt's own session before its token exists, and after its launch rotates the token", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      const own = newest(h);
      expect(own.token).toBeNull();
      // The launched Claude's first hook names the conversation it continued under.
      h.sessionRegistry.updateResumeToken(own.id, "claude_id", "00000000-0000-4000-8000-000000002078", "hook");
      const joined = await h.upWhileHeld();
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body.warnings[0]).toContain("no second restore was started");
    } finally { h.close(); }
  });

  it("does not join a newer tokenless session that the attempt did not launch", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      const other = h.sessionRegistry.registerSession(h.node.id, name);
      expect(newest(h).id).toBe(other.id);
      const answer = await h.upWhileHeld();
      expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(answer.body)).not.toContain("no second restore");
    } finally { h.close(); }
  });

  it("revalidates when the attempt returns: a session that replaced its own meanwhile is not reported", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      let settled = false;
      const manual = h.up().then((response) => { settled = true; return response; });
      await new Promise<void>(r => setTimeout(r, 20));
      expect(settled).toBe(false);
      // While the joined request waits, another occupant takes the seat.
      const other = h.sessionRegistry.registerSession(h.node.id, name);
      h.sessionRegistry.updateStatus(other.id, "running");
      await h.finish();
      const body = await (await manual).json();
      expect(JSON.stringify(body)).not.toContain("no second restore");
    } finally { h.close(); }
  });

  it("an operator correction of the attempt's own session to another token is not the same target", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      h.sessionRegistry.updateResumeToken(newest(h).id, "claude_id", "00000000-0000-4000-8000-000000003078", "operator");
      const answer = await h.upWhileHeld();
      expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
      expect(token).not.toBe("00000000-0000-4000-8000-000000003078");
    } finally { h.close(); }
  });

  // dev-review's boundary probes on ff17d37f; the replacement rows are synthetic registry insertions.
  it.each(["during", "after"] as const)("does not join a different session carrying the same token: %s", async (when) => {
    const h = await heldRestore({ at: "launch" });
    try {
      if (when === "after") await h.finish();
      const own = newest(h);
      const other = h.sessionRegistry.registerSession(h.node.id, name);
      h.sessionRegistry.updateStatus(other.id, "running");
      h.sessionRegistry.updateResumeToken(other.id, "claude_id", token, "operator");
      expect(other.id).not.toBe(own.id);
      const request = h.up();
      if (when === "during") await h.finish();
      const body = await (await request).json();
      expect(JSON.stringify(body)).not.toContain("no second restore");
    } finally { h.close(); }
  });

  it("revalidates a finished attempt after its terminal check: a stop made meanwhile wins", async () => {
    const h = await heldRestore({ at: "launch" });
    try {
      await h.finish();
      const own = newest(h);
      vi.mocked(h.tmux.hasSession).mockImplementationOnce(async () => {
        // The check saw the terminal; a real rig down completes before it returns.
        const down = await h.post("/api/down", { rigId: h.rig.id });
        expect(down.status).toBe(200);
        expect(await down.json()).toMatchObject({ sessionsKilled: 1, errors: [] });
        expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(own.id)).toEqual({ status: "exited" });
        return true;
      });
      const body = await (await h.up()).json();
      expect(JSON.stringify(body)).not.toContain("no second restore");
    } finally { h.close(); }
  });
});
