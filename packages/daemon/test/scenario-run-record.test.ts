import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunRecord,
  readRunRecords,
  type RunRecord,
} from "./helpers/scenario-run-record.js";

// Slice 51-02 — the append-only run-record ledger (results-ledger shape): one row
// per scenario so runs are comparable over time (proof item 3 pairs a FAIL with
// an appended run-record row). Append-only: earlier rows are never rewritten.
describe("scenario run-record ledger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ledger = () => {
    const d = mkdtempSync(join(tmpdir(), "runrec-"));
    dirs.push(d);
    return join(d, "runs.jsonl");
  };

  const rec = (scenario: string, verdict: "PASS" | "FAIL", extra: Partial<RunRecord> = {}): RunRecord => ({
    scenario,
    verdict,
    at: "2026-08-05T00:00:00Z",
    ...extra,
  });

  it("appends a row and reads it back", () => {
    const p = ledger();
    appendRunRecord(p, rec("clean-lifecycle", "PASS"));
    const rows = readRunRecords(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].scenario).toBe("clean-lifecycle");
    expect(rows[0].verdict).toBe("PASS");
  });

  it("is append-only: multiple rows preserved in order, earlier bytes untouched", () => {
    const p = ledger();
    appendRunRecord(p, rec("a", "PASS"));
    const afterFirst = readFileSync(p, "utf8");
    appendRunRecord(p, rec("b", "FAIL", { failedStep: 2, diff: "expected X observed Y" }));
    const afterSecond = readFileSync(p, "utf8");
    // the second write only APPENDED (first line's bytes are a prefix of the file)
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const rows = readRunRecords(p);
    expect(rows.map((r) => r.scenario)).toEqual(["a", "b"]);
    expect(rows[1].verdict).toBe("FAIL");
    expect(rows[1].failedStep).toBe(2);
    expect(rows[1].diff).toContain("observed");
  });

  it("each line is standalone valid JSON (JSONL)", () => {
    const p = ledger();
    appendRunRecord(p, rec("a", "PASS"));
    appendRunRecord(p, rec("b", "FAIL"));
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("reading a missing ledger yields an empty list (no throw)", () => {
    const p = ledger();
    expect(existsSync(p)).toBe(false);
    expect(readRunRecords(p)).toEqual([]);
  });
});
