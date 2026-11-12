// One process listing shared by every agent checked in one observation pass.
//
// A poll that checks several agents one after another used to start its own process listing for each agent, and
// each agent's identity proof needs two listings (`verifyCodexPaneProcess`, `verifyPaneIdleShell`: the second
// must see a later table than the first). This pass lets agents share a listing only when each agent still gets
// what its own call sequence needs:
//   - ORDER: an agent's next listing must START after the listing it last received had FINISHED, so its two
//     samples are two observations, never one table read twice. A later agent may start from a listing an earlier
//     agent already took, but its next listing must START after its own first check began: tables taken before
//     that point cannot show a change that happened since.
//   - FRESHNESS: a listing older than `freshnessMs` is never reused (the same limit ProcessCensus uses).
//   - HONEST FAILURE: a failed listing is never reused and never counts as success. Each agent that was
//     waiting on it falls back to its own read, and that read's failure is the agent's failure. "Failed" means
//     the shared lister REJECTED: an empty array is a legitimate success and is never read as a failure, so the
//     shared lister must reject on a failed enumeration (the lenient listers that return [] cannot be shared).
//   - SCOPE: a pass belongs to one poll. The next poll builds a new pass, so it starts with a fresh listing.
// Listings are kept per underlying lister, because different listers return different rows.

const DEFAULT_FRESHNESS_MS = 2_000;

type Lister<Row> = () => Row[] | Promise<Row[]>;

interface Listing<Row> {
  readonly startedSeq: number;
  readonly startedAt: number;
  doneSeq: number | null;
  failed: boolean;
  readonly rows: Promise<Row[]>;
}

export interface ObservationPassOpts {
  freshnessMs?: number;
  now?: () => number;
}

export class ObservationPass {
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private seq = 0;
  private readonly listings = new Map<Lister<never>, Listing<never>[]>();

  constructor(opts: ObservationPassOpts = {}) {
    this.freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.now = opts.now ?? Date.now;
  }

  /** A lister for ONE agent's checks in this pass. Create one per agent, never share it between agents: it
   *  remembers when its first check began and when its last listing finished. `base` is the shared listing and must reject when it fails;
   *  `fallback` is the agent's own read after a failed shared listing (default: `base`), so an agent keeps the
   *  failure behavior it has without a pass. */
  lister<Row>(base: Lister<Row>, fallback: Lister<Row> = base): Lister<Row> {
    let lastDoneSeq = 0;
    let firstCallSeq: number | null = null;
    return async () => {
      const afterSeq = firstCallSeq === null ? 0 : Math.max(lastDoneSeq, firstCallSeq);
      firstCallSeq ??= ++this.seq;
      const listing = this.listingFor(base, afterSeq);
      try {
        const rows = await listing.rows;
        lastDoneSeq = Math.max(lastDoneSeq, listing.doneSeq ?? ++this.seq);
        return rows;
      } catch {
        // The shared listing failed: this agent reads for itself, and that read's own failure stands.
        try {
          return await fallback();
        } finally {
          lastDoneSeq = ++this.seq;
        }
      }
    };
  }

  private listingFor<Row>(base: Lister<Row>, afterSeq: number): Listing<Row> {
    const all = (this.listings.get(base as Lister<never>) ?? []) as Listing<Row>[];
    const now = this.now();
    const usable = [...all].reverse().find((l) => !l.failed && l.startedSeq > afterSeq && now - l.startedAt <= this.freshnessMs);
    if (usable) return usable;
    const listing: Listing<Row> = {
      startedSeq: ++this.seq,
      startedAt: now,
      doneSeq: null,
      failed: false,
      rows: undefined as unknown as Promise<Row[]>,
    };
    (listing as { rows: Promise<Row[]> }).rows = new Promise<Row[]>((resolve) => resolve(base())).then(
      (rows) => {
        listing.doneSeq = ++this.seq;
        return rows;
      },
      (err) => {
        listing.failed = true;
        listing.doneSeq = ++this.seq;
        throw err;
      },
    );
    this.listings.set(base as Lister<never>, [...all.filter((l) => !l.failed), listing] as Listing<never>[]);
    return listing;
  }
}
