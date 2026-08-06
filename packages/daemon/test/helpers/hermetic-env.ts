/**
 * Slice 51-02 (L2 test-system) — the SHARED hermetic env-discipline helper.
 *
 * The safety keystone of the scenario runner: it makes it impossible for a test
 * to silently run against a live or shared daemon. Built ONCE here, imported by
 * two consumers — the scenario runner and the D-class hermetic-harness hardening
 * intake.
 *
 * This module currently provides the FAIL-CLOSED guard (proof item 4). The
 * scratch HOME/OPENRIG_HOME scaffold + forced-local daemon spawn + injected-clock
 * plumb-through layer on top of this guard (added as subsequent units).
 *
 * Doctrine: a helper that silently falls back to an ambient daemon reproduces the
 * exact D-class hazard this slice exists to kill. Detection is pure, synchronous
 * env inspection — it sends ZERO traffic — and on a foreign target it REFUSES with
 * a hard error NAMING the target. Never a degrade, never a fabrication.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Inherited environment variables that redirect the CLI/daemon client at a
 * daemon TARGET the helper did not create. Presence of any of these in the
 * ambient environment is a foreign-daemon signal → hard refuse.
 *
 * Order is the detection order (first match wins), kept deterministic so the
 * refusal message is stable across runs.
 *
 * Provenance (verified at source, base 13e26355):
 * - OPENRIG_URL / RIGGED_URL   — client base URL (cli/src/client.ts:86, default http://127.0.0.1:7433)
 * - OPENRIG_HOST / RIGGED_HOST — client host override (cli/src/index.test.ts:24-31)
 * - OPENRIG_HOST_SELECTED      — host-selection env half; resolution order
 *     env OPENRIG_HOST_SELECTED > ~/.openrig/config.json (disk) > "local"
 *     (cli/src/host-selection.ts:7). The scratch-HOME layer covers the DISK half;
 *     this guard covers the ENV half — without it a persisted/env selection
 *     silently retargets a remote daemon BEFORE the scratch layer applies
 *     (the documented D-class third leak vector).
 * - OPENRIG_PORT / RIGGED_PORT — client port (cli/src/config-store.ts:343)
 */
export const DAEMON_TARGET_ENV_VARS = [
  "OPENRIG_URL",
  "RIGGED_URL",
  "OPENRIG_HOST",
  "RIGGED_HOST",
  "OPENRIG_HOST_SELECTED",
  "OPENRIG_PORT",
  "RIGGED_PORT",
] as const;

export type DaemonTargetEnvVar = (typeof DAEMON_TARGET_ENV_VARS)[number];

/** A detected foreign daemon target: the offending var name and its value. */
export interface ForeignDaemonTarget {
  name: DaemonTargetEnvVar;
  value: string;
}

/** Hard-refusal error thrown when the ambient env points at a foreign daemon. */
export class HermeticEnvError extends Error {
  readonly foreignTarget: ForeignDaemonTarget;
  constructor(target: ForeignDaemonTarget) {
    super(
      `hermetic env refused: ambient daemon target ${target.name}=${target.value} ` +
        `is present — the scenario runner will NOT run against a daemon it did not ` +
        `create (fail-closed; zero traffic sent). Unset ${target.name} or run under ` +
        `the hermetic scaffold, which spawns its own scenario-local daemon.`,
    );
    this.name = "HermeticEnvError";
    this.foreignTarget = target;
  }
}

type EnvLike = Record<string, string | undefined>;

/**
 * Inspect an environment for an inherited daemon-target var. Returns the FIRST
 * (in DAEMON_TARGET_ENV_VARS order) non-empty match, or null when clean.
 *
 * An exported-but-empty var (e.g. `OPENRIG_URL=`) does not point at a daemon and
 * is treated as absent. Pure and synchronous — no network, no side effects.
 */
export function detectForeignDaemonTarget(
  env: EnvLike = process.env,
): ForeignDaemonTarget | null {
  for (const name of DAEMON_TARGET_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { name, value };
    }
  }
  return null;
}

