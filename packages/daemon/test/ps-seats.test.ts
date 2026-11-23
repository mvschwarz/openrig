// `/api/ps?seats=true`: every listed rig's seat session names in the one /api/ps read, for a caller that would otherwise
// read each rig's nodes (`rig gateway human add`'s name warning). The default body is unchanged.
import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { seedHostShaped } from "./helpers/seed-host-shaped.js";
import { buildStallApp } from "./fixtures/ps-stall-http-child.js";

describe("/api/ps?seats=true", () => {
  it("lists the seat names each rig's node read lists, from the same /api/ps read, and the default body has none", async () => {
    const db = createFullTestDb();
    try {
      seedHostShaped(db);
      const app = buildStallApp(db, true);
      // The first read prepares a few statements the later ones reuse; count warm reads only.
      await app.request("/api/ps");

      const prepared: string[] = [];
      const real = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { prepared.push(sql); return real(sql); }) as never);
      let plain: Array<Record<string, unknown>>;
      let withSeats: Array<{ rigId: string; seats: string[] }>;
      let plainStatements: number;
      try {
        plain = await (await app.request("/api/ps")).json() as Array<Record<string, unknown>>;
        plainStatements = prepared.length;
        withSeats = await (await app.request("/api/ps?seats=true")).json() as Array<{ rigId: string; seats: string[] }>;
      } finally { spy.mockRestore(); }

      expect(plain.length).toBeGreaterThan(1);
      expect(plain.every((rig) => !("seats" in rig))).toBe(true);
      // The names come from the projection's own inventory pass: the same statements as the default read, no more.
      expect(prepared.length - plainStatements).toBe(plainStatements);
      expect(withSeats.map((rig) => rig.rigId)).toEqual(plain.map((rig) => rig.rigId));
      // The names the per-rig node read lists, which the one read replaces.
      for (const rig of withSeats) {
        const nodes = await (await app.request(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`)).json() as Array<{ canonicalSessionName?: string | null }>;
        const listed = nodes.flatMap((node) => node.canonicalSessionName ? [node.canonicalSessionName] : []);
        expect(listed.length).toBeGreaterThan(0);
        expect([...rig.seats].sort()).toEqual(listed.sort());
      }
    } finally { db.close(); }
  });
});
