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
      listSeats: () => [{ seatSession: "dev-driver@rig-a", rigName: "rig-a", runtime: "codex" }],
    }));
    expect(model.bindings).toEqual([
      { accountId: "work", seatSession: "dev-driver@rig-a", rigName: "rig-a", boundAt: "2026-08-03T10:00:00Z", bindingSource: "codex_auth_seat_registry", anomalies: [] },
    ]);
  });

  it("a claude (or unregistered) seat is unbound and carries seat_with_no_account", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [] },
      listSeats: () => [{ seatSession: "pm@rig-a", rigName: "rig-a", runtime: "claude-code" }],
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
        { seatSession: "a@rig", rigName: "rig", runtime: "codex" },
        { seatSession: "b@rig", rigName: "rig", runtime: "codex" },
      ],
    }));
    for (const b of model.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats" && a.count === 2)).toBe(true);
    }
  });

  it("empty codex home → empty accounts, every seat unbound; signals default to []", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: [], seats: [] },
      listSeats: () => [{ seatSession: "s@rig", rigName: "rig", runtime: "codex" }],
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
});
