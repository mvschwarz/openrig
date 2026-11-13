// #3093 first increment — the fleet Projects view's rendering model.
//
// The maintainer's named bars, at the TUI layer:
//  * COLLIDING IDs — two hosts serving the same native mission/slice ids draw
//    two rows, each opening a target that carries its own origin host; the
//    rows never collapse into one.
//  * SLOW / UNAVAILABLE / STALE hosts — the pane says which host answered,
//    which is stale (with its last success), which is unreachable (with the
//    daemon's own error), and never renders a failed host as fresh-empty.

import { describe, expect, it } from "vitest";
import { fleetScopesLines, FLEET_SCOPES_HINT, type FleetScopesView } from "../src/scopes/fleet-scopes-model.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";
import type { SliceScopeSnap } from "../src/scopes/scopes-model.js";

function state(fleetSelected: { hostId: string; mission: string; slice: string } | null = null) {
  return { ...createViewState({ instanceId: "fixture-instance" }), section: "fleet", fleetSelected };
}

function sliceRow(hostId: string, mission: string, dirName: string) {
  return { hostId, hostLabel: hostId, project: "proj-x", mission, dirName, id: dirName, displayName: dirName.toUpperCase(), status: "building", stage: "spec", locks: { spec: null, delivery: null } };
}

function view(overrides: Partial<FleetScopesView> = {}): FleetScopesView {
  return {
    observedAt: "2026-01-01T10:00:00.000Z",
    registry: { state: "read" },
    hosts: [
      { hostId: "host-a", status: "ok", observedAt: "2026-01-01T10:00:00.000Z", lastSuccessAt: "2026-01-01T10:00:00.000Z" },
      { hostId: "host-b", status: "ok", observedAt: "2026-01-01T10:00:00.000Z", lastSuccessAt: "2026-01-01T10:00:00.000Z" },
    ],
    missions: [
      { hostId: "host-a", hostLabel: "host-a", project: "proj-x", mission: "alpha", slices: [sliceRow("host-a", "alpha", "build-s1")] },
      { hostId: "host-b", hostLabel: "host-b", project: "proj-x", mission: "alpha", slices: [sliceRow("host-b", "alpha", "build-s1")] },
    ],
    ...overrides,
  };
}

function snapWith(v: FleetScopesView | null, detail: FleetSnapshot["fleetSliceDetail"] = null): FleetSnapshot {
  return {
    health: { availability: "unavailable", evaluatedAt: null, total: 0, truncated: false, records: [] },
    hosts: [], specs: [], needs: [], humanQueueProbed: false, execution: null, executionMission: null,
    attention: [], blocked: [], inProgress: [], seatActivity: [], pending: [], recentlyFinished: [],
    hostsDown: [], stream: [], readErrors: [],
    ...(v ? { fleetScopes: { status: { view: v } } } : {}),
    fleetSliceDetail: detail,
  };
}

describe("fleetScopesLines — composite identity (colliding ids never collapse)", () => {
  it("two hosts serving the same mission and slice id draw two rows with distinct origin hosts", () => {
    const lines = fleetScopesLines(state(), snapWith(view()), 120);
    const links = lines.flatMap(l => l.action && l.action.type === "fleet-slice-open" ? [l.action] : []);
    expect(links).toHaveLength(2);
    expect(links.map(l => l.hostId).sort()).toEqual(["host-a", "host-b"]);
    // Both rows name the same NATIVE id, and each carries its own host.
    expect(links.every(l => l.mission === "alpha" && l.slice === "build-s1")).toBe(true);
    expect(new Set(links.map(l => `${l.hostId}/${l.mission}/${l.slice}`)).size).toBe(2);
    // The rendered row text carries host and native id, not just the name.
    const texts = lines.map(l => l.text).join("\n");
    expect(texts).toContain("build-s1 · alpha@host-a");
    expect(texts).toContain("build-s1 · alpha@host-b");
  });

  it("states the honesty posture on every render: eventually consistent, no cross-host snapshot", () => {
    const lines = fleetScopesLines(state(), snapWith(view()), 120);
    // wrapDetailLines may break the hint across lines; compare normalized text.
    expect(lines.map(l => l.text).join(" ").replace(/\s+/g, " ")).toContain(FLEET_SCOPES_HINT);
  });
});

