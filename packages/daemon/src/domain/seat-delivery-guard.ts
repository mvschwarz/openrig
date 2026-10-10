import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { composerContainsOwnedText, ownCollapsedPaste, type ComposerInput, type ComposerOwnership } from "./composer-prompts.js";

/** A binding is captured before waiting. Never rebind an old operation to a new occupant. */
export interface GuardTarget {
  nodeId: string;
  session: string;
  occupant: string | null;
  pane: string | null;
}

interface Lease {
  target: GuardTarget;
  active: boolean;
  origin: "automatic" | "human";
  lifecycle?: boolean;
  freshLifecyclePane?: string;
  config?: TypingGuardConfig;
  humanEpoch: number;
  inputFrame?: string;
  staged?: { text: string; collapsedPaste: string | null };
}

export class DeliveryGuardError extends Error {
  constructor(readonly code: string, message: string) { super(message); }

  // Hono's error protocol also preserves this typed refusal on lifecycle routes.
  getResponse(): Response {
    return Response.json({ ok: false, code: this.code, error: this.message }, { status: 409 });
  }
}

export interface GuardPreference {
  nodeId: string;
  desired: boolean;
  effective: boolean;
  pending: boolean;
  desiredMode: TypingGuardMode;
  effectiveMode: TypingGuardMode;
}

export const TYPING_GUARD_MODES = ["off", "draft-aware", "hold"] as const;
export type TypingGuardMode = (typeof TYPING_GUARD_MODES)[number];
export interface TypingGuardSettings { mode: TypingGuardMode }
export interface TypingGuardConfig extends TypingGuardSettings { revision: string }
const DEFAULT_GUARD: TypingGuardConfig = { mode: "off", revision: "legacy-off" };

export function parseTypingGuardSettings(value: unknown): TypingGuardSettings {
  const input = typeof value === "boolean" ? { mode: value ? "hold" : "off" } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DeliveryGuardError("invalid_typing_guard", "Supply an enabled boolean or a typing-guard mode.");
  const config = input as Record<string, unknown>;
  if (!(TYPING_GUARD_MODES as readonly unknown[]).includes(config.mode)) throw new DeliveryGuardError("invalid_typing_guard", "mode must be off, draft-aware or hold.");
  if (config.holdSeconds !== undefined || config.maxAttempts !== undefined) throw new DeliveryGuardError("invalid_typing_guard", "Draft-aware sends return their result immediately; retry settings are not supported.");
  return { mode: config.mode as TypingGuardMode };
}

function storedGuard(raw: string | null | undefined, enabled: number): TypingGuardConfig {
  if (!raw) return { ...DEFAULT_GUARD, mode: enabled ? "hold" : "off", revision: enabled ? "legacy-hold" : "legacy-off" };
  const value = JSON.parse(raw) as Record<string, unknown>;
  const settings = parseTypingGuardSettings({ mode: value.mode });
  if (typeof value.revision !== "string" || !value.revision) throw new DeliveryGuardError("invalid_typing_guard", "Stored guard configuration has no revision.");
  return { ...settings, revision: value.revision };
}

/** One serialization domain for preference activation, delivery and writing lifecycle.
 * No timer drains held messages. Async context carries a lease through nested adapters;
 * active=false prevents a detached task from retaining permission after its operation ends.
 */
export class SeatDeliveryGuard {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly scope = new AsyncLocalStorage<Map<string, Lease>>();
  private readonly humanLeases = new Set<Lease>();
  private readonly humanEpochs = new Map<string, number>();
  private inspectInput?: (target: GuardTarget, owned?: ComposerOwnership) => Promise<ComposerInput | null>;
  private inputAbsent?: (target: GuardTarget) => Promise<boolean>;
  private readonly hasModeConfig: boolean;

  constructor(
    readonly db: Database.Database,
    private readonly resolve: (target: string) => GuardTarget | null,
  ) {
    this.hasModeConfig = (db.prepare("PRAGMA table_info(seat_delivery_guards)").all() as Array<{ name: string }>).some(c => c.name === "desired_config");
  }

  attachInputInspection(inspect: (target: GuardTarget, owned?: ComposerOwnership) => Promise<ComposerInput | null>, absent: (target: GuardTarget) => Promise<boolean>): void {
    this.inspectInput = inspect;
    this.inputAbsent = absent;
  }

