import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { providerRoutes } from "../src/routes/provider.js";
import type { ClaudeSeatRelaunch, ProviderService } from "../src/domain/provider/provider-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { FourBlockReadModel } from "../src/domain/provider/provider-types.js";

// Slice-04 (OPR.0.5.0.4) seam B — the daemon provider routes (packet 3ffa3c22 §3). Thin handlers
// over ONE service read model: filtered projections cannot diverge; edge validation -> 400; unsafe
// precheck stays a 200 verdict; switch outcomes are 200 payloads; unwired service -> loud 503.

const MODEL: FourBlockReadModel = {
  accounts: [
    { accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "p-a", asOf: "2026-08-03T12:00:00.000Z" },
    { accountId: "cla-x", label: "Claude X", provider: "claude", authState: "active", profileRef: null, asOf: "2026-08-03T12:00:00.000Z" },
  ],
  bindings: [
    { accountId: "cdx-a", seatSession: "seat-1", rigName: "r1", boundAt: "2026-08-03T12:00:00.000Z", bindingSource: "adopt", anomalies: [] },
  ],
  signals: [
    { provider: "codex", accountRef: "cdx-a", sourceClass: "provider_structured_read", authority: "account_cross_device", window: "primary", usedPercent: 40, asOf: "2026-08-03T12:00:00.000Z", staleAfter: "2026-08-03T12:05:00.000Z", supportsNotification: true, automationUse: "allow_switch_decision" },
    { provider: "claude", accountRef: "cla-x", sourceClass: "provider_statusline", authority: "account_cross_device", window: "five_hour", usedPercent: 10, asOf: "2026-08-03T12:00:00.000Z", staleAfter: "2026-08-03T12:05:00.000Z", supportsNotification: false, automationUse: "allow_switch_decision" },
  ],
  asOf: "2026-08-03T12:00:00.000Z",
};

const stubService: ProviderService = {
  getReadModel: async () => MODEL,
  precheck: async ({ toAccount }) => (toAccount === "cdx-a" ? { safe: true } : { safe: false, reasons: ["target_needs_reauth"] }),
  switchAccount: async ({ toAccount }) =>
    toAccount === "cla-x"
      ? { outcome: "failed_safely", reasons: ["rebind_unsupported_for_runtime"] as [string, ...string[]] }
      : { outcome: "succeeded" },
};

function appWith(svc: ProviderService | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (svc) c.set("providerService" as never, svc);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  return app;
}

