import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

// Mid-work detection patterns (cheap heuristics)
const MID_WORK_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner chars
  /Working/,
  /esc to interrupt/,
  /\.{3,}$/m,  // lines ending in ...
  /…$/m,       // lines ending in …
];

const IDLE_TERMINAL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "nu", "tmux"]);

function looksLikeMidWork(paneContent: string): boolean {
  const lastLines = paneContent.split("\n").slice(-5).join("\n");
  return MID_WORK_PATTERNS.some((p) => p.test(lastLines));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count++;
    start = index + needle.length;
  }
  return count;
}

export type TargetSpec =
  | { session: string }
  | { rig: string }
  | { pod: string; rig?: string }
  | { global: true };

export type ResolveResult =
  | { ok: true; sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> }
  | { ok: false; code: "not_found" | "ambiguous"; error: string };

export interface SendOpts {
  verify?: boolean;
  force?: boolean;
}

export interface SendResult {
  ok: boolean;
  sessionName: string;
  verified?: boolean;
  warning?: string;
  error?: string;
  reason?: string;
}

export interface CaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  error?: string;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  failed: number;
  results: SendResult[];
}

interface SessionTransportDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
}

interface SessionRow { node_id: string; session_name: string; }
interface NodeRow { rig_id: string; logical_id: string; }
interface RuntimeRow { runtime: string | null; }

export class SessionTransport {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: SessionTransportDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async resolveSessions(target: TargetSpec): Promise<ResolveResult> {
    if ("session" in target) {
      return this.resolveBySessionName(target.session);
    }
    if ("pod" in target) {
      return this.resolveByPod(target.pod, target.rig);
    }
    if ("global" in target) {
      return this.resolveGlobal();
    }
    return this.resolveByRig(target.rig);
  }

