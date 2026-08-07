// THE PUBLISHED-DAEMON PROCEDURE — one source of truth for every consumer.
//
// The A/B testbed reaches a containerized daemon through PUBLISHED PORTS. Three
// mechanics are coupled and must be identical everywhere they appear, or the
// runbooks and the container adapter drift and each "proves" a different thing:
//
//   1. EXPLICIT BIND. `packages/daemon/src/index.ts:148` reads OPENRIG_HOST;
//      unset defaults to 127.0.0.1 (:167) — loopback is unreachable through a
//      published port, which is exactly how the first A/B failed on BOTH arms.
//   2. BEARER, because the bind demands it. `assertBindAuthInvariant`
//      (middleware/auth-bearer-token.ts:240-264) REFUSES to start a
//      non-loopback bind without OPENRIG_AUTH_BEARER_TOKEN. The procedure
//      SATISFIES that guard; it never weakens, bypasses, or special-cases it.
//   3. EXPLICIT HOST PORT. Apple `container` 1.2.0 rejects the ephemeral
//      publish form (`invalid publish host port range: 0`) where Docker accepts
//      it, and it RESETS on the loopback-qualified form (`127.0.0.1:P:C`) while
//      the unqualified form works. Both arms therefore publish `P:C`, explicit.
//
// PROBE SPLIT (do not collapse these — collapsing them fabricates a green):
//   • /healthz is UNAUTHENTICATED (registered directly at server.ts:574; there
//     is no global auth middleware) — it proves REACHABILITY only. Scoring auth
//     on it would pass while proving nothing.
//   • A GUARDED route proves the AUTH path: /api/transport/* guards its whole
//     router (routes/transport.ts:9). Any non-401 response proves the bearer was
//     accepted; an application-level 404 is a PASS for this purpose.
//   • A NEGATIVE CONTROL (same call, no header) must be 401, or the guard is not
//     guarding and probe 2 proved nothing either.
//
// Consumers: docker/testbed/runbooks/L3-daemon-in-container.md (prose mirror,
// parity-pinned in testbed-published-daemon.test.ts) and the container adapter
// (helpers/scenario-container.ts). Change a value HERE; the parity test fails
// the runbook that did not follow.

/** Daemon port INSIDE the container. */
export const CONTAINER_PORT = 7433;

/** Published host port for the L3 single-container leg. EXPLICIT, never 0. */
export const L3_HOST_PORT = 19433;

/** Env that forces the explicit bind (index.ts:148). */
export const BIND_ENV = "OPENRIG_HOST";
export const BIND_VALUE = "0.0.0.0";

/** Env carrying the bearer the bind guard requires (auth-bearer-token.ts:240). */
export const BEARER_ENV = "OPENRIG_AUTH_BEARER_TOKEN";

/** Unauthenticated reachability probe. */
export const HEALTH_PATH = "/healthz";

/** Guarded route for the AUTH probe + its negative control. */
export const GUARDED_PROBE_PATH = "/api/transport/send";

/**
 * The publish argument. UNQUALIFIED by design: Apple 1.2.0 resets on the
 * loopback-qualified form, so both arms use the same unqualified string —
 * identical input, not an Apple-only concession.
 */
export function publishArg(hostPort: number, containerPort: number = CONTAINER_PORT): string {
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    throw new Error(
      `testbed publish: host port must be an explicit positive integer (got ${hostPort}). ` +
        `Ephemeral port 0 is rejected by Apple container 1.2.0 — allocate explicitly.`,
    );
  }
  return `${hostPort}:${containerPort}`;
}

/** The daemon env every published-daemon container needs. */
export function publishedDaemonEnv(bearerToken: string): Record<string, string> {
  if (!bearerToken) {
    throw new Error(
      "testbed bearer: a non-empty token is required — the daemon REFUSES a non-loopback bind " +
        "without one (assertBindAuthInvariant). Satisfy the guard; never weaken it.",
    );
  }
  return { [BIND_ENV]: BIND_VALUE, [BEARER_ENV]: bearerToken };
}

/** Docker/Apple `run` flags for the env above (flat -e pairs, adapter-friendly). */
export function publishedDaemonEnvFlags(bearerToken: string): string[] {
  return Object.entries(publishedDaemonEnv(bearerToken)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}