/**
 * FAIL-CLOSED assertion: throw a named HermeticEnvError if the environment points
 * at a foreign daemon target. Call this BEFORE constructing/dialing any daemon —
 * it is the boundary the D-class census exists to enforce. Sends ZERO traffic.
 */
export function assertNoForeignDaemon(env: EnvLike = process.env): void {
  const foreign = detectForeignDaemonTarget(env);
  if (foreign) {
    throw new HermeticEnvError(foreign);
  }
}

/**
 * The A3-R3 injected-clock env var (OPR.0.5.1.1 items 6-8). The compaction-restore
 * bridge — a GENERAL production hook (real seats, real compactions) — reads it for a
 * deterministic timestamp, falling back to `new Date()` when ABSENT (absence = the
 * production state). A PRESENT clock var in a REAL seat silently FREEZES production
 * compaction-asset stamps: the temporal edition of the silent-retarget class this
 * slice's env-discipline exists to kill. So the hermetic guard hard-refuses an
 * ambient clock var it did NOT set itself (belt); the scaffold sets it ONLY via
 * `injectClockNow`. Named with TEST semantics on purpose — a `TEST` var visible in
 * production reads as obviously wrong.
 */
export const TEST_CLOCK_ENV_VARS = ["OPENRIG_TEST_CLOCK_NOW"] as const;

export type TestClockEnvVar = (typeof TEST_CLOCK_ENV_VARS)[number];

/** A detected ambient injected-clock var: the offending var name and its value. */
export interface AmbientClockHazard {
  name: TestClockEnvVar;
  value: string;
}

/** Hard-refusal error thrown when the ambient env carries an injected-clock var. */
export class AmbientClockHazardError extends Error {
  readonly hazard: AmbientClockHazard;
  constructor(hazard: AmbientClockHazard) {
    super(
      `hermetic env refused: ambient injected-clock ${hazard.name}=${hazard.value} is present — ` +
        `this var freezes compaction-asset timestamps and must NEVER leak into a real seat ` +
        `(temporal silent-retarget). The scaffold sets it only via injectClockNow; a pre-existing ` +
        `value is a leak. Fail-closed; zero traffic sent. Unset ${hazard.name}.`,
    );
    this.name = "AmbientClockHazardError";
    this.hazard = hazard;
  }
}

/**
 * Inspect an environment for an inherited injected-clock var. Returns the first
 * non-empty match, or null when clean. Empty (`OPENRIG_TEST_CLOCK_NOW=`) is absent.
 * Pure and synchronous — no network, no side effects.
 */
export function detectAmbientClockHazard(env: EnvLike = process.env): AmbientClockHazard | null {
  for (const name of TEST_CLOCK_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { name, value };
    }
  }
  return null;
}

/**
 * FAIL-CLOSED assertion: throw AmbientClockHazardError if the environment already
 * carries an injected-clock var. The scaffold sets the clock ONLY via injectClockNow,
 * so a pre-existing value is a leak that would freeze production stamps. Sends ZERO
 * traffic.
 */
export function assertNoAmbientClock(env: EnvLike = process.env): void {
  const hazard = detectAmbientClockHazard(env);
  if (hazard) {
    throw new AmbientClockHazardError(hazard);
  }
}

/**
 * Credential vars scrubbed from the child env alongside the daemon-target vars.
 * Not fail-closed triggers on their own (they carry no target address), but they
 * must never bleed into a scenario-local daemon's environment.
 */
const CREDENTIAL_ENV_VARS = ["OPENRIG_AUTH_BEARER_TOKEN", "RIGGED_AUTH_BEARER_TOKEN"] as const;

