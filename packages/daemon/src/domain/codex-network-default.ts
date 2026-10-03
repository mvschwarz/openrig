// #275 — Codex seats get network access inside OpenRig's workspace-write floor by default, with an
// easy opt-out. Codex itself says whether anyone opted out: before a launch on the plain
// `-s workspace-write` floor, a one-shot `codex app-server` started with the seat's executable,
// PATH, HOME, CODEX_HOME and cwd answers `config/read` and `configRequirements/read`, then exits on
// stdin EOF. OpenRig adds `-c sandbox_workspace_write.network_access=true` to that one launch only
// when both answers positively show the plain floor, no network choice at any layer, and no
// requirement that could restrict it. Every other outcome (deadline, RPC error, unknown shape,
// policy or selection) adds nothing and the original launch continues, so network may stay off.
// There is no new refusal or prompt, no cache and no persistent process.
//
// Side effects: Codex startup may write its own state, system-skill and temp files in CODEX_HOME,
// read its auth store and fetch managed policy. The read and the launch are not atomic.

import { spawn } from "node:child_process";
import { shellQuote } from "../adapters/shell-quote.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";

/** The override added to an eligible launch. */
export const CODEX_NETWORK_DEFAULT_OVERRIDE = "sandbox_workspace_write.network_access=true";

export type CodexNetworkDecision = { apply: true } | { apply: false; reason: string };
export type CodexNetworkDefault = CodexNetworkDecision & { elapsedMs: number };
/** Reads the network default for a seat that would run in `cwd`. */
export type CodexNetworkDefaultReader = (cwd: string) => Promise<CodexNetworkDefault>;

