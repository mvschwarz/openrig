// OPR.0.4.6.02 C2 — the terminal-views store.
//
// SAVED views persist to `terminal-views.yaml` at the OPENRIG_HOME root
// (VM-isolatable via OPENRIG_HOME). They are write-once/read-at-launch: the
// daemon reads them at launch and the operator's saved layouts survive
// restarts. Each saved member carries a STRUCTURED `host` field (a host id,
// never a `member@rig@host` string — MH BR-1).
//
// DERIVED views (per-rig / per-mission / per-slice) are computed LIVE from the
// live seat inventory + the review agents band and are NEVER written to disk
// (A3). That invariant is structural, not conventional: this module exposes
// `deriveViewMembers` (a pure mapper) and a `save()` that only ever accepts a
// `SavedView` — there is no code path that persists a derived view.
//
// Writes are atomic (tmp + rename on the same filesystem) and byte-stable:
// serialization uses a fixed field order and OMITS absent optionals (never
// null), so a read→save round-trip of the same logical content is idempotent.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import type { ViewMemberInput } from "./view-composer.js";

/** One persisted member of a saved view. Optionals are omitted-when-absent on write. */
export interface SavedViewMember {
  /** Canonical session name of the seat. */
  seat: string;
  /** Pane label — `<agent> · <slice>`. */
  label?: string;
  /** Structured host id (never a `member@rig@host` string). Omitted for a local seat. */
  host?: string;
  /** The tmux session to attach to. */
  tmuxSession?: string;
  /** View-only / read-only attach. Omitted (defaults false) when not read-only. */
  readOnly?: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  members: SavedViewMember[];
}

export interface TerminalViewsFile {
  version: 1;
  views: SavedView[];
}

const EMPTY_FILE: TerminalViewsFile = { version: 1, views: [] };

/** Build a member object in fixed key order, omitting absent optionals (never null). */
function normalizeMember(m: SavedViewMember): SavedViewMember {
  const out: SavedViewMember = { seat: m.seat };
  if (m.label != null && m.label !== "") out.label = m.label;
  if (m.host != null && m.host !== "") out.host = m.host;
  if (m.tmuxSession != null && m.tmuxSession !== "") out.tmuxSession = m.tmuxSession;
  if (m.readOnly === true) out.readOnly = true;
  return out;
}

function normalizeView(v: SavedView): SavedView {
  return { id: v.id, name: v.name, members: v.members.map(normalizeMember) };
}

/** Canonical byte-stable serialization of the whole file (fixed order, omit-when-absent). */
function serialize(file: TerminalViewsFile): string {
  const normalized: TerminalViewsFile = {
    version: 1,
    views: file.views.map(normalizeView),
  };
  return stringifyYaml(normalized);
}

export class TerminalViewsStore {
  constructor(private readonly path: string = getDefaultOpenRigPath("terminal-views.yaml")) {}

  /** The resolved on-disk path (useful for tests / diagnostics). */
  getPath(): string {
    return this.path;
  }

  /**
   * Read-at-launch. An absent file yields the empty set. A malformed file
   * throws (honest — never a silent reset that would discard operator layouts).
   */
  read(): TerminalViewsFile {
    if (!existsSync(this.path)) return { version: 1, views: [] };
    const raw = readFileSync(this.path, "utf-8");
    const parsed = parseYaml(raw) as unknown;
    if (parsed == null) return { version: 1, views: [] };
    if (typeof parsed !== "object") {
      throw new Error(`terminal views file at ${this.path} must be a YAML object with a 'views' array`);
    }
    const obj = parsed as Record<string, unknown>;
    const views = obj["views"];
    if (!Array.isArray(views)) {
      throw new Error(`terminal views file at ${this.path}: 'views' must be an array`);
    }
    return { version: 1, views: views as SavedView[] };
  }

  list(): SavedView[] {
    return this.read().views;
  }

  get(id: string): SavedView | null {
    return this.read().views.find((v) => v.id === id) ?? null;
  }

  /**
   * Persist a SAVED view (upsert by id). Atomic (tmp + rename) and byte-stable.
   * Returns the resulting file. Only accepts `SavedView` — a derived view can
   * never reach disk through this path (A3).
   */
  save(view: SavedView): TerminalViewsFile {
    const current = this.read();
    const idx = current.views.findIndex((v) => v.id === view.id);
    const next: SavedView[] = [...current.views];
    if (idx >= 0) next[idx] = view;
    else next.push(view);
    const file: TerminalViewsFile = { version: 1, views: next };
    this.writeAtomic(file);
    return { version: 1, views: file.views.map(normalizeView) };
  }

  /** Remove a saved view by id (idempotent). Atomic. */
  remove(id: string): TerminalViewsFile {
    const current = this.read();
    const file: TerminalViewsFile = {
      version: 1,
      views: current.views.filter((v) => v.id !== id),
    };
    this.writeAtomic(file);
    return { version: 1, views: file.views.map(normalizeView) };
  }

  private writeAtomic(file: TerminalViewsFile): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, serialize(file), "utf-8");
    renameSync(tmp, this.path);
  }
}

// --- Derived views (computed LIVE, never persisted — A3) ---

/**
 * The minimal structural shape of a live seat row the derived-view mapper
 * needs. Deliberately a subset (not an import of `NodeInventoryEntry`) so this
 * module stays free of the inventory's transitive deps and is trivially
 * testable. Field names match `NodeInventoryEntry`.
 */
export interface LiveSeatRow {
  canonicalSessionName: string | null;
  /** "tmux" for tmux-backed seats; other kinds have no attachable pane. */
  attachmentType: string | null;
  /** The tmux session name (canonical session name for tmux-backed seats). */
  tmuxSession?: string | null;
  rigName?: string | null;
  logicalId?: string | null;
}

/** Options controlling how a derived view labels/scopes its members. */
export interface DeriveOptions {
  /** Structured host id to stamp on every derived member (remote scope); omit for local. */
  host?: string | null;
  /** When true, members attach read-only (`-r`) — cross-rig / view-only derived scopes. */
  readOnly?: boolean;
  /** Slice/mission label suffix for the pane label (`<agent> · <slice>`); optional. */
  labelSuffix?: string;
}

/**
 * Map a live seat inventory into composer-ready members. PURE and IN-MEMORY —
 * the result is handed straight to `composeView`; it is NEVER written to the
 * saved-views file. Non-tmux / session-less rows are dropped from the derived
 * set (a derived view only tiles attachable seats; saved views name absents).
 */
export function deriveViewMembers(
  rows: LiveSeatRow[],
  opts: DeriveOptions = {},
): ViewMemberInput[] {
  const members: ViewMemberInput[] = [];
  for (const row of rows) {
    if (row.attachmentType !== "tmux") continue;
    const seat = row.canonicalSessionName;
    if (!seat) continue;
    const tmuxSession = row.tmuxSession ?? row.canonicalSessionName;
    const agent = row.logicalId ?? seat;
    const label = opts.labelSuffix ? `${agent} · ${opts.labelSuffix}` : agent;
    members.push({
      seat,
      label,
      tmuxSession,
      host: opts.host ?? null,
      readOnly: opts.readOnly === true,
      // Derived views are live: presence in the inventory IS the liveness
      // signal for the derived set; a stricter has-session probe layers on at
      // compose time for local members if the caller supplies one.
      alive: true,
    });
  }
  return members;
}
