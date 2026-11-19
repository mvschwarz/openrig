import type { NativeProcessRow } from "./native-process-lineage.js";

/** A sampled process identity, not an assertion that all work from the seat was observed. */
export interface BackgroundProcess {
  pid: number;
  command: string;
  startedAt: string;
}

interface SeatSample {
  generation: string;
  sessionId: string;
  pane: string;
  processes: BackgroundProcess[];
}

/**
 * Retain only descendants observed under a verified live pane. A later census can
 * re-identify these processes after reparenting; it cannot reveal work that was
 * never sampled. The caller must verify the binding and occupant before and
 * after the census, and clear or replace the sample on generation change.
 */
export class BackgroundProcessEvidence {
  private readonly samples = new Map<string, SeatSample>();

  capture(nodeId: string, generation: string, sessionId: string, pane: string, panePid: number, rows: NativeProcessRow[]): void {
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (byPid.size !== rows.length || !byPid.get(panePid)?.startedAt) {
      this.samples.delete(nodeId);
      return;
    }
    const children = new Map<number, NativeProcessRow[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const seen = new Set<number>([panePid]);
    const queue = [panePid];
    const processes: BackgroundProcess[] = [];
    while (queue.length) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        queue.push(child.pid);
        if (child.startedAt && child.state !== "Z") processes.push({ pid: child.pid, startedAt: child.startedAt, command: child.command });
      }
    }
    this.samples.set(nodeId, { generation, sessionId, pane, processes });
  }

  /** Preserve unknown even when some processes match: unsampled descendants may also exist. */
  afterLoss(nodeId: string, generation: string, sessionId: string, pane: string, rows: NativeProcessRow[]): BackgroundProcess[] {
    const sample = this.samples.get(nodeId);
    if (!sample || sample.generation !== generation || sample.sessionId !== sessionId || sample.pane !== pane) return [];
    const current = new Map(rows.map(row => [row.pid, row]));
    if (current.size !== rows.length) return [];
    return sample.processes.filter(previous => {
      const row = current.get(previous.pid);
      return row?.startedAt === previous.startedAt && row.command === previous.command && row.state !== "Z";
    });
  }

  forget(nodeId: string): void { this.samples.delete(nodeId); }
}
