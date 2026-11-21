// OpenRig seat extension for Oh My Pi (OMP).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** The sidecar and post contract this file speaks. The daemon refuses nothing on it; it is recorded for diagnosis. */
export const SEAT_PROTOCOL = 1;
/** How long an idle report holds without a newer one (the daemon expires it after two missed beats). */
export const IDLE_LIVENESS_SECONDS = 180;
/** How long one working beat counts (the daemon clamps it to 5-60 s). */
export const WORK_LIVENESS_SECONDS = 30;
const WORK_BEAT_MS = 10_000;
const IDENTITY_RETRY_MS = 30_000;
const POST_TIMEOUT_MS = 2_000;
const MAX_QUEUED_POSTS = 256;

const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Wrap a bare IPv6 literal in brackets so it is a valid URL host. */
function hostForUrl(host) {
  const value = host.trim();
  if (value.startsWith("[") && value.endsWith("]")) return value;
  return value.includes(":") ? `[${value}]` : value;
}

/** What OpenRig told this process about its seat. Null when this OMP isn't a managed seat. */
export function readSeatConfig(env) {
  const sessionName = trimmed(env.OPENRIG_SESSION_NAME);
  const statePath = trimmed(env.OPENRIG_OMP_SEAT_STATE);
  if (!sessionName || !statePath) return null;
  return {
    sessionName,
    statePath,
    launchId: trimmed(env.OPENRIG_OMP_LAUNCH_ID),
    nodeId: trimmed(env.OPENRIG_NODE_ID),
    generation: trimmed(env.OPENRIG_OCCUPANT_GENERATION),
    contextSidecarPath: trimmed(env.OPENRIG_OMP_CONTEXT_SIDECAR),
  };
}

/** The daemon's activity endpoint: the launch environment first, then the instance's endpoint file. */
export function resolveActivityEndpoint(env, readFile = (file) => fs.readFileSync(file, "utf8")) {
  let baseUrl = trimmed(env.OPENRIG_URL);
  let token = trimmed(env.OPENRIG_ACTIVITY_HOOK_TOKEN);
  const port = trimmed(env.OPENRIG_PORT);
  if (!baseUrl && port) baseUrl = `http://${hostForUrl(trimmed(env.OPENRIG_HOST) ?? "127.0.0.1")}:${port}`;
  if (!baseUrl || !token) {
    const home = trimmed(env.OPENRIG_HOME);
    if (home) {
      try {
        const parsed = JSON.parse(readFile(path.join(home, "activity-endpoint.json")));
        if (!baseUrl && typeof parsed.baseUrl === "string") baseUrl = parsed.baseUrl;
        if (!token && typeof parsed.token === "string") token = parsed.token;
      } catch {
        // Absent or malformed: activity posts are skipped; the sidecar still serves launch and readiness.
      }
    }
  }
  return baseUrl && token ? { baseUrl, token } : null;
}

/** Replace a file's content so a reader never sees a partial write. */
function writeFileAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** How the turn's last assistant message ended, as OMP reports it. */
function stopReasonOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && message.role === "assistant") return typeof message.stopReason === "string" ? message.stopReason : null;
  }
  return null;
}

/**
 * The seat's reporter: OMP's lifecycle events in, sidecar writes and daemon posts out. Everything it touches
 * outside the process is injected, so a test can drive it without OMP, a daemon or a clock.
 */
