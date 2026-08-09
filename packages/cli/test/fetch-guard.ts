// P37 — the request-layer hermeticity guard. The ONE universal outbound-request
// convergence is globalThis.fetch: DaemonClient.fetch (client.ts) converges all
// DaemonClient traffic but front-door healthz + daemon-lifecycle kernel-status issue
// RAW reads that bypass it, so a client-layer guard would pass review and leak two
// paths. Wrapping fetch catches all four live provenances at once — env (M1),
// hardcoded literal (M2), mocked-getter + un-mocked-client (M3), and production
// default constants (M4, invisible to any test-side grep) — because every one of them
// ends in a real request.
//
// NOT COVERED by design (named, not fixed): a SUBPROCESS spawned by a test has its OWN
// globals, so a child process making its own request is out of this guard's reach. There
// are zero such daemon-directed execs today (the only real execs are execFileSync('git',
// …)); if one ever appears it needs its own child-process env isolation, not this hook.
//
// It is an ALLOWLIST the fixture populates when it binds, NOT a host/port denylist:
// block-all-localhost would break the legitimate in-process mock servers (broadcast's
// server.listen(0) on an ephemeral port is a correct second containment layer). The
// discriminator is fixture-REGISTERED target vs canonical daemon target; it FAILS
// CLOSED on anything unregistered (register the fixture, never widen).

// State is anchored on globalThis, NOT module scope: vitest can give setupFiles and
// test files SEPARATE module instances, so a module-level Set would let the installed
// guard (setup's instance) close over one allowlist while a test's allowFetchTarget
// writes another — the guard would then refuse every registered fixture. One
// globalThis-backed allowlist keeps the setup install and every test in agreement.
interface FetchGuardState {
  allow: Set<string>;
  originalFetch: typeof globalThis.fetch | undefined;
}
const g = globalThis as unknown as { __openrigFetchGuard?: FetchGuardState };
g.__openrigFetchGuard ??= { allow: new Set<string>(), originalFetch: undefined };
const state = g.__openrigFetchGuard;
const allowedOrigins = state.allow;

// The permit rule is a SHAPE, not a registry: an in-process fixture is loopback on an
// EPHEMERAL high port (exactly what server.listen(0) produces — verified 58158+ on
// darwin; Linux uses 32768+). Everything else — non-loopback of any kind, and loopback
// on a well-known/canonical port including the daemon's :7433 — is REFUSED. The default
// for an unrecognised target is refuse, so fail-closed survives; this is not a denylist.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const EPHEMERAL_MIN = 32768; // 2^15 — below both platforms' ephemeral floor, above :7433

interface Target { origin: string; host: string; port: number }
function parseTarget(urlStr: string): Target | null {
  try {
    const u = new URL(urlStr);
    return { origin: `${u.protocol}//${u.host}`, host: u.hostname, port: Number(u.port) };
  } catch {
    return null;
  }
}

function isPermittedByShape(host: string, port: number): boolean {
  if (!LOOPBACK_HOSTS.has(host)) return false; // non-loopback → refuse (machine boundary)
  return Number.isInteger(port) && port >= EPHEMERAL_MIN; // loopback-ephemeral permit; :7433 & low → refuse
}

function urlFromInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

/** Register a fixture target (its origin) so the guard PERMITS requests to it. A
 *  fixture calls this when it binds its ephemeral port (server.listen(0)). */
export function allowFetchTarget(urlOrOrigin: string): void {
  const t = parseTarget(urlOrOrigin);
  if (t) allowedOrigins.add(t.origin);
}

/** Install the guard on globalThis.fetch (idempotent). Armed from setupFiles so every
 *  vitest invocation is covered — unwritable by omission. */
export function installFetchGuard(): void {
  if (state.originalFetch) return;
  state.originalFetch = globalThis.fetch;
  const orig = state.originalFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const t = parseTarget(urlFromInput(input));
    // Non-http(s) targets (data:, blob:, node: …) are not a daemon vector — pass through.
    if (!t || !/^https?:/i.test(t.origin)) return orig(input as never, init);
    // PERMIT by shape (loopback-ephemeral fixture) or by explicit registration (the
    // fixed-low-port escape hatch). REFUSE everything else — fail-closed by default.
    if (isPermittedByShape(t.host, t.port) || allowedOrigins.has(t.origin)) return orig(input as never, init);
    const nonLoopback = !LOOPBACK_HOSTS.has(t.host);
    const isDaemon = t.port === 7433;
    return Promise.reject(
      new Error(
        `FETCH GUARD (P37): refused an outbound request to ${t.origin}` +
          (isDaemon ? " (the canonical OpenRig daemon port)" : nonLoopback ? " (a NON-LOOPBACK / cross-machine target)" : "") +
          " — a cli test made a REAL request to a target that is neither a loopback-ephemeral fixture nor registered. " +
          (nonLoopback
            ? "Non-loopback is refused unconditionally (a test must not cross a machine boundary — hosts.yaml names a real remote at 100.95.124.51)."
            : "Loopback on a well-known/canonical port is a request-layer leak to the daemon (a hardcoded :7433 literal, a mocked URL getter + un-mocked client, or a production default constant). Inject a mock client, use an in-process fixture (server.listen(0) → ephemeral, permitted), or register a fixed-low-port fixture with allowFetchTarget(url)."),
      ),
    );
  }) as typeof globalThis.fetch;
}

/** Clear the fixture allowlist without uninstalling the guard (per-test cleanup so
 *  one file's fixture registrations do not leak into another's assertions). */
export function resetFetchAllowlist(): void {
  allowedOrigins.clear();
}

/** Restore the real fetch and clear the allowlist. Not used by the persistent setup
 *  install; available for a test that needs to fully tear the guard down. */
export function uninstallFetchGuard(): void {
  if (state.originalFetch) {
    globalThis.fetch = state.originalFetch;
    state.originalFetch = undefined;
  }
  allowedOrigins.clear();
}
