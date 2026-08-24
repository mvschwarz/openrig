import { describe, it, expect } from "vitest";
import { buildRestorePacket } from "../src/domain/seat-handover-service.js";

// The successor boot packet carries a bounded LABELED-FROM-RECORD recap of the last few predecessor
// exchanges (from the provider JSONL) + a receipt line naming the predecessor record path, labeled
// honest-degraded. The recap is the permanent claude-runtime leg of scrollback preservation
// (alternate-screen seats keep no native scrollback); it is never called "scrollback" — the label
// must make replay unmistakable.

const base = {
  seatRef: "dev.driver@my-rig",
  reason: "context 85%",
  departingSession: "dev-driver-h1@my-rig",
  handoverAt: "2026-08-07T01:00:00Z",
  capturedContext: "",
};

describe("buildRestorePacket — recap + receipt (labeled-from-record)", () => {
  it("renders the bounded recap from the predecessor exchanges, labeled replayed-from-record (not scrollback)", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [
        { role: "user", content: "finish the atom" },
        { role: "assistant", content: "atom finished; handing over" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });
    expect(packet).toContain("Predecessor recap (replayed from record, not the live terminal)");
    expect(packet).not.toContain("scrollback");
    expect(packet).toContain("user: finish the atom");
    expect(packet).toContain("assistant: atom finished; handing over");
  });

  it("renders the receipt line naming the predecessor record path, labeled honest-degraded (durable, grep-able, not human-scrollable)", () => {
    const packet = buildRestorePacket({ ...base, recap: [{ role: "user", content: "x" }], recordPath: "/p/abc.jsonl" });
    expect(packet).toContain("Predecessor record: /p/abc.jsonl");
    expect(packet.toLowerCase()).toContain("honest-degraded");
    expect(packet).toContain("not human-scrollable");
  });

  it("omits the recap/receipt sections honestly when no record is available (no fabrication)", () => {
    const packet = buildRestorePacket({ ...base, recap: [], recordPath: null });
    expect(packet).not.toContain("Predecessor recap (replayed from record");
    expect(packet).not.toContain("Predecessor record:");
    // the base packet (seat/reason/predecessor/handover) still renders
    expect(packet).toContain("Seat: dev.driver@my-rig");
  });

  it("B16: an unavailable recap renders its NAMED reason as a labeled line (never a silent omission)", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [],
      recordPath: null,
      recapUnavailableReason: "the name-keyed context sidecar is missing or carries no transcript_path",
    });
    expect(packet).toContain("--- Predecessor recap unavailable: the name-keyed context sidecar is missing or carries no transcript_path ---");
    expect(packet).not.toContain("scrollback"); // the fence holds on the unavailable line too
  });

  it("B16: a RESOLVED recap suppresses the unavailable line even if a reason was passed", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [{ role: "user", content: "x" }],
      recordPath: "/p/abc.jsonl",
      recapUnavailableReason: "should not render",
    });
    expect(packet).toContain("Predecessor recap (replayed from record");
    expect(packet).not.toContain("recap unavailable");
  });

  it("stays backward-compatible when recap/recordPath are omitted entirely", () => {
    const packet = buildRestorePacket(base);
    expect(packet).toContain("Seat: dev.driver@my-rig");
    expect(packet).not.toContain("Predecessor recap (replayed from record");
  });
});

// OPR.0.5.3.5 recap-write atom (mini-req 7 / Q2 boundary requirement) — the
// AUTHORED seat recap joins the packet as a THIRD leg beside the from-record
// recap: the successor is pointed at the ADDRESS (seat:RECAP.md — no-copy
// composition, never inlined bytes), with the chain depth named; absence is a
// labeled line per the B16 doctrine, never a silent omission.
describe("buildRestorePacket — the AUTHORED recap leg (seat-homed, by address)", () => {
  it("renders the authored recap's ADDRESS and chain depth — pointer, never inlined bytes", () => {
    const packet = buildRestorePacket({
      ...base,
      authoredRecap: { address: "seat:RECAP.md", chainLength: 2 },
    });
    expect(packet).toContain("Authored seat recap");
    expect(packet).toContain("seat:RECAP.md");
    expect(packet).toMatch(/2 superseded/);
    expect(packet).toContain("rig context get"); // tells the successor HOW to pull it
  });

  it("absence is a LABELED line naming the reason, never silence", () => {
    const packet = buildRestorePacket({
      ...base,
      authoredRecapAbsentReason: "no RECAP.md on the seat tree (predecessor never wrote one)",
    });
    expect(packet).toContain("Authored seat recap");
    expect(packet).toContain("predecessor never wrote one");
  });

  it("stays backward-compatible when the authored leg is omitted entirely", () => {
    const packet = buildRestorePacket(base);
    expect(packet).not.toContain("Authored seat recap");
  });
});