export function createSeatReporter(options) {
  const { seat } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const post = options.post ?? (async () => null);
  const writeFile = options.writeFile ?? writeFileAtomic;
  const fileExists = options.fileExists ?? ((file) => fs.existsSync(file));
  const schedule = options.schedule ?? ((fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return timer; });
  const cancel = options.cancel ?? ((timer) => clearInterval(timer));
  const pid = options.pid ?? process.pid;

  let sequence = 0;
  let turn = 0;
  let turnOpen = false;
  /** Held from an approval request or a failed turn until the agent moves again: no idle report is sent while set. */
  let attention = null;
  const pendingApprovals = new Set();
  let session = { file: null, id: null };
  let auth = "unknown";
  let model = null;
  let identityPersisted = false;
  let identityInFlight = false;
  let sessionVersion = 0;
  let inputReceipt = null;
  let inputSequence = 0;
  let inputAvailable = false;
  let latestContext = null;
  let exited = false;
  let workTimer = null;
  let idleTimer = null;
  let identityTimer = null;

  // One post at a time, in the order the events happened: the daemon orders by time then sequence, and a beat
  // still in flight when a turn starts must not land after the turn's first post.
  let queued = 0;
  let tail = Promise.resolve();
  const enqueue = (body) => {
    if (queued >= MAX_QUEUED_POSTS) return Promise.resolve(null);
    queued++;
    const result = tail.then(() => post(body)).catch(() => null);
    tail = result.then(() => { queued--; });
    return result;
  };

  const activity = (hookEvent, subtype, extra = {}) => enqueue({
    sequence: ++sequence,
    sessionName: seat.sessionName,
    nodeId: seat.nodeId,
    generation: seat.generation,
    runtime: "omp-tui",
    hookEvent,
    subtype,
    ...extra,
    occurredAt: now(),
  });

  const writeState = (patch = {}) => {
    try {
      writeFile(seat.statePath, JSON.stringify({
        ready: !exited,
        launchId: seat.launchId ?? undefined,
        nodeId: seat.nodeId ?? undefined,
        generation: seat.generation ?? undefined,
        sessionFile: session.file ?? undefined,
        sessionId: session.id ?? undefined,
        protocol: SEAT_PROTOCOL,
        pid,
        auth,
        inputProtocol: inputAvailable ? 1 : undefined,
        inputReceipt: inputReceipt ?? undefined,
        model: model ?? undefined,
        updatedAt: now(),
        ...patch,
      }));
      return true;
    } catch {
      // The daemon reads a missing or stale sidecar as "not ready yet"; never fail the session over it.
      return false;
    }
  };

  const stopTimer = (timer) => { if (timer !== null) cancel(timer); return null; };

  const startWorkBeats = () => {
    workTimer = stopTimer(workTimer);
    workTimer = schedule(() => {
      // A beat says only that this turn is still outstanding and OMP is alive. It never starts or extends a turn.
      if (!turnOpen || attention || exited) return;
      void activity("active", "liveness", { turnId: String(turn), livenessSeconds: WORK_LIVENESS_SECONDS });
    }, WORK_BEAT_MS);
  };

  const startIdleBeats = () => {
    idleTimer = stopTimer(idleTimer);
    idleTimer = schedule(() => {
      if (turnOpen || attention || exited) return;
      void activity("Stop", "idle_heartbeat", { livenessSeconds: IDLE_LIVENESS_SECONDS });
    }, IDLE_LIVENESS_SECONDS * 1000);
  };

  /** OMP writes a new session's file with its first turn. Until then there is no history to resume, so nothing
   *  is claimed; identity is posted again after each turn until the daemon confirms it stored the file. */
  const postIdentity = () => {
    if (exited || identityPersisted || identityInFlight) return;
    if (!session.file || !session.id || !fileExists(session.file)) return;
    identityInFlight = true;
    const version = sessionVersion;
    void enqueue({
      eventFamily: "session_identity",
      sessionName: seat.sessionName,
      nodeId: seat.nodeId,
      generation: seat.generation,
      runtime: "omp-tui",
      sessionId: session.id,
      sessionFile: session.file,
    }).then((reply) => {
      if (version === sessionVersion && reply?.tokenPersisted === true) identityPersisted = true;
    }).finally(() => {
      identityInFlight = false;
      if (version !== sessionVersion) postIdentity();
    });
  };

  const observeSession = (ctx) => {
    const manager = ctx?.sessionManager;
    const file = trimmed(manager?.getSessionFile?.());
    const id = trimmed(manager?.getSessionId?.());
    latestContext = ctx;
    if (file !== session.file || id !== session.id) { identityPersisted = false; sessionVersion++; }
    session = { file, id };
  };

  /** Whether the session has a model it can call. OMP starts without one and only fails at the first prompt, so the
   *  daemon reads this instead of waiting for a turn that can't run. */
  const observeModel = (ctx) => {
    let current;
    try { current = ctx?.model; } catch { current = undefined; }
    model = current && current.provider && current.id ? `${current.provider}/${current.id}` : null;
    try {
      const available = ctx?.models?.list?.();
      if (!Array.isArray(available)) { auth = current ? "unknown" : "missing"; return; }
      auth = current && available.some((entry) => entry && entry.provider === current.provider && entry.id === current.id)
        ? "ok" : "missing";
    } catch {
      auth = "unknown";
    }
  };

  const writeContextUsage = (ctx, invalidateMissing = false) => {
    if (!seat.contextSidecarPath) return;
    let usage;
    try { usage = ctx?.getContextUsage?.(); } catch { /* Usage can be unavailable just after /clear. */ }
    const used = Number.isFinite(usage?.percent) ? Math.min(100, Math.max(0, usage.percent)) : null;
    if (used === null && !invalidateMissing) return;
    try {
      writeFile(seat.contextSidecarPath, JSON.stringify({
        source: "omp_extension",
        context_window: used === null ? undefined : {
          context_window_size: typeof usage.contextWindow === "number" ? usage.contextWindow : undefined,
          used_percentage: Math.round(used * 10) / 10,
          remaining_percentage: Math.round((100 - used) * 10) / 10,
          total_input_tokens: typeof usage.tokens === "number" ? usage.tokens : undefined,
        },
        session_id: session.id ?? undefined,
        session_name: seat.sessionName,
        occupant_generation: seat.generation ?? undefined,
        transcript_path: session.file ?? undefined,
        sampled_at: now(),
      }));
    } catch {
      // Context usage is advisory; a missed sample reads unknown.
    }
  };

  return {
    inputAvailable() { inputAvailable = true; },
    /** A managed paste is complete and staged through OMP's public editor API. */
    inputReceived(text, requestId, stagedText = text) {
      if (exited) return false;
      const receipt = { sequence: ++inputSequence, requestId, sha256: createHash("sha256").update(text).digest("hex") };
      if (stagedText !== text) receipt.stagedSha256 = createHash("sha256").update(stagedText).digest("hex");
      if (!writeState({ inputReceipt: receipt })) return false;
      inputReceipt = receipt;
      return true;
    },
    sessionStart(ctx) {
      exited = false;
      observeSession(ctx);
      observeModel(ctx);
      writeState();
      writeContextUsage(ctx);
      postIdentity();
      identityTimer = stopTimer(identityTimer);
      identityTimer = schedule(() => {
        if (latestContext) { observeModel(latestContext); writeState(); }
        postIdentity();
      }, IDENTITY_RETRY_MS);
      // A newly ready seat is at its prompt.
      if (!turnOpen) void activity("Stop", "idle_heartbeat", { livenessSeconds: IDLE_LIVENESS_SECONDS });
      startIdleBeats();
    },

    /** The person switched, branched or forked the conversation inside OMP: the seat now names another file. */
    sessionChanged(ctx) {
      const previousVersion = sessionVersion;
      observeSession(ctx);
      observeModel(ctx);
      if (sessionVersion !== previousVersion) {
        turnOpen = false;
        pendingApprovals.clear();
        attention = null;
        workTimer = stopTimer(workTimer);
        startIdleBeats();
        void activity("Stop", "idle_heartbeat", { livenessSeconds: IDLE_LIVENESS_SECONDS });
      }
      writeState();
      writeContextUsage(ctx);
      postIdentity();
    },

    sessionCleared(ctx) {
      // OMP retains the session identity across /clear. Publish even an unknown sample to replace the old one.
      writeContextUsage(ctx, true);
    },

    agentStart(ctx) {
      turn++;
      turnOpen = true;
      observeModel(ctx);
      if (pendingApprovals.size === 0) {
        attention = null;
        void activity("UserPromptSubmit", "accepted", { turnId: String(turn) });
      }
      startWorkBeats();
    },

    turnStart() {
      if (!turnOpen || attention) return;
      void activity("active", "turn_start", { turnId: String(turn) });
    },

    toolStart(event) {
      if (!turnOpen || attention) return;
      void activity("PreToolUse", trimmed(event?.toolName) ?? "tool", { turnId: String(turn) });
    },

    compactionStart() {
      if (attention) return;
      void activity("active", "compaction", turnOpen ? { turnId: String(turn) } : {});
    },

    compactionEnd(ctx) {
      writeContextUsage(ctx);
    },

    /** OMP is showing its approval prompt in the pane and waits there for a person. */
    approvalRequested(toolCallId, sessionId) {
      if ((sessionId && sessionId !== session.id) || pendingApprovals.has(toolCallId)) return;
      pendingApprovals.add(toolCallId);
      attention = "permission_prompt";
      void activity("Notification", "permission_prompt", turnOpen ? { turnId: String(turn) } : {});
    },

    approvalResolved(toolCallId, sessionId) {
      if (sessionId && sessionId !== session.id) return;
      if (!pendingApprovals.delete(toolCallId) || pendingApprovals.size || attention !== "permission_prompt") return;
      attention = null;
      if (turnOpen) void activity("active", "permission_resolved", { turnId: String(turn) });
    },

    turnEnd(ctx) {
      writeContextUsage(ctx);
    },

    agentEnd(event, ctx) {
      observeSession(ctx);
      observeModel(ctx);
      writeState();
      writeContextUsage(ctx);
      postIdentity();
      // Not a settle: OMP continues on its own, or a background job will resume the session.
      if (event?.willContinue === true) {
        if (!attention) void activity("active", "continuing", { turnId: String(turn) });
        return;
      }
      turnOpen = false;
      workTimer = stopTimer(workTimer);
      const reason = stopReasonOf(event?.messages);
      if (reason === "error") {
        // The turn failed (a provider error, an exhausted retry). OMP is back at its prompt, but the work did not
        // finish: hold attention instead of reporting idle, until the next turn starts.
        attention = "runtime_error";
        void activity("Notification", "runtime_error", { turnId: String(turn) });
        return;
      }
      if (attention) return;
      void activity("Stop", reason === "aborted" ? "cancelled" : reason === "length" ? "max_tokens" : "end_turn",
        { turnId: String(turn), livenessSeconds: IDLE_LIVENESS_SECONDS });
    },

    shutdown() {
      if (exited) return;
      exited = true;
      turnOpen = false;
      workTimer = stopTimer(workTimer);
      idleTimer = stopTimer(idleTimer);
      identityTimer = stopTimer(identityTimer);
      writeState({ ready: false, exited: { code: 0, at: now() } });
      // OMP's own exit: the seat is no longer at a prompt, so this reads unknown, never idle.
      return activity("Stop", "omp-tui_exited");
    },

    /** Test seam: resolves when every queued post has been sent. */
    settled: async () => { let pending; do { pending = tail; await pending; await Promise.resolve(); } while (tail !== pending); },
  };
}

