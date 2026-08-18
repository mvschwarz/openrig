// Slice 14 §0 — the RED that proves the slice.
//
// THE LIVED DEFECT: every message renders a reply hint `member@rig@<selfHostId>`, and the in-code
// justification for always appending the host is that the hint is "verbatim-usable". It is not. A
// peer used one verbatim and got `no registered host 'host-84c37990'` — because the receiver's
// registry knows that machine only by a human ALIAS, and resolution matched the suffix against
// `h.id` alone. Two naming systems, no join key.
//
// The failure is ASYMMETRIC, which is the sharp form: a hint routes only when the SENDER's self-id
// happens to be what the RECEIVER wrote in its registry. Same mechanism, opposite outcomes.
//
// MULTIHOST ONLY. On a single machine nothing here changes or improves.

import { describe, it, expect } from "vitest";
import { resolveCrossHostTarget } from "../src/cross-host-target.js";
import type { HostRegistry } from "../src/host-registry.js";

/** One http entry: the human alias an operator typed, joined to the id that host mints for itself. */
function boundRegistry(): { ok: true; registry: HostRegistry } {
  return {
    ok: true,
    registry: {
      hosts: [{
        id: "mm2-host",
        transport: "http",
        url: "http://x:7433",
        hostId: "host-84c37990",
      }],
    },
  };
}

/** The same entry as it exists today on every live registry: no join key at all. */
function unboundRegistry(): { ok: true; registry: HostRegistry } {
  return {
    ok: true,
    registry: { hosts: [{ id: "mm2-host", transport: "http", url: "http://x:7433" }] },
  };
}

describe("cross-host target resolution — alias -> id -> transport", () => {
  it("resolves a reply hint carrying the peer's SELF-ID against the registry join key", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", undefined, boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    // Normalized to the ALIAS: the human handle is the canonical registry key, and everything
    // downstream that compares against `h.id` keeps working unchanged.
    expect(r.sugarHost).toBe("mm2-host");
    expect(r.hint).toBeUndefined();
  });

  it("still resolves when the operator types the human alias", () => {
    const r = resolveCrossHostTarget("pm@some-rig@mm2-host", undefined, boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBe("mm2-host");
  });

  // The unbound entry is every entry that exists today. Migration is lazy and non-destructive, so
  // this must keep behaving exactly as it does now — an honest miss, not a new failure mode.
  it("still reports an unresolvable self-id when the entry has no join key yet", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", undefined, unboundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig@host-84c37990");
    expect(r.sugarHost).toBeUndefined();
    expect(r.hint).toContain("no registered host 'host-84c37990'");
  });

  // Two spellings of ONE host. An operator who pastes back the reply hint we printed them AND
  // passes --host with the human alias is naming the same machine twice, not two machines.
  it("accepts --host alias beside a target suffix that is the same entry's join key", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", "mm2-host", boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBe("mm2-host");
  });

  it("still rejects --host naming a genuinely DIFFERENT registered host", () => {
    const two = () => ({
      ok: true as const,
      registry: {
        hosts: [
          { id: "mm2-host", transport: "http" as const, url: "http://x:7433", hostId: "host-84c37990" },
          { id: "other-host", transport: "http" as const, url: "http://y:7433", hostId: "host-deadbeef" },
        ],
      },
    });
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", "other-host", two, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ambiguous host");
  });

  it("still rejects an --host that resolves to nothing", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", "not-registered", boundRegistry, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ambiguous host");
  });

  it("leaves a plain two-part target alone", () => {
    const r = resolveCrossHostTarget("pm@some-rig", undefined, boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBeUndefined();
  });

  // A message addressed to THIS machine's own self-id is not a cross-host message; the home-route
  // strip must keep winning over any registry match.
  it("strips this host's own self-id without routing anywhere", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-SELF", undefined, boundRegistry, "host-SELF");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBeUndefined();
  });
});