  /** Startup-only, before exposing routes or starting writers. A stopped operation cannot
   * retain an in-memory lease. Persisted desired protection applies at the new boundary. */
  recoverActivation(): void {
    this.db.transaction(() => {
      if (this.hasModeConfig) {
        // Old daemons append an audit row even for a same-value 1 -> 1 write.
        // That newer boolean decision supersedes a previously saved mode.
        this.db.prepare(`UPDATE seat_delivery_guards AS g SET desired_config=NULL,effective_config=NULL
          WHERE desired_config IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM seat_delivery_guard_changes c WHERE c.id=(SELECT max(id) FROM seat_delivery_guard_changes WHERE node_id=g.node_id)
              AND c.desired_config=g.desired_config AND c.requested_at=g.changed_at)`).run();
        this.db.prepare(`UPDATE seat_delivery_guards SET desired=CASE WHEN json_extract(desired_config,'$.mode')='off' THEN 0 ELSE 1 END
          WHERE desired_config IS NOT NULL`).run();
      }
      this.db.prepare("UPDATE seat_delivery_guards SET effective = desired WHERE effective != desired").run();
      this.db.prepare("UPDATE seat_delivery_guard_changes SET effective_at = ? WHERE effective_at IS NULL")
        .run(new Date().toISOString());
      if (this.hasModeConfig) {
        this.db.prepare("UPDATE seat_delivery_guards SET effective_config=desired_config WHERE desired_config IS NOT NULL").run();
      }
    })();
  }

  preference(nodeId: string): GuardPreference {
    const { desired, effective } = this.configuration(nodeId);
    return { nodeId, desired: desired.mode === "hold", effective: effective.mode === "hold", pending: desired.revision !== effective.revision,
      desiredMode: desired.mode, effectiveMode: effective.mode };
  }

  configuration(nodeId: string): { desired: TypingGuardConfig; effective: TypingGuardConfig } {
    const row = this.db.prepare("SELECT * FROM seat_delivery_guards WHERE node_id=?").get(nodeId) as
      { desired: number; effective: number; changed_at: string; desired_config?: string | null; effective_config?: string | null } | undefined;
    if (row?.desired_config && this.hasModeConfig) {
      const latest = this.db.prepare("SELECT desired_config,requested_at FROM seat_delivery_guard_changes WHERE node_id=? ORDER BY id DESC LIMIT 1").get(nodeId) as
        { desired_config: string | null; requested_at: string } | undefined;
      if (latest?.desired_config !== row.desired_config || latest.requested_at !== row.changed_at) {
        return { desired: storedGuard(null, row.desired), effective: storedGuard(null, row.effective) };
      }
    }
    return { desired: storedGuard(row?.desired_config, row?.desired ?? 0), effective: storedGuard(row?.effective_config, row?.effective ?? 0) };
  }

  maybeTarget(name: string): GuardTarget | null { return this.resolve(name); }

  target(name: string): GuardTarget {
    const target = this.resolve(name);
    if (!target) throw new DeliveryGuardError("guard_target_unknown", `Cannot establish managed input target ${name}; no input written.`);
    return target;
  }

  private same(a: GuardTarget, b: GuardTarget): boolean {
    return a.nodeId === b.nodeId && a.session === b.session && a.occupant === b.occupant && a.pane === b.pane;
  }

  private async serial<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(nodeId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const tail = before.then(() => done);
    this.tails.set(nodeId, tail);
    await before;
    try { return await fn(); }
    finally { release(); if (this.tails.get(nodeId) === tail) this.tails.delete(nodeId); }
  }

