import { describe, it, expect } from "vitest";
import { assembleFourBlock } from "../src/domain/provider/provider-read-model.js";
import type { ProviderAccount, ProviderSignal } from "../src/domain/provider/provider-types.js";

// Slice-04 (OPR.0.5.0.4) — the four-block ASSEMBLY (proof item 4, unit shape). A PURE assembler
// over already-collected accounts/rawBindings/signals: it emits real bound rows + explicit
// unbound rows (seat_with_no_account), computes same_account_on_n_seats ONLY from repeated real
// account IDs, preserves signals unchanged, and invents nothing.

const ASOF = "2026-08-03T12:00:00.000Z";

// A mixed-provider account set: 2 codex (managed, profileRef set) + 1 claude (unmanaged, null).
const ACCOUNTS: ProviderAccount[] = [
  { accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "prof-a", asOf: ASOF },
  { accountId: "cdx-b", label: "Codex B", provider: "codex", authState: "needs_reauth", profileRef: "prof-b", asOf: ASOF },
  { accountId: "cla-x", label: "Claude X", provider: "claude", authState: "active", profileRef: null, asOf: ASOF },
];

const SIGNALS: ProviderSignal[] = [
  {
    provider: "codex",
    accountRef: "cdx-a",
    sourceClass: "provider_structured_read",
    authority: "account_cross_device",
    window: "primary",
    usedPercent: 40,
    asOf: ASOF,
    staleAfter: "2026-08-03T12:05:00.000Z",
    supportsNotification: true,
    automationUse: "allow_switch_decision",
  },
];

describe("assembleFourBlock — proof-4 mixed-provider shape", () => {
  it("preserves the mixed-provider accounts (incl unmanaged claude profileRef=null) and signals unchanged", () => {
    const m = assembleFourBlock({ accounts: ACCOUNTS, rawBindings: [], signals: SIGNALS, asOf: ASOF });
    expect(m.accounts).toEqual(ACCOUNTS);
    expect(m.signals).toEqual(SIGNALS); // preserved unchanged
    expect(m.asOf).toBe(ASOF);
    const claude = m.accounts.find((a) => a.provider === "claude");
    expect(claude!.profileRef).toBeNull();
  });

  it("flags same_account_on_n_seats on each bound row sharing one real account (count + sorted seats)", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: "cdx-a", seatSession: "seat-2", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
        { accountId: "cdx-a", seatSession: "seat-1", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
        { accountId: "cdx-b", seatSession: "seat-3", rigName: "rig-2", boundAt: ASOF, bindingSource: "adopt" },
      ],
      signals: [],
      asOf: ASOF,
    });
    // The two cdx-a rows each carry the same_account anomaly; cdx-b (single seat) does not.
    const shared = m.bindings.filter((b) => b.accountId === "cdx-a");
    expect(shared).toHaveLength(2);
    for (const row of shared) {
      const anomaly = row.anomalies.find((a) => a.kind === "same_account_on_n_seats");
      expect(anomaly).toBeDefined();
      if (anomaly && anomaly.kind === "same_account_on_n_seats") {
        expect(anomaly.count).toBe(2);
        expect(anomaly.seats).toEqual(["seat-1", "seat-2"]); // deterministic sorted
        expect(anomaly.asOf).toBe(ASOF);
      }
    }
    const solo = m.bindings.find((b) => b.accountId === "cdx-b");
    expect(solo!.anomalies.some((a) => a.kind === "same_account_on_n_seats")).toBe(false);
  });

  it("emits an explicit unbound row for a seat with no account, carrying seat_with_no_account", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: null, seatSession: "seat-9", rigName: "rig-3", boundAt: null, bindingSource: null },
      ],
      signals: [],
      asOf: ASOF,
    });
    const unbound = m.bindings.find((b) => b.seatSession === "seat-9");
    expect(unbound).toBeDefined();
    expect(unbound!.accountId).toBeNull();
    expect(unbound!.boundAt).toBeNull();
    const anomaly = unbound!.anomalies.find((a) => a.kind === "seat_with_no_account");
    expect(anomaly).toBeDefined();
    if (anomaly && anomaly.kind === "seat_with_no_account") {
      expect(anomaly.seat).toBe("seat-9");
      expect(anomaly.asOf).toBe(ASOF);
    }
  });

  it("does NOT flag same_account_on_n_seats when ONE seat appears in duplicate identical bound rows", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: "cdx-a", seatSession: "seat-1", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
        { accountId: "cdx-a", seatSession: "seat-1", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
      ],
      signals: [],
      asOf: ASOF,
    });
    // Two rows, but ONE distinct seat → not a real cross-seat share.
    for (const b of m.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats")).toBe(false);
    }
  });

  it("does NOT invent same_account_on_n_seats from unbound (null-account) seats", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: null, seatSession: "seat-a", rigName: "r", boundAt: null, bindingSource: null },
        { accountId: null, seatSession: "seat-b", rigName: "r", boundAt: null, bindingSource: null },
      ],
      signals: [],
      asOf: ASOF,
    });
    for (const b of m.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats")).toBe(false);
    }
  });
});
