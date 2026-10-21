import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "../../daemon/src/startup.js";
import { queueCommand, waitForDeliveryOutcome, type QueueDeps } from "../src/commands/queue.js";

// #165, the deliveryOutcome half: an agent's pane task is woken, claimed and closed through the
// daemon's routes and repository and the CLI's own commands. deliveryOutcome is the gateway
// (human-delivery) ledger, so it stays null here; the wake, the claim and the pickup answer instead.
// Only the pane send is simulated: the transport reports the wake as sent but its render unconfirmed,
// which is what a live wake to a seat whose screen can't be matched returns.
describe("an agent's pane task: woken, claimed and closed (#165)", () => {
  it("keeps deliveryOutcome null, reads claimed, keeps the stored wake result, and reports a terminal receipt", async () => {
    const source = "lead-impl@r165";
    const destination = "dev-impl@r165";
    const saved = { noKernel: process.env.OPENRIG_NO_KERNEL, session: process.env.OPENRIG_SESSION_NAME };
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.OPENRIG_SESSION_NAME = source;
    const daemon = await createDaemon({ cmuxFactory: async () => {
      throw Object.assign(new Error("no fixture socket"), { code: "ENOENT" });
    }, tmuxExec: async () => "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const rig = daemon.deps.rigRepo.createRig("r165");
      for (const [logicalId, session] of [["lead.impl", source], ["dev.impl", destination]] as const) {
        const node = daemon.deps.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
        const registered = daemon.deps.sessionRegistry.registerSession(node.id, session);
        daemon.deps.sessionRegistry.updateStatus(registered.id, "running");
        daemon.deps.sessionRegistry.updateBinding(node.id, { tmuxSession: session, attachmentType: "tmux" });
      }
      const sends: string[] = [];
      daemon.deps.queueRepo.attachTransport({
        send: async (sessionName: string) => {
          sends.push(sessionName);
          return { ok: true, verified: false };
        },
      });

      // The CLI reaches the daemon's routes in process, as the seat named by OPENRIG_SESSION_NAME.
      const request = async (url: string, init: RequestInit) => {
        const response = await daemon.app.request(url, { ...init, headers: {
          "Content-Type": "application/json", "X-OpenRig-Session": process.env.OPENRIG_SESSION_NAME!,
        } });
        return { status: response.status, data: await response.json() };
      };
      const client = {
        get: async (url: string) => request(url, { method: "GET" }),
        post: async (url: string, body: unknown) => request(url, { method: "POST", body: JSON.stringify(body) }),
      };
      const deps: QueueDeps = {
        lifecycleDeps: { readFile: () => null, exists: () => false,
          fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
        clientFactory: () => client as unknown as ReturnType<QueueDeps["clientFactory"]>,
        deliveryVerify: { timeoutMs: 5_000, intervalMs: 10 },
      };
      const rig_ = async (...args: string[]) => {
        log.mockClear();
        await queueCommand(deps).parseAsync(args, { from: "user" });
        return JSON.parse(log.mock.calls.map((call) => call.join(" ")).join("\n"));
      };

      // Woken: `rig queue create --verify` waits for the wake's result.
      const created = await rig_("create", "--destination", destination, "--body", "#165 fixture task",
        "--summary", "#165 fixture", "--verify", "--full", "--json");
      const qitemId = created.qitemId as string;
      expect(created.delivery).toMatchObject({
        receiptSource: "terminal", destinationKind: "agent", outcome: "delivered-ack-pending", wakeResult: "delivered-ack-pending",
        claim: { observed: false, claimedAt: null },
      });
      expect(created.delivery.detail).toContain(
        "Terminal receipt unconfirmed (delivered-ack-pending): the wake was sent, but its render could not be confirmed.");

      // Claimed and closed by the destination seat.
      process.env.OPENRIG_SESSION_NAME = destination;
      const claimed = await rig_("claim", qitemId, "--full", "--json");
      expect(claimed).toMatchObject({ state: "in-progress", lastNudgeResult: "claimed", lastNudgeWireResult: "delivered-ack-pending" });
      const closed = await rig_("update", qitemId, "--state", "done", "--closure-reason", "no-follow-on", "--full", "--json");
      expect(closed.state).toBe("done");

      // `rig queue show`, the repository's single read and its list all read the same row.
      const shown = await rig_("show", qitemId, "--full", "--json");
      const listed = daemon.deps.queueRepo.list({ destinationSession: destination }).find((row) => row.qitemId === qitemId);
      for (const row of [shown, daemon.deps.queueRepo.getById(qitemId), listed]) {
        expect(row).toMatchObject({
          state: "done",
          closureReason: "no-follow-on",
          deliveryOutcome: null,
          lastNudgeResult: "claimed",
          lastNudgeWireResult: "delivered-ack-pending",
          claimedAt: claimed.claimedAt,
          pickup: { state: "terminal" },
        });
      }
      const stored = daemon.db.prepare("SELECT last_nudge_result FROM queue_items WHERE qitem_id = ?").get(qitemId) as { last_nudge_result: string };
      expect(stored.last_nudge_result).toBe("delivered-ack-pending");
      // One wake to the destination; the claim and the close sent nothing to it and wrote no gateway receipt.
      expect(sends.filter((session) => session === destination)).toHaveLength(1);
      const notes = daemon.deps.queueRepo.transitionLog.listForQitem(qitemId).map((t) => t.transitionNote ?? "");
      expect(notes.some((note) => note.startsWith("slack-owner-notification-"))).toBe(false);

      // The CLI's receipt for the closed row: still a terminal receipt to an agent, settled by the claim.
      const receipt = await waitForDeliveryOutcome(client as never, qitemId, { timeoutMs: 0 }, { destinationSession: destination });
      expect(receipt).toMatchObject({
        receiptSource: "terminal", destinationKind: "agent", outcome: "claimed", wakeResult: "claimed",
        claim: { observed: true, claimedAt: claimed.claimedAt, pickup: "terminal" }, nextAction: null,
      });
      expect(receipt).not.toHaveProperty("gateway");
      expect(receipt).not.toHaveProperty("humanReadership");
      expect(receipt.detail).toContain("Terminal receipt unconfirmed, but the seat has claimed the item (claimed).");
      expect(receipt.detail).toContain("A claim shows the seat took the item; it does not prove the body was read.");
    } finally {
      log.mockRestore();
      daemon.eventLoopMonitor.stop(); daemon.contextMonitor.stop(); daemon.deps.seatActivityService?.stop();
      daemon.db.close();
      if (saved.noKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = saved.noKernel;
      if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved.session;
    }
  }, 30_000);
});
