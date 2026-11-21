// Slice-04 (OPR.0.5.0.4) C1 resume — the getReadModel COLLECTION seam pins.
import { describe, it, expect } from "vitest";
import { collectFourBlockReadModel, type ProviderCollectDeps } from "../src/domain/provider/provider-collect.js";
import type { CodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";

const ASOF = "2026-08-04T00:00:00.000Z";
const LAUNCHED_UNKNOWN = { state: "unknown", reason: "OpenRig doesn't record which credential a seat's launch applied" };
const VERIFIED_UNKNOWN = { state: "unknown", reason: expect.stringContaining("no provider-observed identity is tied to this seat's launch") };

function deps(over: Partial<ProviderCollectDeps> & { auth?: CodexAuthMetadata }): ProviderCollectDeps {
  return {
    readCodexAuth: () => over.auth ?? { profiles: [], seats: [] },
    listSeats: over.listSeats ?? (() => []),
    collectSignals: over.collectSignals,
    configuredAccounts: over.configuredAccounts,
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
      { accountId: "work", seatSession: "dev-driver@rig-a", rigName: "rig-a", boundAt: "2026-08-03T10:00:00Z", bindingSource: "codex_auth_seat_registry", anomalies: [],
        runtime: "codex", launched: LAUNCHED_UNKNOWN, verified: VERIFIED_UNKNOWN },
    ]);
  });

  it("a claude (or unregistered) seat has no registry placement and no anomaly, beside what it's configured to use", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [] },
      listSeats: () => [{ seatSession: "pm@rig-a", rigName: "rig-a", runtime: "claude-code", lifecycleState: "running", claudeToken: { label: "team-a" } }],
      configuredAccounts: (seats) => seats.map((s) => ({ source: "claude_token", label: s.claudeToken!.label, note: "n" })),
    }));
    expect(model.bindings).toHaveLength(1);
    const b = model.bindings[0]!;
    expect(b.accountId).toBeNull();
    expect(b.anomalies).toEqual([]);
    expect(b).toMatchObject({ runtime: "claude-code", configured: { source: "claude_token", label: "team-a" }, launched: LAUNCHED_UNKNOWN, verified: VERIFIED_UNKNOWN });
  });

  it("configured is one per seat in order; launched and verified stay unknown whatever is configured", () => {
    const seen: string[][] = [];
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [{ seat: "cx@r", rig: "r", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" }] },
      listSeats: () => [
        { seatSession: "cx@r", rigName: "r", runtime: "codex", lifecycleState: "running" },
        { seatSession: "cl@r", rigName: "r", runtime: "claude-code", lifecycleState: "running" },
      ],
      configuredAccounts: (seats) => {
        seen.push(seats.map((s) => s.seatSession));
        return [
          { source: "registry", profileRef: "work", recordedAt: "t1", profileSaved: true },
          { source: "default_login", home: "/h/.claude", homeNote: "n" },
        ];
      },
    }));
    expect(seen).toEqual([["cx@r", "cl@r"]]);
    expect(model.bindings.map((b) => [b.seatSession, b.runtime, b.configured?.source])).toEqual([["cx@r", "codex", "registry"], ["cl@r", "claude-code", "default_login"]]);
    for (const b of model.bindings) expect([b.launched, b.verified]).toEqual([LAUNCHED_UNKNOWN, VERIFIED_UNKNOWN]);
    // Without the configured source, the row says nothing about configuration rather than inventing one.
    const bare = collectFourBlockReadModel(deps({ listSeats: () => [{ seatSession: "cl@r", rigName: "r", runtime: "claude-code", lifecycleState: "running" }] }));
    expect(bare.bindings[0]).not.toHaveProperty("configured");
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
    expect(b.anomalies).toEqual([]);
  });

  it("a null placement never produces seat_with_no_account: Claude, unregistered Codex, own-home Codex, unknown runtime", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [
        { seat: "own@r", rig: "r", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" },
        { seat: "a@r", rig: "r", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" },
        { seat: "b@r", rig: "r", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t2" },
      ] },
      listSeats: () => [
        { seatSession: "cl@r", rigName: "r", runtime: "claude-code", lifecycleState: "running" },
        { seatSession: "cx@r", rigName: "r", runtime: "codex", lifecycleState: "running" },
        { seatSession: "own@r", rigName: "r", runtime: "codex", lifecycleState: "running", runtimeHome: { home: "/homes/own", source: "member" } },
        { seatSession: "t@r", rigName: "r", runtime: "terminal", lifecycleState: "running" },
        { seatSession: "a@r", rigName: "r", runtime: "codex", lifecycleState: "running" },
        { seatSession: "b@r", rigName: "r", runtime: "codex", lifecycleState: "running" },
      ],
    }));
    const bySeat = new Map(model.bindings.map((b) => [b.seatSession, b]));
    for (const seat of ["cl@r", "cx@r", "own@r", "t@r"]) {
      expect(bySeat.get(seat)).toMatchObject({ accountId: null, boundAt: null, bindingSource: null, anomalies: [] });
    }
    // The registry joins are unchanged: two seats on one profile still share it, and nothing else does.
    for (const seat of ["a@r", "b@r"]) {
      expect(bySeat.get(seat)!.accountId).toBe("work");
      expect(bySeat.get(seat)!.anomalies).toEqual([expect.objectContaining({ kind: "same_account_on_n_seats", count: 2, seats: ["a@r", "b@r"] })]);
    }
    expect(model.bindings.flatMap((b) => b.anomalies).map((a) => a.kind)).not.toContain("seat_with_no_account");
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
