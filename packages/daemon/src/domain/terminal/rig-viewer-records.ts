import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RigViewerPhase = "created" | "closing";

export interface HerdrRigViewerRecord {
  kind: "herdr";
  endpoint: string;
  view: string;
  workspaceId: string;
  tabIds: string[];
  tabLabels?: string[];
  paneIds: string[];
  planId: string;
  createdAt: string;
  phase: RigViewerPhase;
}

export type RigViewerRecord = HerdrRigViewerRecord;

interface JournalFile {
  version: 1;
  entries: Record<string, RigViewerRecord>;
}

const ENDPOINT_FILE_RE = /^[0-9a-f]{64}\.json$/;

export class CorruptRigViewerLedgerError extends Error {
  readonly code = "corrupt_ledger" as const;
  constructor(readonly filePath: string, reason: string) {
    super(`Rig-viewer ledger file '${filePath}' is corrupt: ${reason}`);
    this.name = "CorruptRigViewerLedgerError";
  }
}

export function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== expected.length || expectedSet.size !== expected.length) return false;
  for (const id of expectedSet) if (!actualSet.has(id)) return false;
  return true;
}

export function rigViewerRecordKey(record: { kind: "herdr"; workspaceId: string; tabLabels?: readonly string[] }): string {
  if (record.tabLabels && record.tabLabels.length > 0) {
    const labelDigest = createHash("sha256").update(JSON.stringify(record.tabLabels)).digest("hex").slice(0, 12);
    return `herdr:${record.workspaceId}:${labelDigest}`;
  }
  return `herdr:${record.workspaceId}`;
}

