// OPR.0.7.1.21 I7: the claim hint is never typed into a waiting native prompt, at any interruption level. It goes
// through the delivery path, so the prompt guard refuses it at a positive prompt and the seat's level holds it.
// Only the terminal is faked: it records what was pasted and submitted.
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { ClaimService } from "../src/domain/claim-service.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { SendResult, SessionTransport } from "../src/domain/session-transport.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });

const seat = "worker@test";
const approval = "Would you like to run the following command?\n$ touch /tmp/harmless-marker\n› 1. Yes, proceed (y)\n  2. Yes, and don’t ask again (p)\n  3. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel";

function frame(body: string): ComposerSnapshot {
  return { screen: ["Ready", "────────────────────", `❯ ${body}`, "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(body), y: 2, width: 240, height: 60 }, inMode: false };
}

function fixture(opts: { prompt: boolean; runtime?: string }) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','${opts.runtime ?? (opts.prompt ? "codex" : "claude-code")}');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','${seat}','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','${seat}','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  cleanup.push(() => db.close());
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body = "", staged = "";
  const submitted: string[] = [], commands: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    commands.push(command);
    if (command.includes("paste-buffer")) body = staged;
    if (command.includes("send-keys") && command.includes("Enter")) { submitted.push(body); body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => opts.prompt ? { ...frame(""), screen: approval } : frame(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => opts.prompt ? approval : `${submitted.join("\n")}\n${frame(body).screen}`);
  const claim = new ClaimService({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    discoveryRepo: new DiscoveryRepository(db), eventBus: new EventBus(db), tmuxAdapter: tmux });
  return {
    db, claim, commands, submitted,
    level: (mode: string) => guard.set("a", { mode }, "person@test", "focus"),
    hint: () => (claim as unknown as { deliverClaimHint(s: string, m: { rigName: string; logicalId: string }): Promise<void> })
      .deliverClaimHint(seat, { rigName: "test", logicalId: "worker" }),
    held: () => new OutboxHandler(db).heldForNode("a", 50).items,
  };
}

describe("claim hint at a waiting native prompt (OPR.0.7.1.21 I7)", () => {
  // At off the prompt guard refuses it. At openrig-urgent draft protection holds the refused hint; urgent-only and hold
  // keep OpenRig notices out. A held hint stays readable.
  it.each([
    ["off", 0], ["openrig-urgent", 1], ["urgent-only", 1], ["hold", 1],
  ] as const)("is not typed or submitted at %s (held: %i)", async (mode, held) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture({ prompt: true });
    await f.level(mode);
    await f.hint();
    expect(f.submitted).toEqual([]);
    expect(f.commands.filter(c => c.includes("paste-buffer") || c.includes("send-keys"))).toEqual([]);
    expect(f.held()).toHaveLength(held);
  });

  it("a real claim at off adopts the session without typing the hint into its waiting prompt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture({ prompt: true });
    f.db.exec("DELETE FROM bindings WHERE node_id='a'");
    const discovered = new DiscoveryRepository(f.db).upsertDiscoveredSession({
      tmuxSession: "adopted@test", tmuxPane: "%2", runtimeHint: "codex", confidence: "high", cwd: "/tmp" });
    expect(await f.claim.bind({ discoveredId: discovered.id, rigId: "rig", logicalId: "worker" })).toMatchObject({ ok: true });
    expect(f.submitted).toEqual([]);
    expect(f.commands.filter(c => c.includes("paste-buffer") || c.includes("send-keys"))).toEqual([]);
  });

  it("a real claim into an unconfigured terminal member holds the hint instead of typing it into the shell", async () => {
    const f = fixture({ prompt: false, runtime: "terminal" });
    f.db.exec("DELETE FROM bindings WHERE node_id='a'");
    const discovered = new DiscoveryRepository(f.db).upsertDiscoveredSession({
      tmuxSession: "adopted@test", tmuxPane: "%2", runtimeHint: "terminal", confidence: "high", cwd: "/tmp" });
    expect(await f.claim.bind({ discoveredId: discovered.id, rigId: "rig", logicalId: "worker" })).toMatchObject({ ok: true });
    expect(f.submitted).toEqual([]);
    expect(f.held()).toHaveLength(1);
    expect(f.held()[0]).toMatchObject({ senderSession: "claim@system", body: expect.stringContaining("rig whoami --json") });
  });

  it("still types the hint once at an idle prompt at off", async () => {
    const f = fixture({ prompt: false });
    await f.level("off");
    await f.hint();
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]).toContain("rig whoami --json");
    expect(f.held()).toEqual([]);
  });
});

// The transport's send is stubbed to return each evidence state, so the warning is checked against exactly what the
// transport reported. Only a positive not_reached may be described as not typed.
describe("identity hint warning states only what the send established", () => {
  async function warningFor(result: Omit<SendResult, "sessionName">): Promise<string> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture({ prompt: false });
    await f.level("off");
    const transport = (f.claim as unknown as { sessionTransport: SessionTransport }).sessionTransport;
    vi.spyOn(transport, "send").mockResolvedValue({ sessionName: seat, ...result } as SendResult);
    await f.hint();
    expect(warn).toHaveBeenCalledTimes(1);
    return String(warn.mock.calls[0]?.[0]);
  }

  it("says not typed only when the transport positively established no write", async () => {
    const message = await warningFor({ ok: false, sent: false, inputPhase: "not_reached", reason: "target_runtime_conflict",
      error: "Refused: pane changed. No text was sent." });
    expect(message).toBe(`[claim] identity hint not typed into ${seat}: target_runtime_conflict. Refused: pane changed. No text was sent.`);
  });

  it("does not say not typed when a text write was attempted and may have landed", async () => {
    const message = await warningFor({ ok: false, sent: false, inputPhase: "attempted", reason: "delivery_indeterminate",
      error: "The delivery attempt ended without a reliable write result. Repeating the request may duplicate input." });
    expect(message).toContain("may have been typed into");
    expect(message).toContain("delivery_indeterminate");
    expect(message).toContain("without a reliable write result");
    expect(message).not.toContain("not typed");
  });

  it("reports written text with submission unconfirmed, keeping the transport's Enter detail", async () => {
    const message = await warningFor({ ok: false, sent: true, outcome: "failed", inputPhase: "written", reason: "submit_refused",
      error: `Text was written to '${seat}' but Enter was not sent: refused` });
    expect(message).toContain("written into");
    expect(message).toContain("submission is not confirmed");
    expect(message).toContain("Enter was not sent: refused");
    expect(message).not.toContain("not typed");
    expect(message).not.toContain("may have been typed");
  });

  it("says insufficient evidence neutrally when no input phase was reported", async () => {
    const message = await warningFor({ ok: false, sent: false, reason: "send_failed", error: "tmux failed" });
    expect(message).toContain("could not establish whether identity hint was typed");
    expect(message).toContain("send_failed. tmux failed");
    expect(message).not.toContain("not typed");
    expect(message).not.toContain("written");
  });
});
