import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { RuntimeAdapter, NodeBinding } from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode } from "./runtime-adapter.js";
import { terminatePaneInPlace } from "./pane-cutover.js";

export interface RuntimeSwitchIntent {
  id: string; node_id: string; canonical_session: string; staging_session: string;
  predecessor_pane: string; successor_pane: string | null;
  predecessor_generation: string; successor_generation: string;
  from_runtime: string; to_runtime: string; phase: "preparing" | "committed";
}

/** No authority is inferred from a helper name. An interrupted pre-commit swap
 * goes back to the incumbent; an atomic committed switch only finishes forward.
 * Keep the intent whenever ownership or delivery is uncertain. */
export async function recoverRuntimeSwitch(
  db: Database.Database, tmux: TmuxAdapter, intent: RuntimeSwitchIntent,
  adapters?: Record<string, RuntimeAdapter>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<{ complete: boolean; message?: string }> {
  const guard = tmux.deliveryGuard;
  try {
    if (guard && !guard.ownsLifecycle(intent.node_id)) {
      return await guard.lifecycle([intent.node_id], () => recoverRuntimeSwitch(db, tmux, intent, adapters, sleep));
    }
    const current = db.prepare(`SELECT n.runtime, n.cwd, b.tmux_session AS session, b.tmux_pane AS pane,
      (SELECT generation_uuid FROM occupant_tenures WHERE node_id=n.id ORDER BY generation_ordinal DESC LIMIT 1) AS generation
      FROM nodes n JOIN bindings b ON b.node_id=n.id WHERE n.id=?`).get(intent.node_id) as
      { runtime: string; cwd: string; session: string; pane: string; generation: string } | undefined;
    const canonicalProbe = await tmux.probeSession(intent.canonical_session);
    const staging = await tmux.probeSession(intent.staging_session);
    if (![canonicalProbe.state, staging.state].every(state => state === "present" || state === "absent")) {
      throw new Error("Session liveness is unknown; recovery did not assume absence.");
    }
    // A host restart can remove both processes. The saved configuration is
    // already authoritative; don't let a dead intent block its normal restore.
    if (canonicalProbe.state === "absent" && staging.state === "absent") {
      db.prepare("DELETE FROM seat_runtime_switches WHERE id=?").run(intent.id);
      return { complete: true };
    }
    const canonical = await tmux.listPanes(intent.canonical_session);
    if (canonical.length !== 1) throw new Error("Canonical pane membership cannot be established.");
    if (staging.state === "absent" && current?.session === intent.canonical_session && current.pane === canonical[0]!.id
      && current.pane !== intent.predecessor_pane && current.pane !== intent.successor_pane
      && current.generation !== intent.predecessor_generation && current.generation !== intent.successor_generation) {
      // An explicit fresh launch has already superseded this interrupted
      // switch. Never send an old activation packet to that later occupant.
      db.prepare("DELETE FROM seat_runtime_switches WHERE id=?").run(intent.id);
      return { complete: true };
    }
    const committed = intent.phase === "committed";
    if (!current || current.session !== intent.canonical_session
      || current.generation !== (committed ? intent.successor_generation : intent.predecessor_generation)
      || current.runtime !== (committed ? intent.to_runtime : intent.from_runtime)
      || current.pane !== (committed ? intent.successor_pane : intent.predecessor_pane)) {
      throw new Error("Seat ownership changed after the runtime-switch intent; recovery left both sessions alone.");
    }
    if (staging.state === "present") {
      const panes = await tmux.listPanes(intent.staging_session);
      const pane = panes.length === 1 ? panes[0]!.id : null;
      if (!pane) throw new Error("Staging session no longer has its single owned pane.");
      const swapped = canonical[0]!.id === intent.successor_pane && pane === intent.predecessor_pane;
      const unswapped = canonical[0]!.id === intent.predecessor_pane
        && (intent.successor_pane === null || pane === intent.successor_pane);
      if (committed ? !swapped : !swapped && !unswapped) throw new Error("Pane identities disagree with the saved cutover; no process was touched.");
      const adopted = await tmux.recoverRuntimeSwitchSession({ nodeId: intent.node_id, session: intent.staging_session,
        pane, generation: intent.successor_generation });
      if (!adopted.ok) throw new Error(adopted.message);
      if (!committed && swapped) {
        const rolledBack = await tmux.swapRuntimeSwitchPanes({ nodeId: intent.node_id, session: intent.staging_session,
          canonicalSession: intent.canonical_session, canonicalPane: intent.successor_pane!, stagedPane: intent.predecessor_pane });
        if (!rolledBack.ok) throw new Error(rolledBack.message);
      }
      // Only after commit may the predecessor be retired. Before commit this
      // helper contains only the failed candidate (after a rollback if needed).
      const retired = await terminatePaneInPlace(tmux, intent.staging_session,
        { pollMs: 100, timeoutMs: 3000, sleep }, committed ? "Predecessor" : "Uncommitted successor");
      if (!retired.ok) throw new Error(retired.message);
      const removed = await tmux.killSession(intent.staging_session);
      if (!removed.ok && removed.code !== "session_not_found") throw new Error(removed.message);
    } else if (canonical[0]!.id !== current.pane) {
      throw new Error("The staged session is absent but the canonical pane disagrees with the committed binding.");
    }
    if (committed) {
      const environment = await tmux.setRuntimeSwitchEnvironment(intent.canonical_session, intent.to_runtime, intent.successor_generation);
      if (!environment.ok) throw new Error(environment.message);
      // Startup first repairs physical custody before reconciliation. It calls
      // again with adapters once native readiness probes have been constructed.
      if (!adapters) return { complete: false, message: "Runtime switch committed; activation awaits runtime readiness." };
      const adapter = adapters[intent.to_runtime];
      if (!adapter) throw new Error("Target runtime adapter is unavailable for activation.");
      const binding: NodeBinding = { id: "", nodeId: intent.node_id, tmuxSession: intent.canonical_session,
        tmuxPane: intent.successor_pane, tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null,
        updatedAt: "", cwd: current.cwd, launchGeneration: intent.successor_generation };
      // The handover itself can still be processing after cutover. Give that
      // turn a bounded chance to settle before retaining a recovery intent.
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const result = await adapter.checkReady(binding);
        if (result.ready) { ready = true; break; }
        if (isAttentionRequiredReadinessCode(result.code)) break;
        await sleep(500);
      }
      if (!ready) throw new Error("Successor is not ready for activation; no text was sent.");
      const sent = await tmux.sendText(intent.canonical_session,
        `OpenRig runtime switch ${intent.id} is committed. Your generation ${intent.successor_generation} now owns ${intent.canonical_session}; the predecessor has retired. Continue from the handover context, refresh rig queue list --owned, and retain existing claims. This is an idempotent activation reminder: do not duplicate work already started.`);
      if (!sent.ok) throw new Error(sent.message);
      await sleep(200);
      const submit = await tmux.sendKeys(intent.canonical_session, ["Enter"]);
      if (!submit.ok) throw new Error(submit.message);
    }
    db.prepare("DELETE FROM seat_runtime_switches WHERE id=?").run(intent.id);
    return { complete: true };
  } catch (error) {
    return { complete: false, message: (error as Error).message };
  } finally {
    tmux.finishLaunchBinding(intent.staging_session);
  }
}

export async function recoverRuntimeSwitches(db: Database.Database, tmux: TmuxAdapter, adapters?: Record<string, RuntimeAdapter>): Promise<string[]> {
  const warnings: string[] = [];
  const intents = db.prepare("SELECT * FROM seat_runtime_switches").all() as RuntimeSwitchIntent[];
  for (const intent of intents) {
    const result = await recoverRuntimeSwitch(db, tmux, intent, adapters);
    if (!result.complete && (adapters || intent.phase === "preparing")) warnings.push(`${intent.canonical_session}: ${result.message}`);
  }
  return warnings;
}