  private resolveGlobal(): ResolveResult {
    const allRigs = this.rigRepo.listRigs();
    if (allRigs.length === 0) {
      return { ok: false, code: "not_found", error: "No rigs found. Check status with: rig ps" };
    }
    const sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> = [];
    const seenRigIds = new Set<string>();
    for (const rig of allRigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);
      const rigSessions = this.sessionRegistry.getSessionsForRig(rig.id);
      const latestByNode = new Map<string, typeof rigSessions[0]>();
      for (const s of rigSessions) {
        const existing = latestByNode.get(s.nodeId);
        if (!existing || s.id > existing.id) latestByNode.set(s.nodeId, s);
      }
      for (const s of latestByNode.values()) {
        if (s.status !== "running") continue;
        const binding = this.sessionRegistry.getBindingForNode(s.nodeId);
        if (!binding?.tmuxSession) continue;
        const nodeRow = this.db
          .prepare("SELECT logical_id FROM nodes WHERE id = ?")
          .get(s.nodeId) as { logical_id: string } | undefined;
        sessions.push({ sessionName: s.sessionName, rigName: rig.name, nodeLogicalId: nodeRow?.logical_id ?? s.nodeId });
      }
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "No running sessions found. Check status with: rig ps" };
    }
    return { ok: true, sessions };
  }

  private resolveBySessionName(sessionName: string): ResolveResult {
    const sessionRows = this.db
      .prepare("SELECT node_id, session_name FROM sessions WHERE session_name = ? ORDER BY id DESC")
      .all(sessionName) as SessionRow[];

    if (sessionRows.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    // Check for ambiguity: same session name across different rigs
    const rigNames = new Map<string, { nodeLogicalId: string }>();
    for (const row of sessionRows) {
      const nodeRow = this.db
        .prepare("SELECT rig_id, logical_id FROM nodes WHERE id = ?")
        .get(row.node_id) as NodeRow | undefined;
      if (nodeRow) {
        const rig = this.rigRepo.getRig(nodeRow.rig_id);
        if (rig) {
          rigNames.set(rig.rig.name, { nodeLogicalId: nodeRow.logical_id });
        }
      }
    }

    if (rigNames.size === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    if (rigNames.size > 1) {
      const names = Array.from(rigNames.keys()).join(", ");
      return {
        ok: false,
        code: "ambiguous",
        error: `Session '${sessionName}' is ambiguous — found in rigs: ${names}. Specify the rig explicitly.`,
      };
    }

    const [rigName, meta] = Array.from(rigNames.entries())[0]!;
    return {
      ok: true,
      sessions: [{ sessionName, rigName, nodeLogicalId: meta.nodeLogicalId }],
    };
  }

  private resolveByRig(rigName: string): ResolveResult {
    const rigs = this.rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No rig named '${rigName}' found. Check available rigs with: rig ps`,
      };
    }

    const sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> = [];
    for (const rig of rigs) {
      const rigSessions = this.sessionRegistry.getSessionsForRig(rig.id);
      // Group by nodeId, take latest per node
      const latestByNode = new Map<string, typeof rigSessions[0]>();
      for (const s of rigSessions) {
        const existing = latestByNode.get(s.nodeId);
        if (!existing || s.id > existing.id) {
          latestByNode.set(s.nodeId, s);
        }
      }
      // Filter to running with tmux binding
      for (const s of latestByNode.values()) {
        if (s.status !== "running") continue;
        const binding = this.sessionRegistry.getBindingForNode(s.nodeId);
        if (!binding?.tmuxSession) continue;
        // Look up logical ID
        const nodeRow = this.db
          .prepare("SELECT logical_id FROM nodes WHERE id = ?")
          .get(s.nodeId) as { logical_id: string } | undefined;
        sessions.push({
          sessionName: s.sessionName,
          rigName: rig.name,
          nodeLogicalId: nodeRow?.logical_id ?? s.nodeId,
        });
      }
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for rig '${rigName}'. Check rig status with: rig ps`,
      };
    }

    return { ok: true, sessions };
  }

  private resolveByPod(podName: string, rigName?: string): ResolveResult {
    // Get rigs to search
    const rigs = rigName
      ? this.rigRepo.findRigsByName(rigName)
      : this.rigRepo.listRigs();

    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: rigName
          ? `No rig named '${rigName}' found. Check available rigs with: rig ps`
          : `No rigs found. Check status with: rig ps`,
      };
    }

    // Collect running sessions across all matching rigs, deduplicated by rig ID
    const sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> = [];
    const seenRigIds = new Set<string>();
    for (const rig of rigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);

      const rigSessions = this.sessionRegistry.getSessionsForRig(rig.id);
      const latestByNode = new Map<string, typeof rigSessions[0]>();
      for (const s of rigSessions) {
        const existing = latestByNode.get(s.nodeId);
        if (!existing || s.id > existing.id) latestByNode.set(s.nodeId, s);
      }
      for (const s of latestByNode.values()) {
        if (s.status !== "running") continue;
        const binding = this.sessionRegistry.getBindingForNode(s.nodeId);
        if (!binding?.tmuxSession) continue;
        const nodeRow = this.db
          .prepare("SELECT logical_id FROM nodes WHERE id = ?")
          .get(s.nodeId) as { logical_id: string } | undefined;
        const logicalId = nodeRow?.logical_id ?? s.nodeId;
        // Filter by pod name from logicalId
        const podPart = logicalId.split(".")[0];
        if (podPart === podName) {
          sessions.push({ sessionName: s.sessionName, rigName: rig.name, nodeLogicalId: logicalId });
        }
      }
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for pod '${podName}'${rigName ? ` in rig '${rigName}'` : ""}. Check available pods with: rig ps --nodes`,
      };
    }

    return { ok: true, sessions };
  }

  async send(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    let preVerifyContent: string | null = null;
    const runtimeRow = this.db.prepare(`
      SELECT n.runtime AS runtime
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as RuntimeRow | undefined;
    const runtime = runtimeRow?.runtime ?? null;

    // 1. Check session exists / tmux available
    try {
      const exists = await this.tmuxAdapter.hasSession(sessionName);
      if (!exists) {
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found. Check available sessions with: rig ps --nodes`,
        };
      }
    } catch {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: "tmux is not available. Ensure tmux is installed and a server is running.",
      };
    }

    // 2. Mid-work check (unless force)
    if (!opts?.force) {
      try {
        if (runtime === "terminal") {
          const paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
          if (paneCommand && !IDLE_TERMINAL_COMMANDS.has(paneCommand)) {
            return {
              ok: false,
              sessionName,
              reason: "mid_work",
              error: `Target pane appears mid-task. Use force: true to send anyway, or wait for the task to settle.`,
            };
          }
        }
        const paneContent = await this.tmuxAdapter.capturePaneContent(sessionName, 5);
        if (paneContent && looksLikeMidWork(paneContent)) {
          return {
            ok: false,
            sessionName,
            reason: "mid_work",
            error: `Target pane appears mid-task. Use force: true to send anyway, or wait for the task to settle.`,
          };
        }
      } catch {
        // Can't check — proceed anyway
      }
    }

    if (opts?.verify) {
      try {
        preVerifyContent = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
      } catch {
        preVerifyContent = null;
      }
    }

    // 3. Send text (paste)
    const textResult = await this.tmuxAdapter.sendText(sessionName, text);
    if (!textResult.ok) {
      return {
        ok: false,
        sessionName,
        reason: "send_failed",
        error: `Failed to send text to '${sessionName}': ${textResult.message}`,
      };
    }

    // 4. Wait 200ms (spike-proven delay)
    await delay(200);

    // 5. Submit (C-m)
    const submitResult = await this.tmuxAdapter.sendKeys(sessionName, ["C-m"]);
    if (!submitResult.ok) {
      return {
        ok: false,
        sessionName,
        reason: "submit_failed",
        error: `Text is visible in '${sessionName}' but was not submitted (Enter failed). The agent may need manual attention.`,
      };
    }

    // 6. Verify if requested
    if (opts?.verify) {
      await delay(500);
      try {
        const content = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
        const snippet = text.substring(0, Math.min(text.length, 40));
        const preCount = countOccurrences(preVerifyContent ?? "", snippet);
        const postCount = countOccurrences(content ?? "", snippet);
        const verified = postCount > preCount;
        return { ok: true, sessionName, verified };
      } catch {
        return { ok: true, sessionName, verified: false };
      }
    }

    return { ok: true, sessionName };
  }

  async capture(sessionName: string, opts?: { lines?: number }): Promise<CaptureResult> {
    try {
      const exists = await this.tmuxAdapter.hasSession(sessionName);
      if (!exists) {
        return {
          ok: false,
          sessionName,
          error: `Session '${sessionName}' not found. Check available sessions with: rig ps --nodes`,
        };
      }
    } catch {
      return {
        ok: false,
        sessionName,
        error: "tmux is not available. Ensure tmux is installed and a server is running.",
      };
    }

    const lines = opts?.lines ?? 20;
    const content = await this.tmuxAdapter.capturePaneContent(sessionName, lines);
    if (content === null) {
      return {
        ok: false,
        sessionName,
        error: `Could not capture pane content for '${sessionName}'.`,
      };
    }

    return { ok: true, sessionName, content, lines };
  }

  async broadcast(target: TargetSpec, text: string, opts?: SendOpts): Promise<BroadcastResult> {
    const resolved = await this.resolveSessions(target);
    if (!resolved.ok) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        results: [{
          ok: false,
          sessionName: "",
          reason: resolved.code,
          error: resolved.error,
        }],
      };
    }

    const results: SendResult[] = [];
    for (const session of resolved.sessions) {
      const result = await this.send(session.sessionName, text, opts);
      results.push(result);
    }

    return {
      total: results.length,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