describe("fleetScopesLines — slow, unavailable and stale hosts", () => {
  it("a stale host says STALE and carries its last success time", () => {
    const v = view({
      hosts: [
        { hostId: "host-a", status: "stale", observedAt: "2026-01-01T10:00:05.000Z", lastSuccessAt: "2026-01-01T09:00:00.000Z", error: "host-a down" },
        { hostId: "host-b", status: "ok", observedAt: "2026-01-01T10:00:05.000Z", lastSuccessAt: "2026-01-01T10:00:05.000Z" },
      ],
    });
    const text = fleetScopesLines(state(), snapWith(v), 140).map(l => l.text).join("\n");
    expect(text).toContain("STALE");
    expect(text).toContain("last success 2026-01-01 09:00:00Z");
    expect(text).toContain("host-a down");
    // The last-known rows still draw — marked by the host's status, not dropped.
    expect(text).toContain("alpha@host-a");
  });

  it("an unreachable host renders its error and is never shown as a fresh-empty result", () => {
    const v = view({
      hosts: [
        { hostId: "host-a", status: "unreachable", observedAt: "2026-01-01T10:00:05.000Z", lastSuccessAt: null, error: "connect ECONNREFUSED" },
        { hostId: "host-b", status: "ok", observedAt: "2026-01-01T10:00:05.000Z", lastSuccessAt: "2026-01-01T10:00:05.000Z" },
      ],
      missions: [{ hostId: "host-b", hostLabel: "host-b", project: "proj-x", mission: "alpha", slices: [sliceRow("host-b", "alpha", "build-s1")] }],
    });
    const text = fleetScopesLines(state(), snapWith(v), 140).map(l => l.text).join("\n");
    expect(text).toContain("unreachable");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("last success never");
    expect(text).toContain("alpha@host-b");
  });

  it("an unreadable registry is named, and only local rows are claimed", () => {
    const v = view({ registry: { state: "unreadable", error: "hosts.yaml unreadable" }, hosts: [{ hostId: "host-self", status: "ok", observedAt: "2026-01-01T10:00:00.000Z", lastSuccessAt: "2026-01-01T10:00:00.000Z" }], missions: [] });
    const text = fleetScopesLines(state(), snapWith(v), 140).map(l => l.text).join("\n");
    expect(text).toContain("host registry unreadable: hosts.yaml unreadable");
  });

  it("an unread view says unavailable and infers nothing", () => {
    const snap: FleetSnapshot = { ...snapWith(null), fleetScopes: { status: { status: null, error: "connect ECONNREFUSED" } } };
    const text = fleetScopesLines(state(), snap, 140).map(l => l.text).join("\n");
    expect(text).toContain("Fleet Projects unavailable: connect ECONNREFUSED");
  });
});

describe("fleetScopesLines — the detail keeps its origin host", () => {
  const detail = {
    dirName: "build-s1", id: "build-s1", displayName: "BUILD-S1", status: "building", stage: "spec",
    locks: { spec: null, delivery: null }, proof: { paired: 1, total: 2 }, intent: "ship it",
    miniRequirements: ["one"], proofContract: [], narrative: null, specShaShort: null, prdExists: false,
  } as unknown as SliceScopeSnap;

  it("names origin host, project context and native ids above the origin's own detail", () => {
    const lines = fleetScopesLines(state({ hostId: "host-b", mission: "alpha", slice: "build-s1" }), snapWith(view(), { detail }), 140);
    const text = lines.map(l => l.text).join("\n");
    expect(text).toContain("origin host-b · project proj-x · mission alpha · slice build-s1");
    expect(text).toContain("ship it"); // the origin's intent rides through unchanged
  });

  it("a detail read that failed names the host it failed to reach", () => {
    const lines = fleetScopesLines(state({ hostId: "host-b", mission: "alpha", slice: "build-s1" }), snapWith(view(), { error: "HTTP 502" }), 140);
    const text = lines.map(l => l.text).join("\n");
    expect(text).toContain("detail unavailable from host-b: HTTP 502");
  });
});
