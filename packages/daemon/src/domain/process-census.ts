// OPR.0.5.3.10 — the ONE process census.
//
// The measured collapse (parent incident qitem-20260823031444-cec9cafb; live
// slow-span sample: 171 resume_metadata.list_processes calls, mean 9.39s, max
// 40.31s): every consumer that needed the process table spawned its own
// `ps -Ao` — the model-divergence poll once PER SEAT, the snapshot refresher up
// to eight times PER CODEX SEAT — and under load the spawns stretched, piled
// up, and took the control plane down with them. Process enumeration is a
// GLOBAL read: one census serves every consumer in a cycle.
//
// Contract (mini-req 3):
//   - COALESCE: concurrent callers share one in-flight enumeration.
//   - FRESHNESS: a recent SUCCESSFUL census (within freshnessMs) is reused.
//   - HONEST FAILURE: a failed enumeration rejects every coalesced caller,
//     caches NOTHING, and the next call retries — failure never becomes
//     cached success.
import type { ProcessRow } from "./model-divergence/current-generation-record.js";

export interface ProcessCensusOpts {
  /** The underlying enumeration (default: the shared `ps -Ao` lister). */
  list?: () => Promise<ProcessRow[]>;
  /** Reuse window for a successful census. Default 2000ms. */
  freshnessMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class ProcessCensus {
  private readonly listFn: () => Promise<ProcessRow[]>;
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private inFlight: Promise<ProcessRow[]> | null = null;
  private lastRows: ProcessRow[] | null = null;
  private lastAt = -Infinity;

  constructor(opts: ProcessCensusOpts = {}) {
    this.listFn = opts.list ?? defaultCensusList;
    this.freshnessMs = opts.freshnessMs ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  async list(): Promise<ProcessRow[]> {
    if (this.lastRows && this.now() - this.lastAt <= this.freshnessMs) {
      return this.lastRows;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.listFn().then(
      (rows) => {
        this.lastRows = rows;
        this.lastAt = this.now();
        this.inFlight = null;
        return rows;
      },
      (err) => {
        // Honest failure: nothing cached, next call retries.
        this.inFlight = null;
        throw err;
      },
    );
    return this.inFlight;
  }

  /** A CYCLE-SCOPED lister: at most one census underneath for the closure's
   *  lifetime, lazily fetched (a cycle with nothing to read spawns nothing).
   *  This is the "at most one per poll/tick" guarantee (mini-reqs 1-2) —
   *  stronger than the freshness window, which a slow cycle could outlive. */
  cycleLister(): () => Promise<ProcessRow[]> {
    let cycle: Promise<ProcessRow[]> | null = null;
    return () => (cycle ??= this.list());
  }
}

async function defaultCensusList(): Promise<ProcessRow[]> {
  // r2-B2: the STRICT lister — a failed `ps` must REJECT here so the census's
  // honest-failure path is reachable in production (the lenient variant's []
  // would have been cached as an empty SUCCESS for the freshness window).
  const { defaultListProcessesStrict } = await import("./resume-metadata-refresher.js");
  return defaultListProcessesStrict();
}
