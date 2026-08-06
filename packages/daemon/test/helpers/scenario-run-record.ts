/**
 * Slice 51-02 (L2 test-system) — the append-only run-record ledger.
 *
 * One JSONL row per scenario run (the "results-ledger shape") so runs are
 * comparable over time. Append-only: appending a row never rewrites earlier
 * bytes. Proof item 3 pairs a FAIL verdict with an appended run-record row that
 * carries the failing step + the expected-vs-observed DIFF.
 */

import { appendFileSync, readFileSync } from "node:fs";

export interface RunRecord {
  /** The scenario name (its defect class). */
  scenario: string;
  verdict: "PASS" | "FAIL";
  /** 0-based index of the step that failed (FAIL only). */
  failedStep?: number;
  /** The expected-vs-last-observed DIFF (FAIL only). */
  diff?: string;
  /** Caller-supplied timestamp (injectable — the runner passes a clock value). */
  at?: string;
  /** Wall-clock-independent run duration in ms, if the caller measured one. */
  durationMs?: number;
  /**
   * 51-04 container-mode: the testbed image manifest identity the run executed
   * against (the manifest digest), so runs are comparable across image versions.
   * ABSENT in host-mode — the row is byte-identical to the pre-51-04 ledger.
   */
  imageId?: string;
}

/** Append one run record as a JSON line. Append-only; creates the file if absent. */
export function appendRunRecord(ledgerPath: string, record: RunRecord): void {
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

/** Read all run records. A missing ledger yields an empty list (no throw). */
export function readRunRecords(ledgerPath: string): RunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunRecord);
}
