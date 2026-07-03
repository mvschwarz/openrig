import { describe, it, expect } from "vitest";
import { buildRestorePlanPreview, collectPreviewSessionRows, type PreviewSessionRow } from "../src/domain/restore-plan-preview.js";
import type { RigWithRelations } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

// OPR.0.4.3.20 FR-6 — restore-plan per-seat token state (read-only forecast).

function rigWith(nodes: Array<{ id: string; logicalId: string; runtime: string | null }>): RigWithRelations {
  return {
    rig: { id: "rig-1", name: "test-rig" },
    nodes: nodes.map((n) => ({ id: n.id, logicalId: n.logicalId, runtime: n.runtime })),
    edges: [],
  } as unknown as RigWithRelations;
}

function row(nodeId: string, over: Partial<PreviewSessionRow> = {}): PreviewSessionRow {
  return {
    nodeId,
    id: "s-" + nodeId,
    restorePolicy: "resume_if_possible",
    resumeType: "claude_id",
    resumeToken: "tok",
    resumeProvenance: "adoption",
    resumeLastVerified: null,
    resumeLastProbeStatus: null,
    ...over,
  };
}

const NOW = Date.parse("2026-07-02T12:00:00Z");
const FRESH = "2026-07-02 11:59:00"; // 1 min ago (< 1h threshold)
const OLD = "2026-07-02 10:00:00";   // 2h ago (> 1h threshold)

describe("FR-6 restore-plan token state", () => {
  it("missing: no token → freshRequired, --fresh would be needed", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeToken: null, resumeType: null, resumeProvenance: null })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("missing");
    expect(p.nodes[0]!.freshRequired).toBe(true);
    expect(p.mutated).toBe(false);
  });

  it("unverified: a present token that was never probed", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: null, resumeLastProbeStatus: null })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("unverified");
    expect(p.nodes[0]!.freshRequired).toBe(false);
  });

  it("present: probe resumable + verified within the freshness threshold", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: FRESH, resumeLastProbeStatus: "resumable" })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("present");
    expect(p.nodes[0]!.provenance).toBe("adoption");
    expect(p.nodes[0]!.lastVerified).toBe(FRESH);
    expect(p.nodes[0]!.runtimePrompt).toMatch(/Claude session picker/);
  });

  // THE survival-critical case (§2.4): a present token whose last probe returned
  // not_resumable (e.g. a rolled Claude adoption token FR-4 leaves present) MUST
  // render `stale`, NEVER `missing` or only `--fresh required`.
  it("stale (failed probe): present + not_resumable renders STALE, not missing", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: FRESH, resumeLastProbeStatus: "not_resumable" })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("stale");
    expect(p.nodes[0]!.tokenState).not.toBe("missing");
    expect(p.nodes[0]!.freshRequired).toBe(false); // still has a token to try
  });

  it("stale (age): a resumable token verified past the threshold renders STALE", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: OLD, resumeLastProbeStatus: "resumable" })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("stale");
  });

  it("codex runtime prompt surfaced for a resumable Codex seat", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "codex" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeType: "codex_id", resumeLastProbeStatus: "resumable", resumeLastVerified: FRESH })], undefined, NOW);
    expect(p.nodes[0]!.runtimePrompt).toMatch(/Codex auth/);
  });

  it("read-only: mutated stays false across all seat states", () => {
    const rig = rigWith([
      { id: "n1", logicalId: "a", runtime: "claude-code" },
      { id: "n2", logicalId: "b", runtime: "codex" },
    ]);
    const p = buildRestorePlanPreview(rig, null, [
      row("n1", { resumeToken: null }),
      row("n2", { resumeLastProbeStatus: "not_resumable" }),
    ], undefined, NOW);
    expect(p.mutated).toBe(false);
    expect(p.nodes).toHaveLength(2);
  });

  it("degrades: a snapshot session serialized pre-45 (no freshness fields) → unverified, no crash", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    // Simulate an old snapshot row lacking the FR-6 fields entirely.
    const legacy = { nodeId: "n1", id: "s-n1", restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: "tok" } as unknown as PreviewSessionRow;
    const p = buildRestorePlanPreview(rig, null, [legacy], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("unverified");
  });
});

// End-to-end LIVE path (the primary FR-6 survival proof): DB stamping → the live
// SELECT (collectPreviewSessionRows) → the plan surfaces stale-present, WHILE running.
describe("FR-6 live path — DB → collectPreviewSessionRows → plan state", () => {
  it("a present token marked not_resumable surfaces as STALE in the live plan (not missing)", () => {
    const db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "t");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?,?,?,?,?)").run("n1", "rig-1", "a", "worker", "claude-code");
    const reg = new SessionRegistry(db);
    const s = reg.registerSession("n1", "r01-a");
    reg.updateResumeToken(s.id, "claude_id", "tok-1", "adoption"); // stamps verified + resumable
    reg.markResumeProbeResult(s.id, "not_resumable");              // mark stale, keep the token
    const rig = { rig: { id: "rig-1", name: "t" }, nodes: [{ id: "n1", logicalId: "a", runtime: "claude-code" }], edges: [] } as unknown as RigWithRelations;
    const rows = collectPreviewSessionRows(db, rig, null);
    const r = rows.find((x) => x.nodeId === "n1")!;
    // the live SELECT carries provenance + freshness columns from the DB
    expect(r.resumeToken).toBe("tok-1");
    expect(r.resumeProvenance).toBe("adoption");
    expect(r.resumeLastProbeStatus).toBe("not_resumable");
    expect(r.resumeLastVerified).not.toBeNull();
    // and the plan surfaces it as stale-present (survives, not nulled)
    const p = buildRestorePlanPreview(rig, null, rows);
    expect(p.nodes[0]!.tokenState).toBe("stale");
    expect(p.mutated).toBe(false);
    db.close();
  });
});