/** ConfigRequirements fields (app-server v2, 0.160.0) that cannot restrict network inside workspace-write. */
const UNRELATED_REQUIREMENTS = new Set([
  "modelProvider", "modelProviders", "allowedLoginMethods", "cliAuthCredentialsStore", "chatgptBaseUrl",
  "additionalDeveloperInstructions", "allowedApprovalPolicies", "allowedApprovalsReviewers",
  "allowedWindowsSandboxImplementations", "allowedWebSearchModes", "allowManagedHooksOnly",
  "allowBrowserAndComputerUse", "allowAppshots", "allowRemoteControl", "computerUse", "browserUse",
  "inAppBrowser", "hooks", "enforceResidency", "autoReview", "models", "sqliteHome", "logDir",
  "modelCatalogJson", "checkForUpdateOnStartup", "allowLoginShell", "feedback",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const no = (reason: string): CodexNetworkDecision => ({ apply: false, reason });

/**
 * Decides from the two RPC results alone. A missing origin is not proof of no policy (Codex leaves
 * requirement-pinned and packaged-default values out of `origins`), so the requirements answer and
 * the effective value are checked too, and anything unrecognized adds nothing.
 */
export function decideCodexNetworkDefault(configRead: unknown, requirementsRead: unknown): CodexNetworkDecision {
  if (!isRecord(configRead) || !isRecord(configRead.config) || !isRecord(configRead.origins)) {
    return no("config/read returned an unrecognized shape");
  }
  const { config, origins } = configRead;
  const sandboxOrigin = origins["sandbox_mode"];
  if (config.sandbox_mode !== "workspace-write" || !isRecord(sandboxOrigin) || !isRecord(sandboxOrigin.name)
    || sandboxOrigin.name.type !== "sessionFlags") {
    return no("the effective sandbox is not OpenRig's workspace-write launch flag");
  }
  if (config.profile != null) return no("a Codex configuration profile is selected");
  if (config.default_permissions != null) return no("a Codex permission profile is selected");
  if ("sandbox_workspace_write.network_access" in origins || "sandbox_workspace_write" in origins) {
    return no("network access is set explicitly in Codex configuration");
  }
  const workspaceWrite = config.sandbox_workspace_write;
  if (workspaceWrite != null) {
    if (!isRecord(workspaceWrite)) return no("config/read returned an unrecognized sandbox_workspace_write");
    if (workspaceWrite.network_access === true) return no("network access is already on");
    if (workspaceWrite.network_access != null && workspaceWrite.network_access !== false) {
      return no("config/read returned an unrecognized network_access value");
    }
  }
  if (!isRecord(requirementsRead) || !("requirements" in requirementsRead)) {
    return no("configRequirements/read returned an unrecognized shape");
  }
  const requirements = requirementsRead.requirements;
  if (requirements !== null) {
    if (!isRecord(requirements)) return no("configRequirements/read returned an unrecognized shape");
    for (const [key, value] of Object.entries(requirements)) {
      if (value == null || UNRELATED_REQUIREMENTS.has(key)) continue;
      if (key === "allowedSandboxModes" && Array.isArray(value) && value.includes("workspace-write")) continue;
      return no(`a managed requirement (${key}) may restrict network access`);
    }
  }
  return { apply: true };
}

/**
 * The segment a launch inserts right after its posture flag: the override when the reader applies
 * it, otherwise "". Only the plain `-s workspace-write` floor is read; a named profile, YOLO or full
 * bypass launch is left exactly as it was, and so is any launch without a reader.
 */
export async function codexNetworkDefaultArg(
  read: CodexNetworkDefaultReader | undefined,
  appliedLaunch: AppliedLaunchObservation,
  cwd: string,
  session: string,
): Promise<string> {
  if (!read || appliedLaunch.state !== "observed" || appliedLaunch.value !== "workspace-write" || appliedLaunch.approvalPolicy != null) {
    return "";
  }
  let result: CodexNetworkDefault;
  try {
    result = await read(cwd);
  } catch (error) {
    result = { ...no(`the reader failed: ${firstLine(error)}`), elapsedMs: 0 };
  }
  console.log(`[openrig] codex network default for ${session}: ${result.apply ? "applied" : `not applied (${result.reason})`}, ${result.elapsedMs} ms`);
  return result.apply ? ` -c ${shellQuote(CODEX_NETWORK_DEFAULT_OVERRIDE)}` : "";
}

export interface CodexNetworkReaderOptions {
  /** The PATH the seat's launch command runs with. */
  launchPath?: string;
  /** The HOME and CODEX_HOME the seat's session gets. */
  home?: string;
  codexHome?: string;
  /** Answers must arrive within this; then stdin EOF, and TERM/KILL of the reader's process group. */
  deadlineMs?: number;
  graceMs?: number;
  /** Largest stdout the reader buffers. */
  maxOutputBytes?: number;
}

export const CODEX_NETWORK_READER_DEADLINE_MS = 4_000;

/** The production reader: asynchronous, so the daemon keeps serving while Codex starts. */
export function codexNetworkDefaultReader(options: CodexNetworkReaderOptions = {}): CodexNetworkDefaultReader {
  const deadlineMs = options.deadlineMs ?? CODEX_NETWORK_READER_DEADLINE_MS;
  const graceMs = options.graceMs ?? 500;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  return async (cwd) => {
    const started = performance.now();
    const env = {
      ...process.env,
      ...(options.launchPath ? { PATH: options.launchPath } : {}),
      ...(options.home ? { HOME: options.home } : {}),
      ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}),
    };
    // The launch flag `-s workspace-write` is `sandbox_mode` for the server; plugins and apps are
    // switched off for the reader only. app-server serves stdio by default.
    const args = ["-c", 'sandbox_mode="workspace-write"', "-c", "features.plugins=false", "-c", "features.apps=false", "app-server"];
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so cleanup reaches the reader's descendants and nothing else.
      child = spawn("codex", args, { cwd, env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    } catch (error) {
      return { ...no(`codex app-server could not start: ${firstLine(error)}`), elapsedMs: Math.round(performance.now() - started) };
    }
    const decision = await converse(child, cwd, deadlineMs, maxOutputBytes);
    await stopGroup(child, graceMs);
    return { ...decision, elapsedMs: Math.round(performance.now() - started) };
  };
}

function converse(child: ReturnType<typeof spawn>, cwd: string, deadlineMs: number, maxOutputBytes: number): Promise<CodexNetworkDecision> {
  return new Promise((resolve) => {
    const answers = new Map<number, Record<string, unknown>>();
    let buffered = "";
    let received = 0;
    let settled = false;
    const finish = (decision: CodexNetworkDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(decision);
    };
    const deadline = setTimeout(() => finish(no(`codex app-server did not answer within ${deadlineMs} ms`)), deadlineMs);
    const send = (message: Record<string, unknown>) => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.on("error", (error) => finish(no(`codex app-server could not start: ${firstLine(error)}`)));
    child.on("exit", () => finish(no("codex app-server exited before answering")));
    child.stdin?.on("error", () => finish(no("codex app-server closed its input before answering")));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      received += Buffer.byteLength(chunk);
      if (received > maxOutputBytes) return finish(no("codex app-server answered with more output than expected"));
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        // Only responses to our own requests: notifications and server requests carry a method.
        if (!isRecord(message) || typeof message.id !== "number" || "method" in message) continue;
        if (message.error !== undefined) return finish(no(`codex app-server returned an error for request ${message.id}`));
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "config/read", params: { includeLayers: true, cwd } });
          send({ id: 3, method: "configRequirements/read", params: {} });
          continue;
        }
        answers.set(message.id, message);
        if (answers.has(2) && answers.has(3)) {
          return finish(decideCodexNetworkDefault(answers.get(2)!.result, answers.get(3)!.result));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "openrig_network_default", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
  });
}

/** stdin EOF first; then TERM, then KILL, to the reader's own process group while any member remains. */
async function stopGroup(child: ReturnType<typeof spawn>, graceMs: number): Promise<void> {
  child.stdin?.end();
  const pid = child.pid;
  if (pid === undefined) return;
  const reaped = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  for (const signal of [null, "SIGTERM", "SIGKILL"] as const) {
    if (signal) {
      try { process.kill(-pid, signal); } catch { break; }
    }
    if (await groupGone(pid, graceMs)) break;
  }
  // A dead reader leaves its group before Node reaps it; wait, bounded, for the reap too.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reaped, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
  clearTimeout(timer);
}

async function groupGone(pid: number, withinMs: number): Promise<boolean> {
  const until = performance.now() + withinMs;
  for (;;) {
    try { process.kill(-pid, 0); } catch { return true; }
    if (performance.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0];
