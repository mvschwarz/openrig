import type { NativeProcessRow } from "./native-process-lineage.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";

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
  rootPid: number;
  rootStartedAt: string;
  processes: Array<BackgroundProcess & { commandDigest: string }>;
}

function digest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function executableName(command: string): string {
  const name = basename(command.trim().split(/\s+/, 1)[0] ?? "");
  return /^[a-zA-Z0-9._+-]{1,128}$/.test(name) ? name : "unknown";
}

/**
 * Retain only descendants observed under a verified live pane. A later census can
 * re-identify these processes after reparenting; it cannot reveal work that was
 * never sampled. The caller must verify the binding and occupant before and
 * after the census, and clear or replace the sample on generation change.
 */
export class BackgroundProcessEvidence {
  private readonly samples = new Map<string, SeatSample>();

  capture(nodeId: string, generation: string, sessionId: string, pane: string, panePid: number, rows: NativeProcessRow[], observedAt = Date.now(), currentRows = rows): void {
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (byPid.size !== rows.length || !byPid.get(panePid)?.startedAt) {
      this.samples.delete(nodeId);
      return;
    }
    const children = new Map<number, NativeProcessRow[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const seen = new Set<number>([panePid]);
    const queue = [panePid];
    const liveByPid = new Map(currentRows.map(row => [row.pid, row]));
    if (liveByPid.size !== currentRows.length) { this.samples.delete(nodeId); return; }
    const rootStartedAt = byPid.get(panePid)!.startedAt!;
    const prior = this.samples.get(nodeId);
    const processes: SeatSample["processes"] = prior && prior.generation === generation && prior.sessionId === sessionId && prior.pane === pane
      && prior.rootPid === panePid && prior.rootStartedAt === rootStartedAt
      ? prior.processes.filter(process => {
          const current = liveByPid.get(process.pid);
          return current?.startedAt === process.startedAt && digest(current.command) === process.commandDigest && current.state !== "Z";
        })
      : [];
    while (queue.length) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        queue.push(child.pid);
        // lstart has one-second precision. Do not use a newborn process as identity evidence.
        const startMs = Date.parse(child.startedAt ?? "");
        if (child.startedAt && Number.isFinite(startMs) && observedAt - startMs >= 2000 && child.state !== "Z") {
          if (!processes.some(process => process.pid === child.pid)) {
            processes.push({ pid: child.pid, startedAt: child.startedAt, command: executableName(child.command), commandDigest: digest(child.command) });
          }
        }
      }
    }
    this.samples.set(nodeId, { generation, sessionId, pane, rootPid: panePid, rootStartedAt, processes });
  }

  /** Preserve unknown even when some processes match: unsampled descendants may also exist. */
  afterLoss(nodeId: string, generation: string, sessionId: string, pane: string, rows: NativeProcessRow[]): BackgroundProcess[] {
    const sample = this.samples.get(nodeId);
    if (!sample || sample.generation !== generation || sample.sessionId !== sessionId || sample.pane !== pane) return [];
    const current = new Map(rows.map(row => [row.pid, row]));
    if (current.size !== rows.length) return [];
    return sample.processes.filter(previous => {
      const row = current.get(previous.pid);
      return row?.startedAt === previous.startedAt && digest(row.command) === previous.commandDigest && row.state !== "Z";
    }).map(({ commandDigest: _digest, ...process }) => process);
  }

  forget(nodeId: string): void { this.samples.delete(nodeId); }
  has(nodeId: string): boolean { return this.samples.has(nodeId); }
  retain(nodeIds: ReadonlySet<string>): void {
    for (const nodeId of this.samples.keys()) if (!nodeIds.has(nodeId)) this.samples.delete(nodeId);
  }
}
