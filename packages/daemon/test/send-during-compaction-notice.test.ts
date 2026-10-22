// A plain `rig send` (POST /api/transport/send) to a Claude seat that OpenRig's managed compaction is compacting or
// restoring is delivered as always, and the sender's result names the compaction or restore OpenRig had recorded. The
// notice is context: a failed or uncertain send keeps its own result.
//
// Pieces: the real ClaudeCompactionEnforcer, SessionTransport, SeatDeliveryGuard and transport route, over a recording
// tmux adapter (no tmux server, no Claude Code). Native: NOT RUN.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { transportRoutes } from "../src/routes/transport.js";

const seat = "writer@demo";
const high = { sessionName: seat, runtime: "claude-code", usedPercentage: 90 };
const low = { ...high, usedPercentage: 10 };
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function fixture(opts: { observe?: boolean; pasteFails?: boolean; enterFails?: boolean; onWrite?: (text: string) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "send-notice-")); homes.push(home);
  let clock = 10_000, activity = "idle", sending = false;
  const generation = "generation-one";
  const db = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }), transaction: (fn: () => void) => fn } as never;
  const writes: string[] = [];
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a restore map.", compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "" };
  const tmux = {
    probeSession: vi.fn(async () => ({ state: "present" })),
    // The work message's paste or Enter can be made to fail, to check that a failed send keeps its result.
    sendText: vi.fn(async (_: string, text: string) => { writes.push(text); opts.onWrite?.(text); return { ok: !(sending && opts.pasteFails) }; }),
    sendKeys: vi.fn(async () => { writes.push("ENTER"); return { ok: !(sending && opts.enterFails) }; }),
  };
  Object.assign(tmux, { deliveryGuard: new SeatDeliveryGuard(db, () => ({ nodeId: "node-one", session: seat, pane: "%1", occupant: generation })) });
  const transport = new SessionTransport({ db, rigRepo: {} as never, sessionRegistry: {} as never, tmuxAdapter: tmux as never,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), now: () => new Date(clock), waitForIdlePollMs: 5 });
  const internals = transport as unknown as Record<string, unknown>;
  internals.getSessionMeta = () => ({ runtime: "claude-code", attachmentType: "tmux", nodeId: "node-one", pane: "%1", occupant: generation, resumeToken: "native-one" });
  internals.claudeDeliveryObservation = async () => ({ state: "unknown", detail: "injected process observation" });
  internals.classifySendReadiness = async () => ({ state: activity, reason: "fixture", evidenceSource: "fixture" });
  internals.diagnoseProducerLink = async () => "fixture";
  internals.resolveSessions = async () => ({ ok: true, sessions: [seat] });
  const e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as never, transport, {
    openrigHome: home, manualPrepWaitMs: 1000, compactSendIdleWaitMs: 20, postCompactSendWaitMs: 20,
    now: () => clock, sleep: async (ms) => { clock += ms; }, resolveOccupantGeneration: () => generation });
  // As startup wires it. (At a daemon without the notice, neither method exists and nothing is added.)
  if (opts.observe !== false) {
    const observer = (e as unknown as { observedCompaction?: (s: string) => unknown }).observedCompaction;
    (transport as unknown as { setCompactionObserver?: (fn: (s: string) => unknown) => void })
      .setCompactionObserver?.((s) => observer?.call(e, s) ?? null);
  }
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
  app.route("/api/transport", transportRoutes());
  const rigSend = async (text: string) => {
    sending = true;
    try {
      const res = await app.request("/api/transport/send", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "pm@demo" },
        body: JSON.stringify({ session: seat, text }) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    } finally { sending = false; }
  };
  const stageMap = () => {
    const a = e.getPreparationState(seat)!; mkdirSync(dirname(a.mapPath), { recursive: true });
    writeFileSync(a.mapPath + ".tmp", `# Restore map\n${a.marker}\n`);
  };
  return { e, transport, rigSend, stageMap, writes, activity: (s: string) => { activity = s; } };
}

async function compactSent(f: ReturnType<typeof fixture>) {
  await f.e.maybeAutoCompact(high); // preparation prompt
  f.stageMap();
  expect(await f.e.maybeAutoCompact(high)).toEqual({ triggered: true }); // /compact
}
async function restoring(f: ReturnType<typeof fixture>) {
  await compactSent(f);
  expect(await f.e.maybeAutoCompact(low)).toEqual({ triggered: true }); // turn boundary
  expect(await f.e.maybeAutoCompact(low)).toEqual({ triggered: true }); // restore request
  f.activity("running");
}
const withoutNotice = (body: Record<string, unknown>) => { const { managedCompaction: _m, ...rest } = body; return rest; };