export function tmuxEndpointKey(serverArgs: readonly string[]): string {
  return `tmux:${JSON.stringify([...serverArgs])}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(item => typeof item === "string" && item.length > 0);
}

export interface RigViewerEndpointTx {
  setPhase(key: string, phase: RigViewerPhase): boolean;
  remove(key: string): boolean;
}

function isValidRigViewerRecord(raw: unknown): raw is RigViewerRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r["endpoint"] !== "string" || !r["endpoint"]) return false;
  if (typeof r["view"] !== "string" || !r["view"].startsWith("rig:")) return false;
  if (typeof r["createdAt"] !== "string" || !r["createdAt"]) return false;
  if (r["phase"] !== "created" && r["phase"] !== "closing") return false;
  if (r["kind"] === "herdr") {
    if (typeof r["workspaceId"] !== "string" || !r["workspaceId"]) return false;
    if (!isStringArray(r["tabIds"]) || r["tabIds"].length === 0) return false;
    if (!isStringArray(r["paneIds"]) || r["paneIds"].length === 0) return false;
    if (typeof r["planId"] !== "string") return false;
    if (r["tabLabels"] !== undefined && (!Array.isArray(r["tabLabels"]) || !r["tabLabels"].every(item => typeof item === "string"))) return false;
    return true;
  }
  return false;
}

function parseJournalFile(rawText: string, file: string): JournalFile {
  let parsed: Partial<JournalFile>;
  try {
    parsed = JSON.parse(rawText) as Partial<JournalFile>;
  } catch (err) {
    throw new CorruptRigViewerLedgerError(file, err instanceof Error ? err.message : "invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
    throw new CorruptRigViewerLedgerError(file, "expected version 1 object with entries map");
  }
  const entries: Record<string, RigViewerRecord> = {};
  for (const [key, entry] of Object.entries(parsed.entries)) {
    // Historical tmux files remain on disk but grant no new close authority.
    if ((entry as { kind?: string } | null)?.kind === "tmux") continue;
    if (!isValidRigViewerRecord(entry)) {
      throw new CorruptRigViewerLedgerError(file, `invalid record for key '${key}'`);
    }
    entries[key] = entry;
  }
  return { version: 1, entries };
}

/**
 * Per-endpoint ownership ledger for OpenRig-created rig viewers (`rig:<name>`).
 * Serialized per endpoint file; uses in-memory storage when no directory is passed (unit tests).
 */
export class RigViewerLedger {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly memory = new Map<string, JournalFile>();

  constructor(private readonly dir?: string) {}

  private filePath(endpoint: string): string {
    const hash = createHash("sha256").update(endpoint).digest("hex");
    return path.join(this.dir!, `${hash}.json`);
  }

  private readJournal(endpoint: string): JournalFile {
    if (!this.dir) {
      return this.memory.get(endpoint) ?? { version: 1, entries: {} };
    }
    const file = this.filePath(endpoint);
    try {
      return parseJournalFile(readFileSync(file, "utf8"), file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { version: 1, entries: {} };
      }
      throw err;
    }
  }

  private writeJournal(endpoint: string, journal: JournalFile): void {
    if (!this.dir) {
      this.memory.set(endpoint, { version: 1, entries: { ...journal.entries } });
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.filePath(endpoint);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(journal) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  }

  private setPhaseUnlocked(endpoint: string, key: string, phase: RigViewerPhase): boolean {
    const journal = this.readJournal(endpoint);
    const existing = journal.entries[key];
    if (!existing) return false;
    journal.entries[key] = { ...existing, phase };
    this.writeJournal(endpoint, journal);
    return true;
  }

  private removeUnlocked(endpoint: string, key: string): boolean {
    const journal = this.readJournal(endpoint);
    if (!(key in journal.entries)) return false;
    delete journal.entries[key];
    this.writeJournal(endpoint, journal);
    return true;
  }

  runExclusive<T>(endpoint: string, fn: (tx: RigViewerEndpointTx) => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(endpoint) ?? Promise.resolve();
    const tx: RigViewerEndpointTx = {
      setPhase: (key, phase) => this.setPhaseUnlocked(endpoint, key, phase),
      remove: (key) => this.removeUnlocked(endpoint, key),
    };
    const next = prev.catch(() => {}).then(() => fn(tx));
    this.queues.set(endpoint, next);
    return next;
  }

  upsert(record: RigViewerRecord): Promise<void> {
    if (record.kind !== "herdr") return Promise.reject(new Error("Tmux ownership belongs in session options."));
    if (!record.view.startsWith("rig:")) return Promise.resolve();
    return this.runExclusive(record.endpoint, () => {
      const journal = this.readJournal(record.endpoint);
      const key = rigViewerRecordKey(record);
      journal.entries[key] = record;
      this.writeJournal(record.endpoint, journal);
    });
  }

  setPhase(endpoint: string, key: string, phase: RigViewerPhase): Promise<boolean> {
    return this.runExclusive(endpoint, (tx) => tx.setPhase(key, phase));
  }

  remove(endpoint: string, key: string): Promise<boolean> {
    return this.runExclusive(endpoint, (tx) => tx.remove(key));
  }

  listForEndpoint(endpoint: string): Promise<Array<{ key: string; record: RigViewerRecord }>> {
    return this.runExclusive(endpoint, () => {
      const journal = this.readJournal(endpoint);
      return Object.entries(journal.entries).map(([key, record]) => ({ key, record }));
    });
  }

  async listAll(): Promise<Array<{ endpoint: string; key: string; record: RigViewerRecord }>> {
    if (!this.dir) {
      const out: Array<{ endpoint: string; key: string; record: RigViewerRecord }> = [];
      for (const [endpoint, journal] of this.memory) {
        for (const [key, record] of Object.entries(journal.entries)) out.push({ endpoint, key, record });
      }
      return out;
    }
    let files: string[];
    try {
      files = readdirSync(this.dir).filter(name => ENDPOINT_FILE_RE.test(name)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    const out: Array<{ endpoint: string; key: string; record: RigViewerRecord }> = [];
    for (const file of files) {
      const full = path.join(this.dir, file);
      const parsed = parseJournalFile(readFileSync(full, "utf8"), full);
      for (const [key, record] of Object.entries(parsed.entries)) {
        out.push({ endpoint: record.endpoint, key, record });
      }
    }
    return out;
  }
}
