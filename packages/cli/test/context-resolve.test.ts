// Slice-03 Atom 6b — the shared context-ref resolver (reused by --context /
// --body-context). Pins the whole-content resolution, the all-or-nothing
// missing-member abort (the walk consistency doctrine extended to the flags),
// and the §4 walk-sized warning.

import { describe, it, expect } from "vitest";
import { resolveContextRef, walkSizedWarning, WALK_SIZED_THRESHOLD_BYTES } from "../src/context-resolve.js";
import type { DaemonClient } from "../src/client.js";

function fakeClient(status: number, data: unknown): DaemonClient {
  return { get: async () => ({ status, data }) } as unknown as DaemonClient;
}

describe("resolveContextRef (Atom 6b)", () => {
  it("returns the whole plain content + byte size for a complete pack", async () => {
    const client = fakeClient(200, { ref: "packs/x", text: "A\n\nB", bytes: 4, pieces: [], missingFiles: [] });
    const r = await resolveContextRef(client, "packs/x");
    expect(r).toEqual({ ref: "packs/x", text: "A\n\nB", bytes: 4 });
  });

  it("ABORTS (throws) when the pack has a missing/unreadable member — no partial context", async () => {
    const client = fakeClient(200, { ref: "packs/x", text: "A", bytes: 1, pieces: [], missingFiles: [{ path: "gone.md" }] });
    await expect(resolveContextRef(client, "packs/x")).rejects.toThrow(/gone\.md/);
    await expect(resolveContextRef(client, "packs/x")).rejects.toThrow(/whole context or none/i);
  });

  it("points an absent ref at the live delivery-free context list command", async () => {
    let error: Error | undefined;
    try {
      await resolveContextRef(fakeClient(404, {}), "packs/absent");
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe(
      "Context pack 'packs/absent' not found in library. Run 'rig context list' to see the available refs.",
    );
    expect(error?.message).not.toContain("rig context-pack");
  });

  it("throws the daemon's structured unsafe message for a 400", async () => {
    await expect(resolveContextRef(fakeClient(400, { error: "unsafe_ref", message: "unsafe pack ref '../x'" }), "../x")).rejects.toThrow(/unsafe pack ref/);
  });

  it("falls back to computing bytes when the daemon omits them", async () => {
    const r = await resolveContextRef(fakeClient(200, { ref: "packs/x", text: "héllo" }), "packs/x");
    expect(r.bytes).toBe(Buffer.byteLength("héllo", "utf8"));
  });
});

describe("walkSizedWarning (Atom 6b — §4 size warn)", () => {
  it("returns null at or below the threshold", () => {
    expect(walkSizedWarning({ ref: "packs/x", text: "", bytes: WALK_SIZED_THRESHOLD_BYTES })).toBeNull();
  });

  it("advises rig walk (naming the seat + ref) above the threshold", () => {
    const w = walkSizedWarning({ ref: "packs/big", text: "", bytes: WALK_SIZED_THRESHOLD_BYTES + 1 }, "dev@rig");
    expect(w).toMatch(/walk-sized/);
    expect(w).toMatch(/rig walk dev@rig --through packs\/big/);
  });
});
