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

/**
 * Env a host-side `rig` READ needs to reach a guarded route (client.ts's
 * terminal-token resolution). DISTINCT FROM `BEARER_ENV` — and the difference is
 * load-bearing:
 *
 * The guarded routers are gated by the TERMINAL token
 * (`server.ts:632` passes `deps.terminalBearerToken` into `transportRoutes`), not
 * the auth token. Those are separate values in general. They coincide HERE only
 * because `index.ts:160` copies auth -> terminal when the bind is NOT trusted
 * (loopback/tailscale short-circuit) — i.e. exactly the `0.0.0.0` bind this
 * procedure mandates. So under this procedure ONE token value serves both, and:
 *   • a DIRECT curl carrying `Authorization: Bearer <token>` works as-is;
 *   • a host-side `rig` read needs the token under THIS env name.
 *
 * WHY THE NEGATIVE CONTROL IS NOT OPTIONAL: when the terminal token is null the
 * middleware PASSES EVERYTHING THROUGH (`auth-bearer-token.ts:98-101`) — an
 * unguarded route. If the bind were ever softened to loopback while keeping a
 * bearer, `terminalBearerToken` would stay null, the guarded probe would answer
 * without auth, and an auth-probe-only runbook would report a green that proves
 * nothing. The negative control (same call, NO header, MUST be 401) is what
 * detects that state — it is the assertion that the guard is armed at all.
 */
export const TERMINAL_BEARER_ENV = "OPENRIG_TERMINAL_BEARER_TOKEN";

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

/**
 * Env for a host-side `rig` read against the published daemon: the terminal
 * token (see TERMINAL_BEARER_ENV) plus the daemon URL the read should target.
 * Use this instead of hand-assembling env in each consumer.
 */
export function rigReadEnv(bearerToken: string, baseUrl: string): Record<string, string> {
  if (!bearerToken) {
    throw new Error(
      "testbed rig-read: a non-empty token is required — a guarded route answers 401 without it, " +
        "and a NULL terminal token would leave the route unguarded entirely (see TERMINAL_BEARER_ENV).",
    );
  }
  return { [TERMINAL_BEARER_ENV]: bearerToken, OPENRIG_URL: baseUrl };
}

// ── STAGING: getting fixtures INTO a container correctly (one method, two consumers) ──
//
// Two defects were paid for here, both live: (1) staging under /root leaves the tree
// unreadable to `USER openrig` (Dockerfile:61), and (2) `docker cp` preserves ROOT
// ownership, so even a readable stage is NOT WRITABLE — and `rig up`'s pre-launch
// delivery WRITES into it (AGENTS.md), failing EACCES at instantiate.
//
// The fix that avoids both by construction: stage under the openrig user's OWN home and
// deliver by TAR-PIPE into a DEFAULT `docker exec`, which extracts AS `openrig`. No chown,
// no root exec — the user the product runs as is the user that does the work.

/** The exec user's home — everything staged lives under it. */
export const CONTAINER_STAGE_ROOT = "/home/openrig";

/** An in-container stage path. Consumers pass THIS to the daemon, never a host path:
 *  the daemon reads the topology INSIDE the container. */
export function containerStagePath(name: string): string {
  if (!name || name.startsWith("/") || name.includes("..")) {
    throw new Error(`testbed stage: expected a simple relative name, got ${JSON.stringify(name)}`);
  }
  return `${CONTAINER_STAGE_ROOT}/${name}`;
}

/** tar-side argv: stream the source directory's CONTENTS (note the trailing "."). */
export function stageTarSourceArgv(hostDir: string): string[] {
  return ["-C", hostDir, "-cf", "-", "."];
}

/** docker-side argv: extract as the DEFAULT exec user (openrig) — no `-u`, no chown.
 *  Pipe stageTarSourceArgv's stdout into this process's stdin. */
export function stageExtractArgv(container: string, stagePath: string): string[] {
  return ["exec", "-i", container, "tar", "-C", stagePath, "-xf", "-"];
}

/** The pre-flight the stage must pass before anything depends on it: readable AND
 *  WRITABLE as the exec user, probed by DOING (touch/rm) rather than by reading mode
 *  bits — bits lie under ownership, ACLs, and read-only mounts. */
export function stageFenceArgv(container: string, stagePath: string): string[] {
  return [
    "exec", container, "sh", "-c",
    `test -r '${stagePath}' && touch '${stagePath}/.fence-write' && rm -f '${stagePath}/.fence-write'`,
  ];
}