  async set(nodeId: string, value: unknown, actor: string, reason: string, timeoutMs = 2000): Promise<GuardPreference> {
    if (!actor.trim() || !reason.trim()) throw new DeliveryGuardError("guard_reason_required", "Actor and reason are required.");
    const at = new Date().toISOString();
    const { change, desired } = this.db.transaction(() => {
      const old = this.configuration(nodeId);
      const settings = parseTypingGuardSettings(value);
      if (!this.hasModeConfig && settings.mode === "draft-aware") throw new DeliveryGuardError("typing_guard_unavailable", "Draft-aware guard configuration requires the mode schema.");
      const unchanged = settings.mode === old.desired.mode;
      const desired = { ...settings, revision: unchanged ? old.desired.revision : randomUUID() };
      // The legacy bits deliberately fail safe to hold when a daemon without modes opens this DB.
      const args = [nodeId, Number(desired.mode !== "off"), Number(old.effective.mode !== "off"), actor, reason, at];
      if (this.hasModeConfig) {
        this.db.prepare(`INSERT INTO seat_delivery_guards(node_id,desired,effective,actor,reason,changed_at,desired_config,effective_config)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET desired=excluded.desired,actor=excluded.actor,
          reason=excluded.reason,changed_at=excluded.changed_at,desired_config=excluded.desired_config`)
          .run(...args, JSON.stringify(desired), JSON.stringify(old.effective));
      } else {
        this.db.prepare(`INSERT INTO seat_delivery_guards(node_id,desired,effective,actor,reason,changed_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET desired=excluded.desired,actor=excluded.actor,
          reason=excluded.reason,changed_at=excluded.changed_at`).run(...args);
      }
      const audit = [nodeId, Number(desired.mode !== "off"), Number(old.desired.mode !== "off"), Number(old.effective.mode !== "off"), actor, reason, at];
      const change = this.hasModeConfig
        ? this.db.prepare(`INSERT INTO seat_delivery_guard_changes(node_id,desired,previous_desired,previous_effective,actor,reason,requested_at,desired_config)
            VALUES (?,?,?,?,?,?,?,?)`).run(...audit, JSON.stringify(desired)).lastInsertRowid
        : this.db.prepare(`INSERT INTO seat_delivery_guard_changes(node_id,desired,previous_desired,previous_effective,actor,reason,requested_at)
            VALUES (?,?,?,?,?,?,?)`).run(...audit).lastInsertRowid;
      return { change, desired };
    })();
    const activation = this.serial(nodeId, async () => {
      this.db.transaction(() => {
        // Later requests are serialized too. Apply each accepted transition, in order.
        this.db.prepare("UPDATE seat_delivery_guards SET effective = ? WHERE node_id = ?").run(Number(desired.mode !== "off"), nodeId);
        if (this.hasModeConfig) this.db.prepare("UPDATE seat_delivery_guards SET effective_config=? WHERE node_id=?").run(JSON.stringify(desired), nodeId);
        this.db.prepare("UPDATE seat_delivery_guard_changes SET effective_at = ? WHERE id = ?")
          .run(new Date().toISOString(), change);
      })();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([activation, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      return this.preference(nodeId);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** fn must include lifecycle preflight, effects and last write. Retention callbacks
   * execute under this same lease, before any pane capture/paste/submit branch. */
  async operation<T>(name: string, fn: () => Promise<T>, held?: (target: GuardTarget) => Promise<T>): Promise<T> {
    const bound = this.target(name);
    const inherited = this.scope.getStore()?.get(bound.nodeId);
    if (inherited?.active && inherited.target.nodeId === bound.nodeId) {
      this.assertCurrent(name, inherited);
      return fn();
    }
    return this.serial(bound.nodeId, async () => {
      const current = this.target(name);
      if (!this.same(bound, current)) throw new DeliveryGuardError("guard_target_changed", "Input target changed while waiting; no input written.");
      const config = this.configuration(bound.nodeId);
      if (config.desired.mode === "hold" || config.effective.mode === "hold") {
        if (held) return held(bound);
        throw new DeliveryGuardError("typing_guard_enabled", "Automatic input is paused for this seat. Select off or draft-aware mode explicitly before this writing operation.");
      }
      const lease: Lease = { target: bound, active: true, origin: "automatic", humanEpoch: this.humanEpochs.get(bound.nodeId) ?? 0,
        config: config.desired.mode === "draft-aware" ? config.desired : config.effective };
      try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [lease.target.nodeId, lease]]), fn); }
      finally { lease.active = false; }
    });
  }

  ownsLifecycle(nodeId: string): boolean {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) return false;
    this.assertCurrent(nodeId, lease);
    return true;
  }

