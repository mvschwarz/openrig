import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SessionRegistry } from "./session-registry.js";
import { observeCodexPaneProcess, codexProcessArgv, codexProcessResumeToken, type NativeProcessLister } from "./native-process-lineage.js";
import { lstartToMinTs } from "./codex-thread-id.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** Native turn_context policy, not a requested mode, profile or argv observation. */
export interface CodexPermissionEnvelope {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandboxPolicy: { type: "danger-full-access" | "read-only" }
    | { type: "workspace-write"; writable_roots?: string[]; network_access: boolean;
        exclude_tmpdir_env_var: boolean; exclude_slash_tmp: boolean };
}
export interface CodexPermissionContinuity {
  state: "emitted" | "unverified" | "selection_used";
  detail: string;
}
export type CodexRebuildPermissions =
  | { state: "observed"; envelope: CodexPermissionEnvelope; observedAt: string; processStartedAt: string; profile: string | null }
  | { state: "unverified"; reason: string };

export function parseCodexPermissionEnvelope(value: unknown): CodexPermissionEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (["permission_profile", "file_system_sandbox_policy", "network_sandbox_policy"].some(key => input[key] !== undefined)) return null;
  if (!["untrusted", "on-request", "never"].includes(input.approval_policy as string)) return null;
  const policy = input.sandbox_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const sandbox = policy as Record<string, unknown>;
  const approvalPolicy = input.approval_policy as CodexPermissionEnvelope["approvalPolicy"];
  if (sandbox.type === "danger-full-access" && Object.keys(sandbox).length === 1) {
    return { approvalPolicy, sandboxPolicy: { type: "danger-full-access" } };
  }
  if (sandbox.type === "read-only" && Object.keys(sandbox).every(key => key === "type" || key === "network_access")
    && (sandbox.network_access === undefined || sandbox.network_access === false)) {
    return { approvalPolicy, sandboxPolicy: { type: "read-only" } };
  }
  const keys = ["type", "writable_roots", "network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"];
  if (sandbox.type !== "workspace-write" || Object.keys(sandbox).some(key => !keys.includes(key))
    || keys.slice(2).some(key => typeof sandbox[key] !== "boolean")) return null;
  if (sandbox.writable_roots !== undefined && (!Array.isArray(sandbox.writable_roots)
    || sandbox.writable_roots.some(root => typeof root !== "string" || !isAbsolute(root) || root.includes("\0")))) return null;
  return { approvalPolicy, sandboxPolicy: { ...sandbox } as CodexPermissionEnvelope["sandboxPolicy"] };
}

/** All workspace fields are explicit, including [] when the native record omitted its empty roots.
 * Config overrides replace the requested fields; no fresh-launch add-dir/network grants follow. */
export function codexEnvelopeArgs(envelope: CodexPermissionEnvelope): string {
  const policy = envelope.sandboxPolicy;
  let args = ` -s ${policy.type} -a ${envelope.approvalPolicy}`;
  if (policy.type === "workspace-write") {
    const fields = { writable_roots: policy.writable_roots ?? [], network_access: policy.network_access,
      exclude_tmpdir_env_var: policy.exclude_tmpdir_env_var, exclude_slash_tmp: policy.exclude_slash_tmp };
    for (const [key, value] of Object.entries(fields)) args += ` -c ${shellQuote(`sandbox_workspace_write.${key}=${JSON.stringify(value)}`)}`;
  }
  return args;
}

/** Read one file descriptor: header binds the thread; newest context must belong to this process.
 * Bounded to 1 MiB each of tail and header, with no fallback to older complete policies. */
