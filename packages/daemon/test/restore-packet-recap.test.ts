import { describe, it, expect } from "vitest";
import { buildRestorePacket } from "../src/domain/seat-handover-service.js";

// Seat-handover stopgap (plan 411c43de, addendum): the successor boot packet gains a bounded
// LABELED-FROM-RECORD recap of the last few predecessor exchanges (from the provider JSONL) + a
// receipt line naming the predecessor record path, labeled honest-degraded. Never called "scrollback"
// (the cutover's respawn-pane owns real scrollback; this is the zero-product stopgap that ships first).

const base = {
  seatRef: "dev.driver@my-rig",
  reason: "context 85%",
  departingSession: "dev-driver-h1@my-rig",
  handoverAt: "2026-08-07T01:00:00Z",
  capturedContext: "",
};

describe("buildRestorePacket — stopgap recap + receipt (labeled-from-record)", () => {
  it("renders the bounded recap from the predecessor exchanges, labeled from-record (not scrollback)", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [
        { role: "user", content: "finish the atom" },
        { role: "assistant", content: "atom finished; handing over" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });
    expect(packet).toContain("Recent exchanges (from record)");
    expect(packet).not.toContain("scrollback");
    expect(packet).toContain("user: finish the atom");
    expect(packet).toContain("assistant: atom finished; handing over");
  });

  it("renders the receipt line naming the predecessor record path, labeled honest-degraded", () => {
    const packet = buildRestorePacket({ ...base, recap: [{ role: "user", content: "x" }], recordPath: "/p/abc.jsonl" });
    expect(packet).toContain("/p/abc.jsonl");
    expect(packet.toLowerCase()).toContain("honest-degraded");
  });

  it("omits the recap/receipt sections honestly when no record is available (no fabrication)", () => {
    const packet = buildRestorePacket({ ...base, recap: [], recordPath: null });
    expect(packet).not.toContain("Recent exchanges (from record)");
    // the base packet (seat/reason/predecessor/handover) still renders
    expect(packet).toContain("Seat: dev.driver@my-rig");
  });

  it("stays backward-compatible when recap/recordPath are omitted entirely", () => {
    const packet = buildRestorePacket(base);
    expect(packet).toContain("Seat: dev.driver@my-rig");
    expect(packet).not.toContain("Recent exchanges (from record)");
  });
});
