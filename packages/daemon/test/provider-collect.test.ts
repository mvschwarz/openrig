// Slice-04 (OPR.0.5.0.4) C1 resume — the getReadModel COLLECTION seam pins.
import { describe, it, expect } from "vitest";
import { collectFourBlockReadModel, type ProviderCollectDeps } from "../src/domain/provider/provider-collect.js";
import type { CodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function deps(over: Partial<ProviderCollectDeps> & { auth?: CodexAuthMetadata }): ProviderCollectDeps {
  return {
    readCodexAuth: () => over.auth ?? { profiles: [], seats: [] },
    listSeats: over.listSeats ?? (() => []),
    collectSignals: over.collectSignals,
    now: over.now ?? (() => ASOF),
  };
}

describe("collectFourBlockReadModel — getReadModel collection seam", () => {
  it("maps each codex profile to an account with authState=unknown (BR-3 validate-at-use)", () => {
    const model = collectFourBlockReadModel(deps({ auth: { profiles: ["work", "personal"], seats: [] } }));
    expect(model.accounts).toEqual([
      { accountId: "work", label: "work", provider: "codex", authState: "unknown", profileRef: "work", asOf: ASOF },
      { accountId: "personal", label: "personal", provider: "codex", authState: "unknown", profileRef: "personal", asOf: ASOF },
    ]);
  });

  it("binds a registered codex seat to its profile with boundAt/source from the registry", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [{ seat: "dev-driver@rig-a", rig: "rig-a", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "2026-08-03T10:00:00Z" }] },
      listSeats: () => [{ seatSession: "dev-driver@rig-a", rigName: "rig-a", runtime: "codex", lifecycleState: "running" }],
    }));
    expect(model.bindings).toEqual([
      { accountId: "work", seatSession: "dev-driver@rig-a", rigName: "rig-a", boundAt: "2026-08-03T10:00:00Z", bindingSource: "codex_auth_seat_registry", anomalies: [] },
    ]);
  });

  it("a claude (or unregistered) seat is unbound and carries seat_with_no_account", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [] },
      listSeats: () => [{ seatSession: "pm@rig-a", rigName: "rig-a", runtime: "claude-code", lifecycleState: "running" }],
    }));
    expect(model.bindings).toHaveLength(1);
    const b = model.bindings[0]!;
    expect(b.accountId).toBeNull();
    expect(b.anomalies[0]).toMatchObject({ kind: "seat_with_no_account", seat: "pm@rig-a" });
  });

  it("same profile bound on 2 distinct seats yields a same_account_on_n_seats anomaly", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [
        { seat: "a@rig", rig: "rig", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" },
        { seat: "b@rig", rig: "rig", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t2" },
      ] },
      listSeats: () => [
        { seatSession: "a@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" },
        { seatSession: "b@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" },
      ],
    }));
    for (const b of model.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats" && a.count === 2)).toBe(true);
    }
  });

  it("empty codex home → empty accounts, every seat unbound; signals default to []", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: [], seats: [] },
      listSeats: () => [{ seatSession: "s@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" }],
    }));
    expect(model.accounts).toEqual([]);
    expect(model.bindings[0]!.accountId).toBeNull();
    expect(model.signals).toEqual([]);
    expect(model.asOf).toBe(ASOF);
  });

  it("carries collected signals through unchanged when a collector is provided", () => {
    const sig = { provider: "codex" as const, accountRef: "work", sourceClass: "unknown" as const, authority: "unknown" as const, asOf: ASOF, unknownReason: "no reading", automationUse: "do_not_automate" as const };
    const model = collectFourBlockReadModel(deps({ auth: { profiles: ["work"], seats: [] }, collectSignals: () => [sig] }));
    expect(model.signals).toEqual([sig]);
  });

  it("a claude seat is NOT bound by a stale same-session Codex registry row (runtime-identity gate)", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [{ seat: "shared@rig", rig: "rig", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" }] },
      // The LIVE inventory seat with this same session name is a CLAUDE seat — the codex row is stale.
      listSeats: () => [{ seatSession: "shared@rig", rigName: "rig", runtime: "claude-code", lifecycleState: "running" }],
    }));
    expect(model.bindings).toHaveLength(1);
    const b = model.bindings[0]!;
    expect(b.accountId).toBeNull(); // must NOT bind to the Codex account despite the stale same-session row
    expect(b.anomalies[0]).toMatchObject({ kind: "seat_with_no_account", seat: "shared@rig" });
  });

  it("drops stale seat-keyed Claude cache signals and emits the live Claude seat's honest unknown", () => {
    const model = collectFourBlockReadModel(deps({
      listSeats: () => [{ seatSession: "live@rig", rigName: "rig", runtime: "claude-code", lifecycleState: "running" }],
      collectSignals: () => [{
        provider: "claude", seatSession: "dead@rig", sourceClass: "provider_statusline",
        authority: "account_cross_device", window: "five_hour", usedPercent: 12, asOf: ASOF,
        automationUse: "allow_switch_decision",
      }],
    }));

    expect(model.signals.some((signal) => signal.seatSession === "dead@rig")).toBe(false);
    expect(model.signals).toEqual([expect.objectContaining({
      provider: "claude", seatSession: "live@rig", sourceClass: "unknown",
      authority: "unknown", automationUse: "do_not_automate",
    })]);
  });

  it("drops a Claude cache signal when the session name is live only as a non-Claude runtime", () => {
    const model = collectFourBlockReadModel(deps({
      listSeats: () => [{ seatSession: "reused@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" }],
      collectSignals: () => [{
        provider: "claude", seatSession: "reused@rig", sourceClass: "provider_statusline",
        authority: "account_cross_device", window: "five_hour", usedPercent: 12, asOf: ASOF,
        automationUse: "allow_switch_decision",
      }],
    }));

    expect(model.signals.filter((signal) => signal.provider === "claude")).toEqual([]);
  });
});
