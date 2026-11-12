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
  paneIds: string[];
  planId: string;
  createdAt: string;
  phase: RigViewerPhase;
}

export interface TmuxRigViewerRecord {
  kind: "tmux";
  endpoint: string;
  view: string;
  sessionName: string;
  sessionId: string;
  nonce: string;
  windowIds: string[];
  paneIds: string[];
  createdAt: string;
  phase: RigViewerPhase;
}

export type RigViewerRecord = HerdrRigViewerRecord | TmuxRigViewerRecord;

export interface TmuxRigViewerRegistration {
  kind: "tmux";
  view: string;
  sessionName: string;
  sessionId: string;
  nonce: string;
  windowIds: string[];
  paneIds: string[];
  phase?: RigViewerPhase;
}

export interface TmuxRigViewerRetirement {
  kind: "tmux";
  sessionId: string;
  nonce: string;
}

interface JournalFile {
  version: 1;
  entries: Record<string, RigViewerRecord>;
}

const ENDPOINT_FILE_RE = /^[0-9a-f]{64}\.json$/;

export function rigViewerRecordKey(
  record: { kind: "herdr"; workspaceId: string } | { kind: "tmux"; sessionId: string; nonce: string },
): string {
  if (record.kind === "herdr") return `herdr:${record.workspaceId}`;
  return `tmux:${record.sessionId}:${record.nonce}`;
}

export function tmuxEndpointKey(serverArgs: readonly string[]): string {
  return `tmux:${JSON.stringify([...serverArgs])}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(item => typeof item === "string" && item.length > 0);
}

export function parseTmuxRigViewerInput(raw: unknown): TmuxRigViewerRegistration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r["kind"] !== "tmux") return null;
  if (typeof r["view"] !== "string" || !r["view"].startsWith("rig:") || r["view"].length <= 4) return null;
  if (typeof r["sessionName"] !== "string" || !r["sessionName"].trim()) return null;
  if (typeof r["sessionId"] !== "string" || !r["sessionId"].trim()) return null;
  if (typeof r["nonce"] !== "string" || !r["nonce"].trim()) return null;
  if (!isStringArray(r["windowIds"]) || r["windowIds"].length === 0) return null;
  if (!isStringArray(r["paneIds"]) || r["paneIds"].length === 0) return null;
  if (r["phase"] !== undefined && r["phase"] !== "created" && r["phase"] !== "closing") return null;
  return {
    kind: "tmux",
    view: r["view"],
    sessionName: r["sessionName"],
    sessionId: r["sessionId"],
    nonce: r["nonce"],
    windowIds: [...r["windowIds"]],
    paneIds: [...r["paneIds"]],
    phase: (r["phase"] as RigViewerPhase | undefined) ?? "created",
  };
}

export function parseRetireTmuxViewerInput(raw: unknown): TmuxRigViewerRetirement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r["kind"] !== "tmux") return null;
  if (typeof r["sessionId"] !== "string" || !r["sessionId"].trim()) return null;
  if (typeof r["nonce"] !== "string" || !r["nonce"].trim()) return null;
  return { kind: "tmux", sessionId: r["sessionId"], nonce: r["nonce"] };
}

export interface RigViewerEndpointTx {
  setPhase(key: string, phase: RigViewerPhase): boolean;
  remove(key: string): boolean;
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
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<JournalFile>;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)) {
        return { version: 1, entries: { ...parsed.entries } };
      }
      throw new Error(`Invalid rig viewer ledger format in ${file}`);
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
      const parsed = JSON.parse(readFileSync(full, "utf8")) as Partial<JournalFile>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
        continue;
      }
      for (const [key, record] of Object.entries(parsed.entries)) {
        out.push({ endpoint: record.endpoint, key, record });
      }
    }
    return out;
  }
}
