// OPR.0.4.6.MH5 — the fleet composer's correctness core (plan C5, the
// C1-pinning subset): the Q4 one-count Set (`hostId|identity`, the one
// place), permutation-stable union, kind-agnostic carry, the WF-4 Q6
// workflow-pointer passthrough, absent-not-zero per-host honesty, and the
// no-clock/no-random purity pin. The fan-out shell vectors mirror the
// shipped attention-aggregator's per-host outcome discipline.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  composeFleet,
  unionFleet,
  FLEET_READ_TIMEOUT_MS,
} from "../src/domain/review/fleet-compose.js";
import type { FleetComposeDeps, FleetHostInput } from "../src/domain/review/fleet-compose.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { PerHostStatus } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedRigAgents, NeedsYouItem } from "../src/domain/review/types.js";

const NOW = "2026-07-08T14:00:00.000Z";

function item(overrides: Partial<NeedsYouItem> & { identity: string }): NeedsYouItem {
  return {
    source: "agent",
    summary: `summary ${overrides.identity}`,
    leg: "human-gate",
    where: "rig",
    ageIso: "2026-07-08T13:00:00.000Z",
    priority: null,
    tier: null,
    evidenceRef: null,
    unblocks: null,
    qitemId: overrides.identity,
    destinationSession: null,
    derived: null,
    ...overrides,
  };
}

function hostInput(hostId: string, overrides: Partial<FleetHostInput> = {}): FleetHostInput {
  return {
    hostId,
    kind: hostId === LOCAL_HOST_ID ? "local" : "remote",
    scopedNeedsYou: [],
    agents: [],
    settled: [],
    ...overrides,
  };
}

const OK = (hostId: string): PerHostStatus => ({ hostId, status: "ok" });