/** A per-run hermetic scaffold: scratch dirs + a clean child-process env + teardown. */
export interface HermeticScaffold {
  /** The scaffold root (a fresh temp dir); everything lives INSIDE it. */
  root: string;
  /** Scratch HOME (no real settings/policy/trust bleed in or out). */
  home: string;
  /** Scratch OPENRIG_HOME (operator state, incl. the host-selection config.json disk half). */
  openrigHome: string;
  /** Scratch state dir (the scenario-local daemon's db lives here). */
  stateDir: string;
  /**
   * A CLEAN environment for child processes (the scenario-local daemon + `rig`
   * CLI invocations): the caller's env with daemon-target + credential vars
   * scrubbed and the scratch paths set. A distinct object — never the caller's
   * env nor `process.env`.
   */
  env: Record<string, string | undefined>;
  /** Remove the scaffold root. Idempotent. */
  cleanup(): void;
}

export interface PrepareHermeticEnvOptions {
  /** Base environment to derive the clean child env from. Defaults to process.env. */
  baseEnv?: EnvLike;
  /**
   * The A3-R3 injected clock. When set, the scaffold's child env carries
   * OPENRIG_TEST_CLOCK_NOW = this value (an ISO timestamp) so the compaction bridge
   * stamps deterministically; when omitted, the var stays UNSET and the bridge falls
   * back to real-time `new Date()` (production behavior). This is the ONLY sanctioned
   * way the var is set — a pre-existing one in baseEnv is refused as a leak.
   */
  injectClockNow?: string;
}

/**
 * Build a per-run hermetic scaffold. FAILS CLOSED FIRST: if the base env points at
 * a foreign daemon target, throws HermeticEnvError before creating any scaffold
 * (zero traffic, zero filesystem side effects). Otherwise creates scratch
 * HOME/OPENRIG_HOME/state dirs and returns a CLEAN child-process env with the
 * daemon-target + credential vars scrubbed and the scratch paths set.
 *
 * Does NOT mutate the caller's env object or process.env — the runner process
 * stays as it is; only spawned children receive the scrubbed scratch env. State
 * lives INSIDE the scaffold (the hermeticity lesson).
 *
 * The scratch OPENRIG_HOME covers the DISK half of the host-selection leak vector
 * (~/.openrig/config.json); the fail-closed guard covers the ENV half
 * (OPENRIG_HOST_SELECTED). Together the scaffold cannot silently retarget.
 */
export function prepareHermeticEnv(opts: PrepareHermeticEnvOptions = {}): HermeticScaffold {
  const baseEnv = opts.baseEnv ?? process.env;

  // Fail-closed BEFORE any filesystem side effect: a foreign daemon target OR a
  // leaked injected-clock var (temporal silent-retarget) both hard-refuse here.
  assertNoForeignDaemon(baseEnv);
  assertNoAmbientClock(baseEnv);

  const root = mkdtempSync(join(tmpdir(), "openrig-scenario-"));
  const home = join(root, "home");
  const openrigHome = join(root, "openrig-home");
  const stateDir = join(root, "state");
  for (const dir of [home, openrigHome, stateDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Clean child env: copy, scrub every redirect/credential var, then set scratch paths.
  const env: Record<string, string | undefined> = { ...baseEnv };
  for (const name of DAEMON_TARGET_ENV_VARS) delete env[name];
  for (const name of CREDENTIAL_ENV_VARS) delete env[name];
  // Scrub any injected-clock var (defense in depth behind the fail-closed guard) so
  // only an explicit injectClockNow can set it below — never an inherited value.
  for (const name of TEST_CLOCK_ENV_VARS) delete env[name];
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_STATE_HOME = join(home, ".local", "state");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.OPENRIG_HOME = openrigHome;
  // Forced-local: never resolve/attach the shared fleet kernel.
  env.OPENRIG_NO_KERNEL = "1";
  // A3-R3 injected clock: the ONLY sanctioned way OPENRIG_TEST_CLOCK_NOW is set —
  // the scaffold's own value, never an inherited one. Omitted => unset => the bridge
  // stamps real-time (production behavior).
  if (opts.injectClockNow !== undefined) {
    env.OPENRIG_TEST_CLOCK_NOW = opts.injectClockNow;
  }

  return {
    root,
    home,
    openrigHome,
    stateDir,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