export function readCodexPermissionRecord(path: string, thread: string, cwd: string, notBeforeMs: number):
  { envelope: CodexPermissionEnvelope; observedAt: string } | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 1024 * 1024));
    readSync(fd, head, 0, head.length, 0);
    const metadata = JSON.parse(head.toString("utf8").split("\n")[0]!);
    if (metadata.type !== "session_meta" || metadata.payload?.id !== thread) return null;
    const start = Math.max(0, size - 1024 * 1024);
    const tail = Buffer.alloc(size - start);
    readSync(fd, tail, 0, tail.length, start);
    const lines = tail.toString("utf8").split("\n");
    if (start) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index]!.includes('"turn_context"')) continue;
      const entry = JSON.parse(lines[index]!);
      if (entry.type !== "turn_context") continue;
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at <= notBeforeMs || entry.payload?.cwd !== cwd) return null;
      const envelope = parseCodexPermissionEnvelope(entry.payload);
      return envelope ? { envelope, observedAt: new Date(at).toISOString() } : null;
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}

/** Only the live pane's one native process may locate the predecessor record. Registry tokens,
 * recency and profile names are never substitutes. Failures keep rebuild available, explicitly unverified. */
export async function observeCodexRebuildPermissions(input: {
  nodeId: string; sessionName: string; cwd: string;
  sessions: Pick<SessionRegistry, "currentOccupantTenure" | "getBindingForNode" | "currentOccupantGenerationForSession">;
  tmux: { getPanePid(target: string): Promise<number | null> };
  readThreadId: (pid: number, startedAt: string) => Promise<string | undefined> | string | undefined;
  rollout: (thread: string) => string | null;
  listProcesses?: NativeProcessLister;
}): Promise<CodexRebuildPermissions> {
  const unverified = (reason: string): CodexRebuildPermissions => ({ state: "unverified", reason });
  const tenure = input.sessions.currentOccupantTenure(input.nodeId);
  const binding = input.sessions.getBindingForNode(input.nodeId);
  if (!tenure || !binding?.tmuxPane || binding.tmuxSession !== input.sessionName
    || input.sessions.currentOccupantGenerationForSession(input.sessionName) !== tenure.generationUuid) {
    return unverified("The predecessor's current occupant and pane binding could not be established.");
  }
  try {
    const probe = { target: binding.tmuxPane, tmux: input.tmux, listProcesses: input.listProcesses, requireArgv: true };
    const first = await observeCodexPaneProcess(probe);
    const start = lstartToMinTs(first?.process.startedAt);
    const boot = parseSqliteUtcMs(tenure.bootAt);
    if (!first || start === undefined || !Number.isFinite(boot)) return unverified("The predecessor's native process identity or start time was not established.");
    const argv = codexProcessArgv(first.process);
    if (!argv) return unverified("The predecessor's exact native arguments could not be read.");
    const thread = await input.readThreadId(first.process.pid, first.process.startedAt!);
    const argvThread = codexProcessResumeToken(first.process);
    if (!thread || (argvThread !== undefined && argvThread !== thread)) return unverified("The predecessor's process and native conversation could not be joined.");
    const path = input.rollout(thread);
    const record = path ? readCodexPermissionRecord(path, thread, input.cwd, Math.max(start * 1000 + 999, boot)) : null;
    if (!record) return unverified("No complete supported native permission policy for this predecessor process and working directory was readable in the bounded record.");
    const after = await observeCodexPaneProcess(probe);
    const current = input.sessions.getBindingForNode(input.nodeId);
    if (after?.fingerprint !== first.fingerprint || input.sessions.currentOccupantTenure(input.nodeId)?.generationUuid !== tenure.generationUuid
      || input.sessions.currentOccupantGenerationForSession(input.sessionName) !== tenure.generationUuid
      || current?.tmuxPane !== binding.tmuxPane || current?.tmuxSession !== binding.tmuxSession) {
      return unverified("The predecessor changed while its native permission policy was read.");
    }
    const profileAt = argv.findIndex(arg => arg === "-p" || arg === "--profile");
    return { state: "observed", ...record, processStartedAt: first.process.startedAt!,
      profile: profileAt >= 0 ? argv[profileAt + 1] ?? null : null };
  } catch { return unverified("The predecessor's native permission observation was unavailable."); }
}
