import { describe, it, expect } from "vitest";
import {
  buildCrashCartModel,
  demoCrashCartModel,
  hhmm,
  NO_SHUTDOWN_RECORD,
  type CrashCartDiscoveryInput,
} from "../src/crash-cart/crash-cart-model.js";
import { renderCrashCartView } from "../src/crash-cart/render-crash-cart.js";

// Crash-cart cockpit VIEW (5.2 Wave B, plan c015d9ed §C3). Mock-verbatim (approved mock 3d3c90a0):
// exact-string layout assertions (the byte-truth mechanism used across this package) + seg-paint
// intent (bold text must carry a color token or it renders plain — the no-op class). PM ruling:
// header stop-reason + prior-uptime are EXPLICIT honest-unknown, never blank/inferred.

describe("renderCrashCartView — mock-verbatim layout (demo)", () => {
  const body = renderCrashCartView(demoCrashCartModel())
    .map((l) => l.text)
    .join("\n");

  it("renders the daemon-down header with honest-unknown uptime + reason (structure per mock)", () => {
    expect(body).toContain(
      "◌ daemon not running — last seen 08:12 (uptime unavailable — no shutdown record) · reason: unavailable — no shutdown record",
    );
  });

  it("renders FOUND ON THIS HOST rows with aligned details", () => {
    expect(body).toContain("FOUND ON THIS HOST");
    expect(body).toContain(" ▦ openrig-pm    13 seats · last active 08:11 · 7 sessions resumable");
    expect(body).toContain(" ▦ kernel        4 seats · last active 08:12 · 4 sessions resumable");
    expect(body).toContain(" ▦ oversight     3 seats · last active 07:58 · 3 sessions resumable");
  });

  it("renders WHERE WORK STOPPED with the in-progress item then the idle-clean closer", () => {
    expect(body).toContain("WHERE WORK STOPPED (from the durable ledgers)");
    expect(body).toContain(' ◌ pm-openrig — qitem in-progress: "cut packet assembly" (08:09)');
    expect(body).toContain(" ✓ everything else idle-clean at stop");
  });

  it("renders the actions block: highlighted RESTORE EVERYTHING + the secondary keys", () => {
    expect(body).toContain(
      " ⏎ RESTORE EVERYTHING — daemon + kernel + all rigs, sessions resumed in their seats ",
    );
    expect(body).toContain(
      "  s start daemon only  ·  i inspect a rig  ·  n new here? onboarding (policy menu lives here now)",
    );
  });

  it("orders the sections: header → FOUND → WHERE WORK STOPPED → actions", () => {
    expect(body.indexOf("FOUND ON THIS HOST")).toBeGreaterThan(body.indexOf("daemon not running"));
    expect(body.indexOf("WHERE WORK STOPPED")).toBeGreaterThan(body.indexOf("FOUND ON THIS HOST"));
    expect(body.indexOf("RESTORE EVERYTHING")).toBeGreaterThan(body.indexOf("WHERE WORK STOPPED"));
  });
});

describe("renderCrashCartView — seg-paint intent (bold carries a token; selection paints bg)", () => {
  const lines = renderCrashCartView(demoCrashCartModel());

  it("the daemon-down glyph/label is warn", () => {
    const header = lines.find((l) => l.text.startsWith("◌ daemon not running"))!;
    const warnSeg = header.segs!.find((s) => s.text.includes("daemon not running"));
    expect(warnSeg?.token).toBe("warn");
  });

  it("the rig name seg carries a color token AND bold (never bold-only → never a paint no-op)", () => {
    const rigLine = lines.find((l) => l.text.includes("openrig-pm"))!;
    const nameSeg = rigLine.segs!.find((s) => s.text === "openrig-pm")!;
    expect(nameSeg.bold).toBe(true);
    expect(nameSeg.token).toBeTruthy(); // has a color → won't render plain
  });

  it("the RESTORE EVERYTHING row is selected and paints an accent background", () => {
    const restore = lines.find((l) => l.text.includes("RESTORE EVERYTHING"))!;
    expect(restore.selected).toBe(true);
    expect(restore.segs!.some((s) => s.bg === "accent")).toBe(true);
  });

  it("the idle-clean line's ✓ is ok-toned", () => {
    const idle = lines.find((l) => l.text.includes("everything else idle-clean"))!;
    expect(idle.segs!.find((s) => s.text.includes("✓"))?.token).toBe("ok");
  });
});

describe("buildCrashCartModel — adapt C2 discovery; honest-null → honest-unknown", () => {
  const discovery: CrashCartDiscoveryInput = {
    header: { lastActivityAt: "2026-08-06T08:12:00Z" },
    foundOnHost: [
      { rigName: "alpha", seatCount: 5, resumableCount: 3, lastActiveAt: "2026-08-06 07:58:00" },
    ],
    whereWorkStopped: [
      { destinationSession: "worker@alpha", summary: "build X", tsUpdated: "2026-08-06T08:09:00Z" },
    ],
  };

  it("maps last-seen/rigs/stopped and forces the two header slots to honest-unknown", () => {
    const m = buildCrashCartModel(discovery);
    expect(m.header).toEqual({
      lastSeen: "08:12",
      uptimeText: NO_SHUTDOWN_RECORD,
      reasonText: NO_SHUTDOWN_RECORD,
    });
    expect(m.foundOnHost[0]).toEqual({ name: "alpha", seatCount: 5, lastActive: "07:58", resumableCount: 3 });
    expect(m.whereWorkStopped[0]).toEqual({ session: "worker@alpha", summary: "build X", time: "08:09" });
  });

  it("shows the idle-clean closer only (no ◌ rows) when nothing is in-progress", () => {
    const m = buildCrashCartModel({ ...discovery, whereWorkStopped: [] });
    const body = renderCrashCartView(m).map((l) => l.text).join("\n");
    expect(body).toContain(" ✓ everything else idle-clean at stop");
    expect(body).not.toContain("qitem in-progress");
  });

  it("hhmm handles ISO-Z, space-form, and null", () => {
    expect(hhmm("2026-08-06T08:12:34Z")).toBe("08:12");
    expect(hhmm("2026-08-06 07:58:00")).toBe("07:58");
    expect(hhmm(null)).toBe("unknown");
  });
});
