// `rig launch --plan` sends `plan: true` to the launch-subset route. That route predates the field: plan support
// arrived in daemon 0.5.9, and an older daemon ignores the field and launches. So a plan request first asks the
// daemon its version, and a plan answer must say `planOnly: true`.

/** The first daemon version whose launch-subset route honours `plan: true`. */
export const PLAN_MIN_DAEMON_VERSION = "0.5.9";

/** A packaged daemon's stamped version: /healthz has carried `semver` on stamped builds since 0.4.4. */
export const DAEMON_HEALTH_PATH = "/healthz";

/** For unstamped development runs. Packaged 0.5.9 to 0.6.5 answer "unknown" here, so it is the fallback only;
 *  a daemon before 0.4.1 answers 404 and is refused. */
export const DAEMON_VERSION_PATH = "/api/health-summary/version";

const MIN = PLAN_MIN_DAEMON_VERSION.split(".").map(Number);

function supportsPlan(version: unknown): boolean {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(version) : null;
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < MIN.length; i++) {
    if (parts[i]! !== MIN[i]!) return parts[i]! > MIN[i]!;
  }
  // A pre-release of the minimum itself (0.5.9-rc.1) sorts below it, so it may predate plan support.
  return match[4] === undefined;
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Before sending a plan request: returns null when the daemon reports version 0.5.9 or later, otherwise the
 * message to print instead of sending. `read(path)` GETs a read-only daemon path and returns its JSON body, or
 * undefined when the read failed; the caller picks the transport (local client or `--host`). The stamped
 * `/healthz` semver is read first; the version route answers only for unstamped development runs.
 */
export async function planSupportRefusal(read: (path: string) => Promise<unknown>): Promise<string | null> {
  const get = async (path: string): Promise<unknown> => {
    try {
      return await read(path);
    } catch {
      return undefined;
    }
  };
  const stamped = field(await get(DAEMON_HEALTH_PATH), "semver");
  const version = typeof stamped === "string" ? stamped : field(await get(DAEMON_VERSION_PATH), "version");
  if (supportsPlan(version)) return null;
  const seen = typeof version === "string" ? `reports version ${version}` : "did not report its version";
  return `Not sent: the daemon ${seen}, and --plan needs ${PLAN_MIN_DAEMON_VERSION} or later. An older daemon ignores --plan and launches. Upgrade or restart the daemon, then retry.`;
}

/** After a plan request: true only for an answer that says it changed nothing. */
export function isPlanAnswer(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { planOnly?: unknown }).planOnly === true);
}

/**
 * After a plan request whose answer isn't a plan: true when the answer shows the daemon acted, meaning a 2xx, or
 * a body reporting seats (an older daemon's 409 `attention_required` launch carries `launched`). A plan error from
 * a daemon that honours `plan` (unknown rig, unmatched seat, no usable snapshot) shows neither and keeps its own
 * error output.
 */
export function answerShowsAction(succeeded: boolean, data: unknown): boolean {
  if (succeeded) return true;
  if (!data || typeof data !== "object") return false;
  const body = data as Record<string, unknown>;
  return ["launched", "held", "alreadyRunning"].some((key) => body[key] !== undefined);
}

/** The warning for an answer that isn't a plan but shows the daemon acted. `-A` because `rig ps --nodes` refuses
 *  an implicit scope outside a managed session and over `--host`, and `--rig` takes a name where launch takes an id. */
export function notAPlanMessage(host?: string): string {
  const check = host ? `rig ps --host ${host} --nodes -A` : "rig ps --nodes -A";
  return `The daemon did not return a plan, so it may have acted on this request. Check \`${check}\` before retrying.`;
}
