// Workflows in Spec Library + Activation Lens v0 — active lens persistence.
//
// PRD § Item 4: lens selection persists daemon-side across daemon
// restarts + browser refresh. The PRD bounce conditions explicitly
// reject ephemeral state.
//
// Implementation: a small JSON file under OPENRIG_HOME/active-workflow
// -lens.json. Same env-var-aware persistence pattern as UI Enhancement
// Pack v0's file-edit-audit JSONL — no new SQLite table, no new
// migration. The file is rewritten atomically on every set so concurrent
// daemons (rare at single-host MVP) don't tear the read.
//
// Single-active-lens invariant: setting a lens replaces any prior
// lens; clearing removes the file entirely. The store does NOT
// validate that the named workflow_spec actually exists in the
// workflow_specs cache — that's an upstream concern at the route
// layer, since the spec might be uncached temporarily during a
// workspace-surface reconciliation cycle and re-appear before the
// next read.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ActiveLens {
  specName: string;
  specVersion: string;
  /** ISO timestamp of the most recent activation; useful for
   *  diagnostics + UI staleness display. */
  activatedAt: string;
}

export interface ActiveLensStoreOpts {
  /** Absolute file path. Should fall under the daemon's OPENRIG_HOME so
   *  the lens stays isolated per host. */
  filePath: string;
  /** Test seam — defaults to () => new Date(). */
  now?: () => Date;
}

export class ActiveLensStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(opts: ActiveLensStoreOpts) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? (() => new Date());
  }

  get(): ActiveLens | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ActiveLens>;
      if (typeof parsed.specName !== "string" || typeof parsed.specVersion !== "string") return null;
      return {
        specName: parsed.specName,
        specVersion: parsed.specVersion,
        activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : this.now().toISOString(),
      };
    } catch {
      // Malformed file → treat as no lens. Operator can `rm` to recover.
      return null;
    }
  }

  set(specName: string, specVersion: string): ActiveLens {
    const lens: ActiveLens = {
      specName,
      specVersion,
      activatedAt: this.now().toISOString(),
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic-ish: write to temp + rename. v0 doesn't fsync (the lens
    // is operator UX state, not an audit-record-keeping invariant —
    // losing it across a hard crash is acceptable; the operator
    // re-clicks Activate).
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(lens));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
      throw err;
    }
    return lens;
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // Already absent — no-op.
    }
  }
}
