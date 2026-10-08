// `rig launch --plan` sends `plan: true` to the launch-subset route. That route predates the field: plan support
// arrived in daemon 0.5.9, and an older daemon ignores the field and launches. So a plan request first asks the
// daemon its version, and a plan answer must say `planOnly: true`.

/** The first daemon version whose launch-subset route honours `plan: true`. */
export const PLAN_MIN_DAEMON_VERSION = "0.5.9";

/** Read-only, and present on every daemon from 0.4.1; an older one answers 404 and is refused. */
export const DAEMON_VERSION_PATH = "/api/health-summary/version";

const MIN = PLAN_MIN_DAEMON_VERSION.split(".").map(Number);

function supportsPlan(version: unknown): boolean {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < MIN.length; i++) {
    if (parts[i]! !== MIN[i]!) return parts[i]! > MIN[i]!;
  }
  return true;
}

/**
 * Before sending a plan request: returns null when the daemon reports version 0.5.9 or later, otherwise the
 * message to print instead of sending. `fetchVersion` returns the version route's JSON body, or undefined when the
 * read failed; the caller picks the transport (local client or `--host`).
 */
export async function planSupportRefusal(fetchVersion: () => Promise<unknown>): Promise<string | null> {
  let body: unknown;
  try {
    body = await fetchVersion();
  } catch {
    body = undefined;
  }
  const version = body && typeof body === "object" ? (body as { version?: unknown }).version : undefined;
  if (supportsPlan(version)) return null;
  const seen = typeof version === "string" ? `reports version ${version}` : "did not report its version";
  return `Not sent: the daemon ${seen}, and --plan needs ${PLAN_MIN_DAEMON_VERSION} or later. An older daemon ignores --plan and launches. Upgrade or restart the daemon, then retry.`;
}

/** After a plan request: true only for an answer that says it changed nothing. */
export function isPlanAnswer(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { planOnly?: unknown }).planOnly === true);
}

export const NOT_A_PLAN_MESSAGE =
  "The daemon did not return a plan, so it may have acted on this request. Check `rig ps --nodes` before retrying.";