/** Send one body to the daemon's hook ingress. Null on any failure: a post is never retried or awaited by OMP. */
export function createActivityPoster(endpoint, fetchImpl = globalThis.fetch) {
  const url = endpoint && URL.parse("/api/activity/hooks", endpoint.baseUrl);
  if (!url || !["http:", "https:"].includes(url.protocol) || typeof fetchImpl !== "function") return async () => null;
  return async (body) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url.href, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/** Whether this session is the seat's own conversation. OMP binds an extension to every subagent session too, and a
 *  subagent finishing must never read as the seat going idle. */
function isMainSession(ctx) {
  const agent = ctx?.agent;
  return !agent || agent.kind === undefined || agent.kind === "main";
}

/** OMP's extension entry point. */
export default function openrigSeat(pi) {
  const env = process.env;
  const seat = readSeatConfig(env);
  if (!seat) return;
  // A managed host launch keeps the install-wide token out of this process's environment (OMP hands its environment
  // to the shell tools it runs, and removing a variable here doesn't change that), so it is read from the instance's
  // endpoint file. A token in the environment is a seat's own activity grant, as a sandbox guest receives.
  const endpoint = resolveActivityEndpoint(env);
  const reporter = createSeatReporter({ seat, post: createActivityPoster(endpoint) });
  let unsubscribeInput;
  const registerInput = (ctx) => {
    unsubscribeInput?.();
    if (typeof ctx?.ui?.onTerminalInput === "function" && typeof ctx.ui.setEditorText === "function"
      && typeof ctx.ui.getEditorText === "function") {
      unsubscribeInput = ctx.ui.onTerminalInput(data => {
        // OMP's stdin buffer assembles the entire bracketed paste before this callback. Only the exact
        // managed request takes this path; native human pastes keep OMP's menus and attachment behavior.
        if (!data.startsWith("\x1b[200~") || !data.endsWith("\x1b[201~")) return;
        const text = data.slice(6, -6);
        let request;
        try { request = JSON.parse(fs.readFileSync(`${seat.statePath}.input.json`, "utf8")); } catch { return; }
        if (request.launchId !== seat.launchId || typeof request.id !== "string" || request.expiresAt < Date.now()
          || request.sha256 !== createHash("sha256").update(text).digest("hex")) return;
        // Do not overwrite a person's draft. Suppress the matching automated paste, but never acknowledge it.
        if (ctx.ui.getEditorText() !== "") return { consume: true };
        // Dispatch a short marker through the native focus route first. setEditorText alone also changes a
        // detached composer while a selector owns Enter, so it cannot prove that this paste reached the editor.
        const marker = `OPENRIG_INPUT_${request.id}`;
        setImmediate(() => {
          let ownedText = marker;
          let acknowledged = false;
          try {
            const current = JSON.parse(fs.readFileSync(`${seat.statePath}.input.json`, "utf8"));
            if (current.id !== request.id || current.expiresAt < Date.now() || ctx.ui.getEditorText() !== marker) return;
            // Only a focused editor that received our exact marker is replaced. This bypasses large-paste menus
            // and collapsed attachments for managed input.
            ctx.ui.setEditorText(text);
            ownedText = ctx.ui.getEditorText();
            // Stock OMP 18.22 uses LF and expands each tab to three spaces in setEditorText.
            const matches = ownedText === text || ownedText === text.replace(/\r\n?/g, "\n").replaceAll("\t", "   ");
            acknowledged = matches && reporter.inputReceived(text, request.id, ownedText);
          } catch { /* No acknowledgement: the sender withholds Enter. */ }
          finally {
            // Remove only this request’s marker or staged value, including OMP’s normalized text.
            try { if (!acknowledged && ctx.ui.getEditorText() === ownedText) ctx.ui.setEditorText(""); } catch { /* Editor disposed. */ }
          }
        });
        return { data: `\x1b[200~${marker}\x1b[201~` };
      });
      reporter.inputAvailable();
    }
  };

  const main = (handler) => (event, ctx) => {
    if (!isMainSession(ctx)) return;
    try { return handler(event, ctx); } catch { /* reporting never fails the session */ }
  };

  pi.on("session_start", main((_event, ctx) => {
    registerInput(ctx);
    reporter.sessionStart(ctx);
  }));
  // OMP clears terminal listeners before a switch, even when another extension cancels it.
  pi.on("session_before_switch", main((_event, ctx) => registerInput(ctx)));
  pi.on("session_before_branch", main((_event, ctx) => registerInput(ctx)));
  pi.on("session_switch", main((_event, ctx) => { registerInput(ctx); reporter.sessionChanged(ctx); }));
  pi.on("session_branch", main((_event, ctx) => { registerInput(ctx); reporter.sessionChanged(ctx); }));
  pi.on("session_clear", main((_event, ctx) => reporter.sessionCleared(ctx)));
  pi.on("agent_start", main((_event, ctx) => reporter.agentStart(ctx)));
  pi.on("turn_start", main(() => reporter.turnStart()));
  pi.on("turn_end", main((_event, ctx) => reporter.turnEnd(ctx)));
  pi.on("tool_execution_start", main((event) => reporter.toolStart(event)));
  pi.on("tool_approval_requested", main((event) => reporter.approvalRequested(event.toolCallId, event.sessionId)));
  pi.on("tool_approval_resolved", main((event) => reporter.approvalResolved(event.toolCallId, event.sessionId)));
  pi.on("auto_compaction_start", main(() => reporter.compactionStart()));
  pi.on("auto_compaction_end", main((_event, ctx) => reporter.compactionEnd(ctx)));
  pi.on("session_compact", main((_event, ctx) => reporter.compactionEnd(ctx)));
  pi.on("agent_end", main((event, ctx) => reporter.agentEnd(event, ctx)));
  pi.on("session_shutdown", main(() => { unsubscribeInput?.(); return reporter.shutdown(); }));
}
