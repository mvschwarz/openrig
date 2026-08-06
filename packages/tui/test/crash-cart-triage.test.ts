import { describe, it, expect } from "vitest";
import { buildTriageModel, renderTriage, type TriageCheckInput } from "../src/crash-cart/triage.js";

// Crash-cart C3 C4 — the post-run aggregate triage list (plan c015d9ed §C4). ONE keyboard-walkable
// list, never one blocking prompt per seat: each row = a seat + exactly what it needs (the failing
// restore-check's remediation). GREEN seats are omitted (nothing needed); red before yellow. C4 has NO
// mock (a text list). The conductor aggregate (C1 attention_required/resume_failed) + the resolve→resume
// handoff + the live restore-check fetch are seams (C1 excluded this wave); this is the model+render.

const seat = (seat: string, entries: TriageCheckInput["entries"]): TriageCheckInput => ({ seat, entries });

describe("buildTriageModel — flatten per-seat failing checks; green omitted", () => {
  it("keeps only yellow/red checks, one row per (seat, failing check), red before yellow", () => {
    const rows = buildTriageModel([
      seat("dev-driver@r", [
        { check: "resume.token", status: "green", evidence: "ok", remediation: "" },
        { check: "claude.picker", status: "red", evidence: "no session token", remediation: "run claude --resume and pick a session", remediationSafe: false },
      ]),
      seat("dev-qa@r", [{ check: "codex.auth", status: "yellow", evidence: "auth stale", remediation: "re-auth codex", remediationSafe: true }]),
    ]);
    expect(rows.map((r) => `${r.seat}:${r.check}:${r.status}`)).toEqual([
      "dev-driver@r:claude.picker:red",
      "dev-qa@r:codex.auth:yellow",
    ]);
    expect(rows[0]!.need).toBe("run claude --resume and pick a session");
    expect(rows[0]!.remediationSafe).toBe(false);
  });

  it("returns [] when every seat is green (all restored clean)", () => {
    expect(buildTriageModel([seat("a@r", [{ check: "x", status: "green", evidence: "ok", remediation: "" }])])).toEqual([]);
  });
});

describe("renderTriage — keyboard-walkable list (or the all-clean line)", () => {
  it("renders a header + one row per need (seat + remediation), with the check dim", () => {
    const body = renderTriage(
      buildTriageModel([seat("dev-driver@r", [{ check: "claude.picker", status: "red", evidence: "no token", remediation: "run claude --resume", remediationSafe: false }])]),
    )
      .map((l) => l.text)
      .join("\n");
    expect(body).toContain("NEEDS ATTENTION (1)");
    expect(body).toContain("dev-driver@r");
    expect(body).toContain("run claude --resume");
    expect(body).toContain("claude.picker");
  });

  it("renders the all-clean line when there is nothing to triage", () => {
    const body = renderTriage([]).map((l) => l.text).join("\n");
    expect(body).toContain("all seats restored clean");
    expect(body).not.toContain("NEEDS ATTENTION");
  });
});