it("a send during the restore turn is delivered, and the result names the restore it was sent into", async () => {
  const f = fixture();
  await restoring(f);
  const sender = await f.rigSend("WORK MESSAGE");
  expect(sender.status).toBe(200);
  expect(sender.body).toMatchObject({ ok: true, managedCompaction: { stage: "restoring", observed: "before_send" } });
  const notice = (sender.body.managedCompaction as { notice: string }).notice;
  expect(notice).toBe(`${seat} was mid-restore: the restore request was sent and the post-restore audit is still owed (when this send started, as OpenRig's managed compaction recorded it). This doesn't mean the restore has finished; if this message matters, check the reply and follow up.`);
  expect(f.writes).toContain("WORK MESSAGE"); // delivered now: no hold, no replay
});

it("a send while /compact is in flight is delivered, and the result says the seat was being compacted", async () => {
  const f = fixture();
  await compactSent(f);
  f.activity("running");
  const sender = await f.rigSend("WORK MESSAGE");
  expect(sender.status).toBe(200);
  expect(sender.body).toMatchObject({ ok: true, managedCompaction: { stage: "compacting" } });
  expect(f.writes).toContain("WORK MESSAGE");
});

it("control: an ordinary send with no managed compaction recorded has no notice and today's result", async () => {
  const f = fixture();
  const sender = await f.rigSend("WORK MESSAGE");
  const plain = await fixture({ observe: false }).rigSend("WORK MESSAGE");
  expect(sender.status).toBe(200);
  expect(sender.body).not.toHaveProperty("managedCompaction");
  expect(sender.body).toEqual(plain.body);
});

it("control: a failed or uncertain send during a restore keeps its own result; the notice is only context", async () => {
  for (const failure of [{ pasteFails: true }, { enterFails: true }]) {
    const noticed = fixture(failure); await restoring(noticed);
    const silent = fixture({ ...failure, observe: false }); await restoring(silent);
    const withNotice = await noticed.rigSend("WORK MESSAGE");
    const without = await silent.rigSend("WORK MESSAGE");
    expect(without.body.ok).toBe(false);
    expect(withNotice.status).toBe(without.status);
    expect(withoutNotice(withNotice.body)).toEqual(without.body);
    expect(withNotice.body).toMatchObject({ ok: false, managedCompaction: { stage: "restoring" } });
  }
});

it("the seat's preparation for a managed compaction is named, from the preparation prompt until /compact is sent", async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(high); // preparation prompt sent; /compact not yet
  f.activity("running");
  const sender = await f.rigSend("WORK MESSAGE");
  expect(sender.status).toBe(200);
  expect(sender.body).toMatchObject({ ok: true, managedCompaction: { stage: "preparing", observed: "before_send" } });
  expect((sender.body.managedCompaction as { notice: string }).notice).toBe(`${seat} was preparing for a managed compaction: /compact hasn't been sent yet (when this send started, as OpenRig's managed compaction recorded it). This doesn't mean the restore has finished; if this message matters, check the reply and follow up.`);
  expect(f.writes).toContain("WORK MESSAGE");
});

it("a seat that has compacted but whose restore isn't requested yet is named as compacted", async () => {
  const f = fixture();
  await compactSent(f);
  expect(await f.e.maybeAutoCompact(low)).toEqual({ triggered: true }); // turn boundary; the restore request is next
  f.activity("running");
  const sender = await f.rigSend("WORK MESSAGE");
  expect(sender.status).toBe(200);
  expect(sender.body).toMatchObject({ ok: true, managedCompaction: { stage: "compacted", observed: "before_send" } });
  expect((sender.body.managedCompaction as { notice: string }).notice).toBe(`${seat} was compacted, with its restore not yet requested (when this send started, as OpenRig's managed compaction recorded it). This doesn't mean the restore has finished; if this message matters, check the reply and follow up.`);
  expect(f.writes).toContain("WORK MESSAGE");
});

it("nothing recorded when the send starts but a compaction recorded by the time it finishes: the notice says after_send", async () => {
  // The observer is the real enforcer's view, except that until the work message is written it reports nothing: the
  // compaction state the seat is in becomes visible only after the write, as when it's recorded during the send.
  let written = false;
  const f = fixture({ observe: false, onWrite: (text) => { if (text === "WORK MESSAGE") written = true; } });
  await compactSent(f);
  f.activity("running");
  f.transport.setCompactionObserver((s) => (written ? f.e.observedCompaction(s) : null));
  const sender = await f.rigSend("WORK MESSAGE");
  expect(sender.status).toBe(200);
  expect(sender.body).toMatchObject({ ok: true, managedCompaction: { stage: "compacting", observed: "after_send" } });
  expect((sender.body.managedCompaction as { notice: string }).notice).toBe(`${seat} was being compacted: /compact was submitted and the post-compaction steps haven't started (when this send finished, as OpenRig's managed compaction recorded it). This doesn't mean the restore has finished; if this message matters, check the reply and follow up.`);
  expect(f.writes).toContain("WORK MESSAGE");
});