describe("unionFleet — the Q4 one-count key (hostId|identity)", () => {
  it("same identity from slice+mission+rig on ONE host collapses to ONE row with 3-altitude provenance", () => {
    const shared = item({ identity: "qi-1" });
    const fleet = unionFleet(
      [
        hostInput("vps-a", {
          scopedNeedsYou: [
            { scope: "slice", items: [shared] },
            { scope: "mission", items: [shared] },
            { scope: "rig", items: [shared] },
          ],
        }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    expect(fleet.needsYou.items).toHaveLength(1);
    expect(fleet.needsYou.items[0]!.fleetKey).toBe("vps-a|qi-1");
    expect(fleet.needsYou.items[0]!.seenFrom).toEqual(["slice", "mission", "rig"]);
    expect(fleet.rollup.needsYouCount).toBe(1);
  });

  it("the SAME identity string on TWO hosts stays TWO rows (the host dimension distinguishes)", () => {
    const fleet = unionFleet(
      [
        hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-same" })] }] }),
        hostInput("vps-b", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-same" })] }] }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a"), OK("vps-b")],
      NOW,
    );
    expect(fleet.needsYou.items).toHaveLength(2);
    expect(fleet.needsYou.items.map((r) => r.fleetKey).sort()).toEqual(["vps-a|qi-same", "vps-b|qi-same"]);
  });

  it("MH-3 forwarded item: origin-owns-the-record means the id appears in ONE host's set only → one fleet row", () => {
    // A forwarded qitem lives in its ORIGIN host's DB only (the source
    // closed on handoff) — the fixture mirrors that construction.
    const fleet = unionFleet(
      [
        hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-forwarded" })] }] }),
        hostInput("vps-b", { scopedNeedsYou: [{ scope: "rig", items: [] }] }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a"), OK("vps-b")],
      NOW,
    );
    expect(fleet.needsYou.items).toHaveLength(1);
    expect(fleet.needsYou.items[0]!.fleetKey).toBe("vps-a|qi-forwarded");
  });
});

describe("unionFleet — permutation-stable (input order never changes rows/counts)", () => {
  const inputs: FleetHostInput[] = [
    hostInput(LOCAL_HOST_ID, {
      scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-l1", priority: "urgent" })] }],
    }),
    hostInput("vps-a", {
      scopedNeedsYou: [
        { scope: "rig", items: [item({ identity: "qi-a1" }), item({ identity: "qi-a2", source: "derived", derived: { kind: "stuck", evidence: "idle 47m >= 30m", threshold: "stuck >= 30m idle" } })] },
        { scope: "slice", items: [item({ identity: "qi-a1" })] },
      ],
    }),
    hostInput("vps-b", {
      scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-b1", priority: "low" })] }],
    }),
  ];
  const statuses = [OK(LOCAL_HOST_ID), OK("vps-a"), OK("vps-b")];

  it("reversed and rotated host inputs (and scoped-set order) yield a byte-identical payload", () => {
    const base = unionFleet(inputs, statuses, NOW);
    const reversed = unionFleet([...inputs].reverse(), statuses, NOW);
    const rotated = unionFleet([inputs[2]!, inputs[0]!, inputs[1]!], statuses, NOW);
    const scopedReversed = unionFleet(
      inputs.map((h) => ({ ...h, scopedNeedsYou: [...h.scopedNeedsYou].reverse() })),
      statuses,
      NOW,
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(base));
    expect(JSON.stringify(rotated)).toBe(JSON.stringify(base));
    // Row set + counts are order-invariant; seenFrom records the scopes as
    // a SET-equivalent (order may reflect read order, so compare sorted).
    expect(scopedReversed.needsYou.items.map((r) => ({ ...r, seenFrom: [...r.seenFrom].sort() }))).toEqual(
      base.needsYou.items.map((r) => ({ ...r, seenFrom: [...r.seenFrom].sort() })),
    );
    expect(scopedReversed.rollup).toEqual(base.rollup);
  });

  it("the same inputs twice yield a byte-identical payload (pure — no clock/random)", () => {
    expect(JSON.stringify(unionFleet(inputs, statuses, NOW))).toBe(JSON.stringify(unionFleet(inputs, statuses, NOW)));
  });
});

describe("unionFleet — kind-agnostic carry + workflow passthrough (D-2)", () => {
  it("a synthetic 8th exception kind flows through UNTOUCHED (union, never filter)", () => {
    const synthetic = item({
      identity: "qi-x|future-kind|2026-07-08",
      source: "derived",
      // Deliberately outside today's closed 7-kind union — the fleet layer
      // must carry whatever the per-host composer produced.
      derived: { kind: "future-kind" as never, evidence: "synthetic evidence", threshold: "synthetic threshold" },
    });
    const fleet = unionFleet(
      [hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [synthetic] }] })],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    expect(fleet.needsYou.items[0]!.derived).toEqual({ kind: "future-kind", evidence: "synthetic evidence", threshold: "synthetic threshold" });
    expect(fleet.rollup.exceptionsByKind).toEqual([{ kind: "future-kind", count: 1 }]);
  });

  it("row.workflow passes through pointer-only and OMITS when absent (byte-identity-by-omission)", () => {
    const withPointer = item({
      identity: "qi-wf",
      workflow: { instanceId: "wfi-1", workflowName: "acme-factory", stepId: "assemble" },
    });
    const without = item({ identity: "qi-plain" });
    const fleet = unionFleet(
      [hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [withPointer, without] }] })],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    const wf = fleet.needsYou.items.find((r) => r.identity === "qi-wf")!;
    const plain = fleet.needsYou.items.find((r) => r.identity === "qi-plain")!;
    expect(wf.workflow).toEqual({ instanceId: "wfi-1", workflowName: "acme-factory", stepId: "assemble" });
    expect("workflow" in plain).toBe(false);
  });
});

