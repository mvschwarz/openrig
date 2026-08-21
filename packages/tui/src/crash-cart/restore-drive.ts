// B1 Atom D — the ⏎ RESTORE EVERYTHING drive. The daemon-down crash-cart's primary
// action: start the daemon (the `s` step), THEN drive the C1 batch conductor
// (POST /api/crash-cart/restore-fleet). Sequenced so the conductor runs against the
// freshly-started daemon. Deps are injected (main.ts supplies real execFile + fetch);
// this keeps the ⏎ drive pure/testable while the full TUI flow is door-test-verified.
export interface RestoreDriveDeps {
  /** Start the daemon (exec `rig daemon start`) — the ⏎ flow's `s` step. */
  startDaemon: () => Promise<void>;
  /** Drive the conductor: POST /api/crash-cart/restore-fleet → the FleetRollup. */
  callRestoreFleet: () => Promise<unknown>;
}

export async function driveRestoreEverything(deps: RestoreDriveDeps): Promise<unknown> {
  await deps.startDaemon(); // the `s` step — bring the daemon up first (throws propagate: no restore on a dead daemon)
  return deps.callRestoreFleet(); // then drive the conductor against the freshly-started daemon
}
