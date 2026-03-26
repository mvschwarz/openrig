import type { TmuxDiscoveryScanner } from "./tmux-discovery-scanner.js";
import type { SessionFingerprinter } from "./session-fingerprinter.js";
import type { SessionEnricher } from "./session-enricher.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { DiscoveredSession } from "./discovery-types.js";
interface ManagedBinding {
  tmuxSession: string | null;
  tmuxPane: string | null;
}

interface DiscoveryCoordinatorDeps {
  scanner: TmuxDiscoveryScanner;
  fingerprinter: SessionFingerprinter;
  enricher: SessionEnricher;
  discoveryRepo: DiscoveryRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
}

/**
 * Orchestrates the full discovery pipeline:
 * scan → filter managed → fingerprint → enrich → persist → vanish detection → events
 */
export class DiscoveryCoordinator {
  private deps: DiscoveryCoordinatorDeps;

  constructor(deps: DiscoveryCoordinatorDeps) {
    this.deps = deps;
  }

  /** Run a single discovery scan cycle. */
  async scanOnce(): Promise<DiscoveredSession[]> {
    // 1. Scan tmux
    const scanResult = await this.deps.scanner.scan();

    // 2. Build managed session filter (two-level)
    const managedBindings = this.getManagedBindings();
    const managedSessions = new Set<string>();    // session-level: all panes managed
    const managedPanes = new Set<string>();        // pane-level: specific pane managed
    for (const binding of managedBindings) {
      if (binding.tmuxSession) {
        if (binding.tmuxPane) {
          managedPanes.add(`${binding.tmuxSession}:${binding.tmuxPane}`);
        } else {
          managedSessions.add(binding.tmuxSession);
        }
      }
    }

    // Also filter out already-claimed sessions
    const claimedSessions = this.deps.discoveryRepo.listDiscovered("claimed");
    const claimedPanes = new Set(claimedSessions.map((s) => `${s.tmuxSession}:${s.tmuxPane}`));

    // 3. Refresh cmux signals for batch fingerprinting
    await this.deps.fingerprinter.refreshCmuxSignals();

    // 4. Process each scanned pane
    const seenIds = new Set<string>();
    const newDiscoveries: DiscoveredSession[] = [];

    for (const pane of scanResult.panes) {
      // Filter: session-level managed
      if (managedSessions.has(pane.tmuxSession)) continue;
      // Filter: pane-level managed
      if (managedPanes.has(`${pane.tmuxSession}:${pane.tmuxPane}`)) continue;
      // Filter: already claimed
      if (claimedPanes.has(`${pane.tmuxSession}:${pane.tmuxPane}`)) continue;

      // Fingerprint
      const fp = await this.deps.fingerprinter.fingerprint(pane);

      // Enrich
      const enrichment = this.deps.enricher.enrich(pane.cwd);

      // Check if this is a new discovery or rescan
      const existing = this.deps.discoveryRepo.getByTmuxIdentity(pane.tmuxSession, pane.tmuxPane);
      const isNew = !existing;

      // Upsert
      const session = this.deps.discoveryRepo.upsertDiscoveredSession({
        tmuxSession: pane.tmuxSession,
        tmuxPane: pane.tmuxPane,
        tmuxWindow: pane.tmuxWindow,
        pid: pane.pid ?? undefined,
        cwd: pane.cwd ?? undefined,
        activeCommand: pane.activeCommand ?? undefined,
        runtimeHint: fp.runtimeHint,
        confidence: fp.confidence,
        evidenceJson: JSON.stringify(fp.evidence),
        configJson: JSON.stringify(enrichment.raw),
      });

      seenIds.add(session.id);

      if (isNew) {
        newDiscoveries.push(session);
        this.deps.eventBus.emit({
          type: "session.discovered",
          discoveredId: session.id,
          tmuxSession: pane.tmuxSession,
          tmuxPane: pane.tmuxPane,
          runtimeHint: fp.runtimeHint,
          confidence: fp.confidence,
        });
      }
    }

    // 5. Vanish detection: active sessions not in current scan
    const previousActiveIds = this.deps.discoveryRepo.getActiveIds();
    const vanishedIds = previousActiveIds.filter((id) => !seenIds.has(id));

    if (vanishedIds.length > 0) {
      // Get session details before marking vanished (for events)
      for (const id of vanishedIds) {
        const session = this.deps.discoveryRepo.getDiscoveredSession(id);
        if (session) {
          this.deps.eventBus.emit({
            type: "session.vanished",
            tmuxSession: session.tmuxSession,
            tmuxPane: session.tmuxPane ?? "",
          });
        }
      }
      this.deps.discoveryRepo.markVanished(vanishedIds);
    }

    // 6. Return all currently active discovered sessions
    return this.deps.discoveryRepo.listDiscovered("active");
  }

  private getManagedBindings(): ManagedBinding[] {
    const rows = this.deps.sessionRegistry.db.prepare(
      "SELECT tmux_session, tmux_pane FROM bindings"
    ).all() as Array<{ tmux_session: string | null; tmux_pane: string | null }>;

    return rows.map((r) => ({
      tmuxSession: r.tmux_session,
      tmuxPane: r.tmux_pane,
    }));
  }
}