describe("unionFleet — per-host honesty + rollup math", () => {
  it("an unreachable host has its status PRESENT and its counts ABSENT (not zero); rollup reflects it", () => {
    const down: PerHostStatus = { hostId: "vps-b", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" };
    const fleet = unionFleet(
      [hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-a1" })] }] })],
      [OK(LOCAL_HOST_ID), OK("vps-a"), down],
      NOW,
    );
    const bRow = fleet.hosts.find((h) => h.hostId === "vps-b")!;
    expect(bRow.status).toEqual(down);
    expect("needsYouCount" in bRow).toBe(false);
    expect("exceptionsByKind" in bRow).toBe(false);
    expect("topLine" in bRow).toBe(false);
    expect(fleet.rollup.hostCount).toBe(3);
    expect(fleet.rollup.unreachableCount).toBe(1);
    expect(fleet.needsYou.provenance).toContain("2/3 hosts composing");
    expect(fleet.needsYou.provenance).toContain("ABSENT, not zero");
  });

  it("header math is computed FROM the deduped rows and equals the HOSTS-band per-host sums", () => {
    const fleet = unionFleet(
      [
        hostInput(LOCAL_HOST_ID, {
          scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-l1" })] }],
          agents: [
            { agentName: "lead", runtime: "claude-code", stateGlyph: "active", doing: null, holdsCount: 1, lastTransitionIso: null, exception: null, sessionName: "lead@acme-build", slices: [] },
            { agentName: "builder", runtime: "codex", stateGlyph: "idle", doing: null, holdsCount: 0, lastTransitionIso: null, exception: null, sessionName: "builder@acme-web", slices: [] },
          ],
        }),
        hostInput("vps-a", {
          scopedNeedsYou: [
            {
              scope: "rig",
              items: [
                item({ identity: "qi-a1" }),
                item({ identity: "qi-a2|stuck|t0", source: "derived", derived: { kind: "stuck", evidence: "idle 47m >= 30m", threshold: "stuck >= 30m idle" } }),
                item({ identity: "qi-a3|overdue|t0", source: "derived", derived: { kind: "overdue", evidence: "2d >= 24h window", threshold: "overdue >= 24h" } }),
              ],
            },
          ],
        }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    expect(fleet.rollup).toEqual({
      needsYouCount: 2,
      exceptionCount: 2,
      exceptionsByKind: [
        { kind: "overdue", count: 1 },
        { kind: "stuck", count: 1 },
      ],
      hostCount: 2,
      unreachableCount: 0,
    });
    const perHostNeedsYou = fleet.hosts.reduce((n, h) => n + (h.needsYouCount ?? 0), 0);
    const perHostExceptions = fleet.hosts.flatMap((h) => h.exceptionsByKind ?? []).reduce((n, k) => n + k.count, 0);
    expect(perHostNeedsYou).toBe(fleet.rollup.needsYouCount);
    expect(perHostExceptions).toBe(fleet.rollup.exceptionCount);
    // seat/rig counts derive from the host's own agents band (BR-1 grammar).
    const localRow = fleet.hosts.find((h) => h.hostId === LOCAL_HOST_ID)!;
    expect(localRow.seatCount).toBe(2);
    expect(localRow.rigCount).toBe(2);
    // topLine is worst-first and deterministic.
    const aRow = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(aRow.topLine).toBe("● summary qi-a1");
  });
});

describe("fleet-compose purity pin — no clock, no random (arch/C5)", () => {
  it("the fleet composer source contains no Date.now/new Date()/Math.random (it unions, never derives time state)", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/domain/review/fleet-compose.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new Date\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// The fan-out shell (mirrors the shipped attention-aggregator discipline).
// ---------------------------------------------------------------------------

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "A" },
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

function composedRigResponse(items: NeedsYouItem[]): Response {
  const body: ComposedRigAgents = {
    scope: "rig",
    needsYou: { items, provenance: "composed from the rig read root" },
    agents: { scope: "rig", rows: [], provenance: "seats", coordinationHealth: null },
    settled: [],
    settledProvenance: "today's closed handoffs",
    composedAt: NOW,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function localComposed(items: NeedsYouItem[]): ComposedRigAgents {
  return {
    scope: "rig",
    needsYou: { items, provenance: "composed from the rig read root" },
    agents: { scope: "rig", rows: [], provenance: "seats", coordinationHealth: null },
    settled: [],
    settledProvenance: "today's closed handoffs",
    composedAt: NOW,
  };
}

function fanoutDeps(overrides: Partial<FleetComposeDeps> = {}): FleetComposeDeps {
  return {
    composeLocalRig: () => localComposed([item({ identity: "qi-local-1" })]),
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    registryExists: () => true,
    nowIso: NOW,
    env: { A: "ta", B: "tb" },
    ...overrides,
  };
}

describe("composeFleet — the fan-out shell (D-1/D-7 + per-host honesty)", () => {
  it("local joins IN-PROCESS (zero self-transport) and every registered host is fanned out to /api/review/rig", async () => {
    const urls: string[] = [];
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) => {
          urls.push(String(url));
          return composedRigResponse([item({ identity: String(url).includes("vps-a") ? "qi-a1" : "qi-b1" })]);
        }) as typeof fetch,
      }),
    );
    expect(urls.some((u) => u.includes("vps-a") && u.endsWith("/api/review/rig"))).toBe(true);
    expect(urls.some((u) => u.includes("vps-b") && u.endsWith("/api/review/rig"))).toBe(true);
    // Local + both http hosts contributed; the ssh host is a status row only.
    expect(fleet.needsYou.items.map((r) => r.fleetKey).sort()).toEqual(["local|qi-local-1", "vps-a|qi-a1", "vps-b|qi-b1"]);
    expect(fleet.hosts.map((h) => [h.hostId, h.status.status])).toEqual([
      [LOCAL_HOST_ID, "ok"],
      ["vps-a", "ok"],
      ["vps-b", "ok"],
      ["ssh-1", "unsupported-transport"],
    ]);
    // Every row from the v1 fan-out carries rig-root provenance.
    for (const r of fleet.needsYou.items) expect(r.seenFrom).toEqual(["rig"]);
  });

  it("one unreachable host degrades to its structured status; the rest still compose (never all-or-nothing)", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) => {
          if (String(url).includes("vps-a")) throw new Error("ECONNREFUSED");
          return composedRigResponse([item({ identity: "qi-b1" })]);
        }) as typeof fetch,
      }),
    );
    const aRow = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(aRow.status).toEqual({ hostId: "vps-a", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" });
    expect("needsYouCount" in aRow).toBe(false);
    expect(fleet.needsYou.items.map((r) => r.fleetKey).sort()).toEqual(["local|qi-local-1", "vps-b|qi-b1"]);
    expect(fleet.rollup.unreachableCount).toBe(2); // vps-a down + ssh-1 unsupported
  });

  it("a 200 with a malformed composed payload degrades honestly (never silently-empty ok data)", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("vps-a")
            ? new Response(JSON.stringify({ nonsense: true }), { status: 200 })
            : composedRigResponse([])) as typeof fetch,
      }),
    );
    const aRow = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(aRow.status.status).toBe("unreachable");
    expect(aRow.status.error).toContain("malformed");
  });

  it("HTTP 401/403 → auth-failed (the operator fix differs from unreachable)", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("vps-a")
            ? new Response("forbidden", { status: 403 })
            : composedRigResponse([])) as typeof fetch,
      }),
    );
    expect(fleet.hosts.find((h) => h.hostId === "vps-a")!.status.status).toBe("auth-failed");
  });

  it("no registry file = a clean local-only fleet (single-host operator; registry never read)", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        registryExists: () => false,
        loadRegistry: () => {
          throw new Error("registry must not be read when absent");
        },
      }),
    );
    expect(fleet.hosts).toHaveLength(1);
    expect(fleet.hosts[0]!.hostId).toBe(LOCAL_HOST_ID);
    expect("registryError" in fleet).toBe(false);
  });

  it("a registry that EXISTS but fails to load is surfaced honestly (never a silently-local-only fleet)", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        loadRegistry: () => ({ ok: false, error: "failed to parse host registry YAML" }),
      }),
    );
    expect(fleet.registryError).toContain("failed to parse");
    expect(fleet.hosts).toHaveLength(1);
  });

  it("the read deadline class is named and bounded (a poll, not a bootstrap)", () => {
    expect(FLEET_READ_TIMEOUT_MS).toBe(5_000);
  });
});
