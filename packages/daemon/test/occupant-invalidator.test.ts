import { describe, it, expect, vi } from "vitest";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";

// GHOST-STAGE (e) — the OccupantInvalidator seam the cutover slice calls at SeatHandoverService.commit().
// Class-A hard-deletes the retiring occupant's name-keyed state (safe by TIMING at commit); Class-B is a
// LOUD no-op until atom-B (a name-scoped queue/watchdog drop would neutralize the successor's own items).

describe("GHOST-STAGE (e) DefaultOccupantInvalidator", () => {
  it("Class-A: hard-deletes the RETIRING occupant's enforcer state + context sidecar (by name)", () => {
    const enforcer = { invalidateOccupant: vi.fn() };
    const contextUsage = { invalidateOccupantSidecar: vi.fn() };
    const inv = new DefaultOccupantInvalidator({ enforcer, contextUsage });

    // Under a cutover the successor reuses the name — retiring === successor. Class-A keys on RETIRING.
    inv.invalidateRetiringOccupant({ retiringSessionName: "seat@rig", successorSessionName: "seat@rig" });

    expect(enforcer.invalidateOccupant).toHaveBeenCalledWith("seat@rig");
    expect(contextUsage.invalidateOccupantSidecar).toHaveBeenCalledWith("seat@rig");
  });

  it("Class-B: with NO retiringGeneration, logs a LOUD atom-B-pending marker and NEVER name-scopes", () => {
    const logs: string[] = [];
    const inv = new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant: () => {} },
      contextUsage: { invalidateOccupantSidecar: () => {} },
      log: (m) => logs.push(m),
    });
    inv.invalidateRetiringOccupant({ retiringSessionName: "seat@rig", successorSessionName: "seat@rig" });
    expect(logs.some((l) => /PENDING atom-B/.test(l) && /NOT name-scoping/.test(l))).toBe(true);
  });

  it("Class-A always runs even when Class-B is pending (the in-mem/sidecar ghost is closed now)", () => {
    const enforcer = { invalidateOccupant: vi.fn() };
    const contextUsage = { invalidateOccupantSidecar: vi.fn() };
    new DefaultOccupantInvalidator({ enforcer, contextUsage })
      .invalidateRetiringOccupant({ retiringSessionName: "s@r", successorSessionName: "s@r" });
    expect(enforcer.invalidateOccupant).toHaveBeenCalledTimes(1);
    expect(contextUsage.invalidateOccupantSidecar).toHaveBeenCalledTimes(1);
  });
});
