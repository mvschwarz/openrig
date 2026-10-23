import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type LocalDaemonOwner =
  | { state: "same-user" | "foreign"; pid: number; uid: number; callerUid: number }
  | { state: "unknown"; reason: string };

interface OwnerProbeDeps {
  platform?: string;
  callerUid?: number;
  fetchImpl?: typeof fetch;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
}
const exec = promisify(execFile);
const unknown = (reason: string): LocalDaemonOwner => ({ state: "unknown", reason });
const integer = (s: string): number | undefined => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : undefined;

/** Keep deliberate remote routing out of the local process namespace. */
function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

export function processIdentity(raw: string): { uid: number; start: string } | undefined {
  // LC_ALL=C: ps lstart is a stable process-start discriminator, not a PID-only check.
  const match = raw.trim().match(/^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/);
  if (!match?.[1] || !match[2] || !Number.isFinite(Date.parse(match[2]))) return;
  const uid = integer(match[1]);
  return uid !== undefined ? { uid, start: match[2].replace(/\s+/g, " ") } : undefined;
}

/** Optional accidental-routing mitigation, not authentication or same-user instance isolation.
 * Trusts the daemon's reported PID/euid, corroborated by ps; it does not prove socket ownership.
 * Every request observes afresh. Repeated observations cannot make the following TCP request atomic. */
export async function assessLocalDaemonOwner(baseUrl: string, deps: OwnerProbeDeps = {}): Promise<LocalDaemonOwner> {
  const callerUid = deps.callerUid ?? process.geteuid?.();
  if ((deps.platform ?? process.platform) !== "darwin" || !isLoopbackEndpoint(baseUrl) || callerUid === undefined) return unknown("not_local_mac");
  const timeoutMs = deps.timeoutMs ?? 1000;
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const run = deps.run ?? (async (file: string, args: string[], bound: number) => {
    const result = await exec(file, args, { timeout: bound, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return result.stdout;
  });
  const observe = async (file: string, args: string[]) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0 || controller.signal.aborted) throw new Error("owner observation expired");
    return run(file, args, remaining);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<LocalDaemonOwner> => {
        const healthIdentity = async (): Promise<{ pid: number; uid: number } | undefined> => {
          if (controller.signal.aborted || performance.now() >= deadline) return;
          const health = await (deps.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal, redirect: "error" });
          if (!health.ok) return;
          const body = await health.json() as { pid?: unknown; euid?: unknown } | null;
          if (!Number.isSafeInteger(body?.pid) || (body?.pid as number) <= 0
            || !Number.isSafeInteger(body?.euid) || (body?.euid as number) < 0) return;
          return { pid: body!.pid as number, uid: body!.euid as number };
        };
        const reported = await healthIdentity();
        if (!reported) return unknown("health_identity_missing");
        const processes = () => observe("/bin/ps", ["-o", "uid=,lstart=", "-p", String(reported.pid)]);
        const before = processIdentity(await processes());
        if (!before || before.uid !== reported.uid) return unknown("process_unconfirmed");
        const second = await healthIdentity();
        if (!second || second.pid !== reported.pid || second.uid !== reported.uid) return unknown("reported_identity_changed");
        const after = processIdentity(await processes());
        if (!after || after.uid !== before.uid || after.start !== before.start) return unknown("process_changed");
        if (controller.signal.aborted || performance.now() >= deadline) return unknown("timeout");
        return { state: reported.uid === callerUid ? "same-user" : "foreign", ...reported, callerUid };
      })(),
      new Promise<LocalDaemonOwner>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unknown("timeout")); }, timeoutMs); }),
    ]);
  } catch { return unknown("observation_unavailable"); }
  finally { clearTimeout(timer); controller.abort(); }
}

export class ForeignLocalDaemonError extends Error {
  readonly code = "foreign_local_daemon";
  constructor(baseUrl: string, owner: Extract<LocalDaemonOwner, { state: "same-user" | "foreign" }>) {
    super(`The optional local user guard found a different OS user at ${baseUrl} (reported PID ${owner.pid}, effective UID ${owner.uid}, corroborated by ps; caller effective UID ${owner.callerUid}). No business request was sent after this owner check. Start your own daemon with \`rig daemon start --port <unused-port>\`, or explicitly select an intended shared/remote endpoint with OPENRIG_URL.`);
    this.name = "ForeignLocalDaemonError";
  }
}