  /** Multi-seat restore takes leases in stable order before any rig mutation.
   * Nested per-seat launch joins these leases; it must not reacquire them. */
  async lifecycle<T>(nodeIds: string[], fn: () => Promise<T>): Promise<T> {
    const ids = [...new Set(nodeIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const id = ids[index]; if (!id) return fn();
      if (this.ownsLifecycle(id)) return acquire(index + 1);
      return this.operation(id, async () => {
        const lease = this.scope.getStore()!.get(id)!;
        if (lease.config?.mode === "draft-aware") {
          // Only a positively absent input may receive fresh startup/resume writes.
          // An active protected seat requires an explicit guard mode change first.
          const absent = !lease.target.pane || await this.inputAbsent?.(lease.target) === true;
          this.assertCurrent(id, lease);
          if (!absent) throw new DeliveryGuardError("draft_aware_lifecycle", "This active seat uses draft-aware delivery. Select off mode before a writing lifecycle operation; held messages are not replayed.");
        }
        lease.lifecycle = true;
        return acquire(index + 1);
      });
    };
    return acquire(0);
  }

  /** Called only after an intentional lifecycle binding change, under its lease.
   * Ordinary sends cannot adopt a replacement occupant or recycled pane. */
  rebindLifecycle(nodeId: string): void {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) throw new DeliveryGuardError("guard_lease_required", "Binding changes require the complete lifecycle lease.");
    lease.target = this.target(nodeId);
    delete lease.staged;
    delete lease.inputFrame;
  }

  /** Only a successful adapter creation/respawn may exempt its new shell from composer checks. */
  noteFreshLifecyclePane(nodeId: string, pane: string): void {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) throw new DeliveryGuardError("guard_lease_required", "A fresh pane requires its creation lifecycle lease.");
    this.assertCurrent(nodeId, lease);
    lease.freshLifecyclePane = pane;
  }

  private ownsFreshInput(lease: Lease): boolean {
    return !!lease.lifecycle && !!lease.freshLifecyclePane
      && (lease.target.pane === null || lease.target.pane === lease.freshLifecyclePane);
  }

  private assertCurrent(name: string, lease: Lease): void {
    if (!lease.active || !this.same(lease.target, this.target(name))) {
      throw new DeliveryGuardError("guard_target_changed", "Input target/occupant changed; no input written.");
    }
  }

  /** Synchronous final-effect check: no await between this and issuing the write. */
  checkInput(name: string): void {
    const target = this.target(name);
    const lease = this.scope.getStore()?.get(target.nodeId);
    if (!lease) throw new DeliveryGuardError("guard_lease_required", "Input requires an active operation lease.");
    this.assertCurrent(name, lease);
    if (lease.origin === "automatic" && !this.ownsFreshInput(lease) && lease.config?.mode === "draft-aware"
      && lease.humanEpoch !== (this.humanEpochs.get(target.nodeId) ?? 0)) {
      throw new DeliveryGuardError("draft_input_changed", "Human input arrived during this delivery. No further automatic input was written.");
    }
  }

  needsInputCheck(name: string): boolean {
    const target = this.maybeTarget(name);
    if (!target) return false; // Proven private probes have no managed-seat policy.
    const lease = this.scope.getStore()?.get(target.nodeId);
    return !!lease?.active && lease.origin === "automatic" && !this.ownsFreshInput(lease) && lease.config?.mode === "draft-aware";
  }

  /** Called at the paste/key boundary after file and buffer preparation. */
  async beforeInput(name: string, submit = false): Promise<void> {
    if (!this.needsInputCheck(name)) return;
    const target = this.target(name);
    const lease = this.scope.getStore()!.get(target.nodeId)!;
    const owned = submit && lease.staged && lease.inputFrame ? { text: lease.staged.text, frame: lease.inputFrame } : undefined;
    const input = await this.inspectInput?.(target, owned).catch(() => null) ?? null;
    this.checkInput(name);
    if (!input || input.state === "unknown") throw new DeliveryGuardError("draft_input_unknown", "The current input cannot be read. Automatic delivery is held.");
    if (submit) {
      const owned = lease.staged && (composerContainsOwnedText(input, lease.staged.text)
        || !!lease.staged.collapsedPaste && input.cursorAtEnd && input.collapsedPaste === lease.staged.collapsedPaste);
      if (!owned) throw new DeliveryGuardError("draft_input_changed", "The input no longer contains only this delivery's staged text. Enter was not sent.");
    } else if (input.state !== "empty") {
      throw new DeliveryGuardError("draft_input_busy", "The seat has an unsubmitted input. Automatic delivery is held.");
    } else {
      lease.inputFrame = input.frame;
    }
  }

  expectStagedInput(name: string, text: string): void {
    if (!this.needsInputCheck(name)) return;
    const target = this.target(name);
    this.scope.getStore()!.get(target.nodeId)!.staged = { text, collapsedPaste: null };
  }

  async notePasted(name: string, text: string): Promise<void> {
    try {
      if (!this.needsInputCheck(name)) return;
      const target = this.target(name);
      const lease = this.scope.getStore()!.get(target.nodeId)!;
      lease.staged = { text, collapsedPaste: null };
      const input = await this.inspectInput?.(target, lease.inputFrame ? { text, frame: lease.inputFrame } : undefined).catch(() => null) ?? null;
      if (input) lease.staged.collapsedPaste = ownCollapsedPaste(input, text);
    } catch { /* Observation cannot turn a completed paste into a claimed no-write failure. */ }
  }

  noteSubmitted(name: string): void {
    try {
      const target = this.maybeTarget(name);
      const lease = target && this.scope.getStore()?.get(target.nodeId);
      if (lease) lease.staged = undefined;
    } catch { /* Enter already succeeded. */ }
  }

  /** Reconciliation is a synchronous DB transaction, not a nested input operation.
   * Refuse rather than waiting on a sender that could itself be awaiting this call.
   * Pending activation and explicit human input protect the same occupant boundary. */
  reconcileBinding<T>(expected: GuardTarget, commit: () => T): T {
    if (!this.same(expected, this.target(expected.nodeId))) {
      throw new DeliveryGuardError("guard_target_changed", "Reconciliation target changed during observation; retry with current identity.");
    }
    if (this.tails.has(expected.nodeId) || [...this.humanLeases].some(l => l.active && l.target.nodeId === expected.nodeId)) {
      throw new DeliveryGuardError("guard_operation_in_progress", "Seat operation in progress; reconciliation did not change custody. Retry after it finishes.");
    }
    const config = this.configuration(expected.nodeId);
    if (config.desired.mode !== "off" || config.effective.mode !== "off") {
      throw new DeliveryGuardError("typing_guard_enabled", "Reconciliation cannot replace the occupant while typing protection is enabled.");
    }
    return commit();
  }

  async input<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const target = this.target(name);
    const lease = this.scope.getStore()?.get(target.nodeId);
    if (lease?.active) { this.assertCurrent(name, lease); return fn(); }
    return this.operation(name, fn);
  }

  /** Internal broker path only; never an option accepted by the send HTTP route. */
  async humanInput<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const target = this.target(name);
    const humanEpoch = (this.humanEpochs.get(target.nodeId) ?? 0) + 1;
    this.humanEpochs.set(target.nodeId, humanEpoch);
    const lease: Lease = { target, active: true, origin: "human", humanEpoch };
    this.humanLeases.add(lease);
    try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [lease.target.nodeId, lease]]), fn); }
    finally { lease.active = false; this.humanLeases.delete(lease); }
  }
}