describe("provider routes", () => {
  it("forwards API-key file references on both endpoints and refuses conflicting selectors", async () => {
    const precheck = vi.fn<ProviderService["precheck"]>(async () => ({ safe: true as const }));
    const switchAccount = vi.fn<ProviderService["switchAccount"]>(async () => ({ outcome: "succeeded" as const }));
    const app = appWith({ ...stubService, precheck, switchAccount });
    await app.request("/api/provider/precheck?seat=dev-a@rig&toAccount=api&apiKeyFile=%2Fsynthetic%2Fkey");
    expect(precheck.mock.calls[0]?.[0]).toMatchObject({ apiKeyFile: "/synthetic/key" });
    const request = (body: object) => app.request("/api/provider/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await request({ seat: "dev-a@rig", toAccount: "api", apiKeyFile: "/synthetic/key" })).status).toBe(200);
    expect(switchAccount.mock.calls[0]?.[0]).toMatchObject({ apiKeyFile: "/synthetic/key" });
    expect((await request({ seat: "dev-a@rig", toAccount: "api", apiKeyFile: "/synthetic/key", tokenFile: null })).status).toBe(400);
    expect(switchAccount).toHaveBeenCalledTimes(1);
  });

  it("move reports are queue items now, not the removed event-log record: no setting gates them, and there's no /moves/:id", async () => {
    const app = appWith(stubService);
    // This app wires no queue, so the report routes say so rather than answering a disabled-feature 409.
    expect((await app.request("/api/provider/moves")).status).toBe(503);
    expect((await app.request("/api/provider/moves", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await app.request("/api/provider/moves/m-1")).status).toBe(404);
  });

  it("GET /status returns the whole four-block model", async () => {
    const res = await appWith(stubService).request("/api/provider/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MODEL);
  });

  it("accounts/bindings/signals are FILTERED projections of the one model (cannot diverge)", async () => {
    const app = appWith(stubService);
    const acc = await (await app.request("/api/provider/accounts?provider=codex")).json();
    expect(acc.accounts.map((a: { accountId: string }) => a.accountId)).toEqual(["cdx-a"]);
    const sig = await (await app.request("/api/provider/signals?provider=claude")).json();
    expect(sig.signals.map((s: { accountRef: string }) => s.accountRef)).toEqual(["cla-x"]);
    const bnd = await (await app.request("/api/provider/bindings?account=cdx-a")).json();
    expect(bnd.bindings).toHaveLength(1);
    expect(bnd.bindings[0].seatSession).toBe("seat-1");
  });

  it("rejects a malformed provider enum at the edge (400)", async () => {
    const res = await appWith(stubService).request("/api/provider/accounts?provider=bad");
    expect(res.status).toBe(400);
  });

  it("rejects an empty/whitespace account filter at the edge (400)", async () => {
    const res = await appWith(stubService).request("/api/provider/accounts?account=");
    expect(res.status).toBe(400);
  });

  it("a JSON null switch body is malformed (400), never an accidental 500", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("precheck returns a 200 VERDICT even when unsafe (safe:false is not an error)", async () => {
    const res = await appWith(stubService).request("/api/provider/precheck?seat=s1&toAccount=cla-x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.safe).toBe(false);
    expect(body.reasons).toContain("target_needs_reauth");
  });

  it("precheck requires seat and toAccount (400 when missing)", async () => {
    const res = await appWith(stubService).request("/api/provider/precheck?seat=s1");
    expect(res.status).toBe(400);
  });

  it("precheck and switch lend the service the seat's in-place restart, so both act on the home the seat runs on", async () => {
    const lent: unknown[] = [];
    const app = appWith({
      ...stubService,
      precheck: async (_input, seatRestart) => { lent.push(seatRestart); return { safe: true }; },
      switchAccount: async (_input, seatRestart) => { lent.push(seatRestart); return { outcome: "rebind_in_progress" }; },
    });
    expect((await app.request("/api/provider/precheck?seat=s1&toAccount=work")).status).toBe(200);
    expect((await app.request("/api/provider/switch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seat: "s1", toAccount: "work" }),
    })).status).toBe(200);
    expect(lent).toHaveLength(2);
    for (const seatRestart of lent) expect(seatRestart).toMatchObject({ plan: expect.any(Function), run: expect.any(Function) });
  });

  it("precheck and switch also lend a Claude seat's relaunch, and pass its token file or the stored login through", async () => {
    const seen: Array<{ input: unknown; claudeSeat: unknown }> = [];
    const app = appWith({
      ...stubService,
      precheck: async (input, _seatRestart, claudeSeat) => { seen.push({ input, claudeSeat }); return { safe: true }; },
      switchAccount: async (input, _seatRestart, claudeSeat) => { seen.push({ input, claudeSeat }); return { outcome: "rebind_in_progress" }; },
    });
    expect((await app.request("/api/provider/precheck?seat=s1&toAccount=work&tokenFile=%2Ftokens%2Fwork")).status).toBe(200);
    expect((await app.request("/api/provider/precheck?seat=s1&toAccount=stored-login&storedLogin=1")).status).toBe(200);
    expect((await app.request("/api/provider/switch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seat: "s1", toAccount: "work", tokenFile: "/tokens/work" }),
    })).status).toBe(200);
    expect(seen.map((s) => s.input)).toEqual([
      { seat: "s1", toAccount: "work", tokenFile: "/tokens/work" },
      { seat: "s1", toAccount: "stored-login", tokenFile: null },
      { seat: "s1", toAccount: "work", forceUnsafe: false, tokenFile: "/tokens/work" },
    ]);
    for (const { claudeSeat } of seen) {
      expect(claudeSeat).toMatchObject({ seat: expect.any(Function), snapshot: expect.any(Function), exclusive: expect.any(Function), relaunchInPane: expect.any(Function) });
      expect(claudeSeat).not.toHaveProperty("stop");
    }
    const bad = await app.request("/api/provider/switch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seat: "s1", toAccount: "work", tokenFile: 7 }),
    });
    expect(bad.status).toBe(400);
  });

  it("a Claude seat's relaunch keeps its pane: restore launches only that seat from the snapshot in it, under the seat's lease, and its warnings come back", async () => {
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db), registry = new SessionRegistry(db);
      const rig = repo.createRig("fixture-rig");
      const node = repo.addNode(rig.id, "dev.a", { runtime: "claude-code" });
      const session = registry.registerSession(node.id, "dev-a@fixture-rig");
      registry.updateStatus(session.id, "running");
      registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-a@fixture-rig", tmuxPane: "%101" });
      let launched: { ok: boolean; launched?: Array<{ logicalId: string; status: string; error?: string }>; warnings?: string[]; code?: string; message?: string }
        = { ok: true, launched: [{ logicalId: "dev.a", status: "resumed" }], warnings: ["dev-a@fixture-rig: a launch warning"] };
      const launchSingleNode = vi.fn(async () => launched);
      const leased: string[][] = [];
      const tmux = { killSession: vi.fn(), deliveryGuard: { lifecycle: async (ids: string[], fn: () => Promise<unknown>) => { leased.push(ids); return fn(); } } };
      let lent!: ClaudeSeatRelaunch;
      const app = new Hono();
      app.use("*", async (c, next) => {
        for (const [key, value] of Object.entries({ rigRepo: repo, tmuxAdapter: tmux, restoreOrchestrator: { launchSingleNode }, runtimeAdapters: {},
          providerService: { ...stubService, precheck: async (_i: unknown, _r: unknown, claudeSeat: ClaudeSeatRelaunch) => { lent = claudeSeat; return { safe: true }; } } })) {
          c.set(key as never, value as never);
        }
        await next();
      });
      app.route("/api/provider", providerRoutes());
      await app.request("/api/provider/precheck?seat=dev-a@fixture-rig&toAccount=work&tokenFile=%2Ftokens%2Fwork");
      expect(lent.seat("dev-a@fixture-rig")).toMatchObject({ nodeId: node.id, logicalId: "dev.a", running: true, pane: "%101" });
      // Restores can mix ISO and SQLite timestamp spellings; ULIDs retain creation order.
      registry.updateStatus(session.id, "superseded");
      const current = registry.registerSession(node.id, "dev-a@fixture-rig");
      registry.updateStatus(current.id, "running");
      db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run("2026-10-28T00:00:01Z", session.id);
      db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run("2026-10-28 00:00:02", current.id);
      expect(lent.seat("dev-a@fixture-rig")).toMatchObject({ running: true });
      expect(await lent.exclusive(node.id, async () => "held")).toBe("held");
      expect(leased).toEqual([[node.id]]);
      expect(await lent.relaunchInPane(rig.id, "dev.a", "snap-1")).toEqual({ ok: true, status: "resumed", warnings: ["dev-a@fixture-rig: a launch warning"] });
      expect(launchSingleNode).toHaveBeenCalledWith(rig.id, "dev.a", expect.objectContaining({ snapshotId: "snap-1", keepPane: true }));
      expect(tmux.killSession).not.toHaveBeenCalled();
      // Restore's stops before it touches the seat leave it unchanged; anything else after the launch began is unknown.
      launched = { ok: true, launched: [{ logicalId: "dev.a", status: "awaiting-decision", error: "decide first" }] };
      expect(await lent.relaunchInPane(rig.id, "dev.a", "snap-1")).toMatchObject({ ok: false, effect: "none", code: "awaiting-decision" });
      launched = { ok: true, launched: [{ logicalId: "dev.a", status: "awaiting-decision", launchStarted: true, error: "resume failed after cutover" }] };
      expect(await lent.relaunchInPane(rig.id, "dev.a", "snap-1")).toMatchObject({ ok: false, effect: "unknown", code: "awaiting-decision" });
      launched = { ok: true, launched: [{ logicalId: "dev.a", status: "failed", error: "the pane couldn't be respawned" }] };
      expect(await lent.relaunchInPane(rig.id, "dev.a", "snap-1")).toMatchObject({ ok: false, effect: "unknown", code: "failed" });
      launched = { ok: false, code: "snapshot_not_found", message: "no such snapshot" };
      expect(await lent.relaunchInPane(rig.id, "dev.a", "snap-1")).toMatchObject({ ok: false, effect: "none", code: "snapshot_not_found" });
    } finally { db.close(); }
  });

  it("switch business outcomes are 200 payloads, not transport errors (failed_safely = 200)", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "s1", toAccount: "cla-x", forceUnsafe: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("failed_safely");
    // BR-1: a failed_safely outcome MUST carry fail-visible reasons (type-enforced + asserted).
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("rejects whitespace-only seat/toAccount at the edge (precheck query AND switch body) -> 400", async () => {
    const app = appWith(stubService);
    const pre = await app.request("/api/provider/precheck?seat=%20%20&toAccount=cdx-a");
    expect(pre.status).toBe(400);
    const sw = await app.request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "  ", toAccount: "cdx-a", forceUnsafe: false }),
    });
    expect(sw.status).toBe(400);
  });

  it("switch validates seat/toAccount/forceUnsafe at the edge (400 on malformed)", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "s1", forceUnsafe: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("an UNWIRED service returns a loud 503 provider_service_unavailable (never a fabricated stub)", async () => {
    const res = await appWith(null).request("/api/provider/status");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("provider_service_unavailable");
  });
});