/** Current binding, never a latest historical session-name guess. Unbound seats
 * resolve by node/canonical address for preferences and lifecycle preflight.
 * #174: an archived rig can keep a binding to the same session name as a live
 * seat, so unarchived matches win; archived ones count only when nothing else
 * matches. Exactly one match is still required. */
export function resolveGuardTarget(db: Database.Database, name: string): GuardTarget | null {
  const rows = db.prepare(`SELECT n.id AS nodeId,
      coalesce(b.tmux_session, replace(n.logical_id,'.','-') || '@' || r.name) AS session,
      b.tmux_pane AS pane,
      (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id=n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant,
      r.archived_at AS archivedAt
    FROM nodes n JOIN rigs r ON r.id=n.rig_id LEFT JOIN bindings b ON b.node_id=n.id
    WHERE n.id=? OR b.tmux_session=? OR b.tmux_pane=? OR n.logical_id=?
      OR (b.tmux_session IS NULL AND replace(n.logical_id,'.','-') || '@' || r.name=?)`)
    .all(name, name, name, name, name) as Array<GuardTarget & { archivedAt: string | null }>;
  const unarchived = rows.filter((row) => row.archivedAt === null);
  const pool = unarchived.length > 0 ? unarchived : rows;
  if (pool.length !== 1) return null;
  const { archivedAt: _archivedAt, ...target } = pool[0]!;
  return target;
}
