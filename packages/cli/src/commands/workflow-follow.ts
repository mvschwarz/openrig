import type { DaemonClient } from "../client.js";

/**
 * OPR.0.4.6.WF3 FR-1 — the shared follow engine behind `rig workflow
 * run` and `rig workflow watch`: two verbs, ONE renderer (the argo
 * shape: same render at attach and live).
 *
 * Transport: the SHIPPED workflow SSE endpoint (`GET
 * /api/workflow/sse`) consumed with the in-repo chatroom reader
 * pattern (fetch + event-stream line decode). Zero daemon changes
 * (BR-2) — this file only reads.
 *
 * Attach race (arch R2, snapshot-first-then-stream): the stream is
 * OPENED first, then a state snapshot (`/trace`) is rendered, then
 * live events flow. Events that duplicate a trail row already in the
 * snapshot are deduped by priorQitemId, so fast early steps that
 * close before attach are still shown exactly once.
 *
 * Exit codes (arch n1 — outcome codes DISTINCT from error codes):
 *   0 = workflow completed
 *   3 = workflow FAILED (the outcome-as-exit-code kubectl default —
 *       a workflow that fails is a command that fails; never collides
 *       with the shipped 1=4xx / 2=5xx transport codes)
 */
export const EXIT_WORKFLOW_FAILED = 3;

/** Terminal statuses a follow run resolves on. */
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export interface FollowInstanceView {
  instanceId: string;
  workflowName?: string;
  status: string;
  currentStepId?: string | null;
  currentFrontier?: string[];
}

export interface FollowTrailRow {
  stepId: string;
  stepRole?: string;
  closedAt?: string;
  closureReason: string;
  actorSession: string;
  nextQitemId?: string | null;
  priorQitemId: string;
}

interface WorkflowEvent {
  type: string;
  instanceId?: string;
  stepId?: string;
  closureReason?: string;
  actorSession?: string;
  priorQitemId?: string;
  nextQitemId?: string;
  nextOwner?: string;
  nextStepId?: string;
  workflowName?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface FollowIo {
  /** stdout line sink (tests inject; default console.log). */
  out: (line: string) => void;
  /** stderr line sink for honest transport-state notices. */
  err: (line: string) => void;
  /** sleep injection so tests never wait wall-clock. */
  sleep: (ms: number) => Promise<void>;
  /** fetch injection for the SSE leg (tests stub the stream). */
  fetchImpl: typeof fetch;
}

export function realFollowIo(): FollowIo {
  return {
    out: (line) => console.log(line),
    err: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl: fetch,
  };
}

export interface FollowOptions {
  json: boolean;
  io?: FollowIo;
  /** SSE reconnect attempts before degrading to the poll fallback. */
  maxReconnects?: number;
  /** Poll fallback interval (ms). */
  pollIntervalMs?: number;
}

const STATUS_GLYPH: Record<string, string> = {
  completed: "✔",
  failed: "✖",
  active: "●",
  waiting: "◐",
};

function glyphFor(status: string): string {
  return STATUS_GLYPH[status] ?? "●";
}

function renderTrailRow(row: FollowTrailRow): string {
  const exitGlyph = row.closureReason === "failed" ? "✖" : "✔";
  const next = row.nextQitemId ? ` → ${row.nextQitemId}` : "";
  return `  ${exitGlyph} ${row.stepId}  ${row.closureReason}  by ${row.actorSession}${next}`;
}

function renderEvent(event: WorkflowEvent): string | null {
  switch (event.type) {
    case "workflow.instantiated":
      return `  ● instance ${event.instanceId ?? ""} created${event.workflowName ? ` (${event.workflowName})` : ""}`;
    case "workflow.step_closed":
      return `  ${event.closureReason === "failed" ? "✖" : "✔"} ${event.stepId ?? "(step)"}  ${event.closureReason ?? ""}  by ${event.actorSession ?? "(unknown)"}`;
    case "workflow.next_qitem_projected":
      return `  → ${event.nextStepId ?? "(next)"}  owner ${event.nextOwner ?? "(unresolved)"}  packet ${event.nextQitemId ?? ""}`;
    case "workflow.completed":
      return `  ✔ workflow completed`;
    case "workflow.failed":
      return `  ✖ workflow FAILED: ${event.reason ?? "(no reason recorded)"}`;
    default:
      // routing_table_changed and future additive types render as a
      // neutral one-liner rather than being silently dropped.
      return `  · ${event.type}`;
  }
}

/** Outcome → process exit code, per the FR-1 contract. */
export function outcomeExitCode(status: string): number {
  if (status === "failed") return EXIT_WORKFLOW_FAILED;
  return 0;
}

interface SnapshotResult {
  instance: FollowInstanceView;
  trail: FollowTrailRow[];
}

async function fetchSnapshot(
  client: DaemonClient,
  instanceId: string,
): Promise<{ ok: true; snapshot: SnapshotResult } | { ok: false; status: number; body: unknown }> {
  const res = await client.get<{ instance?: FollowInstanceView; trail?: FollowTrailRow[] }>(
    `/api/workflow/${encodeURIComponent(instanceId)}/trace`,
  );
  if (res.status >= 400 || !res.data?.instance) {
    return { ok: false, status: res.status, body: res.data };
  }
  return { ok: true, snapshot: { instance: res.data.instance, trail: res.data.trail ?? [] } };
}

function renderSnapshot(snapshot: SnapshotResult, io: FollowIo, json: boolean): void {
  if (json) {
    io.out(JSON.stringify({ type: "snapshot", instance: snapshot.instance, trail: snapshot.trail }));
    return;
  }
  const inst = snapshot.instance;
  io.out(`${glyphFor(inst.status)} ${inst.instanceId}${inst.workflowName ? `  ${inst.workflowName}` : ""}  status=${inst.status}`);
  for (const row of snapshot.trail) io.out(renderTrailRow(row));
  if (inst.currentStepId) {
    io.out(`  ▸ at step ${inst.currentStepId}  frontier=[${(inst.currentFrontier ?? []).join(", ")}]`);
  }
}

/**
 * Follow one instance to a terminal state. Returns the exit code the
 * caller should set (0 completed / 3 failed / 1 transport-4xx / 2
 * transport-5xx). Never throws for stream drops — those degrade
 * honestly (reconnect notice → poll-fallback notice), per the
 * chatroom precedent: the render may fall back, it never freezes
 * silently.
 */
export async function followInstance(
  client: DaemonClient,
  instanceId: string,
  opts: FollowOptions,
): Promise<number> {
  const io = opts.io ?? realFollowIo();
  const maxReconnects = opts.maxReconnects ?? 3;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;

  // Walk-caught (VM iteration 2): without aborting the SSE connection
  // on return, the open socket keeps the node event loop alive and the
  // process hangs ~minutes after the terminal event before exiting —
  // a kubectl-style verb must exit PROMPTLY on outcome. Every return
  // path aborts via the finally below.
  const aborter = new AbortController();
  try {
    // 1. Open the stream FIRST (arch R2) so no event can fall between
    //    snapshot and attach. Events are buffered by the reader until
    //    the snapshot has rendered.
    const sseUrl = `${client.baseUrl}/api/workflow/sse`;
    let streamRes: Response | null = null;
    try {
      streamRes = await io.fetchImpl(sseUrl, {
        headers: { Accept: "text/event-stream" },
        signal: aborter.signal,
      });
      if (!streamRes.ok || !streamRes.body) streamRes = null;
    } catch {
      streamRes = null;
    }

    // 2. Snapshot + render.
    const snap = await fetchSnapshot(client, instanceId);
    if (!snap.ok) {
      io.out(JSON.stringify(snap.body ?? { error: "trace_failed" }, null, opts.json ? 0 : 2));
      return snap.status >= 500 ? 2 : 1;
    }
    renderSnapshot(snap.snapshot, io, opts.json);
    if (TERMINAL_STATUSES.has(snap.snapshot.instance.status)) {
      return outcomeExitCode(snap.snapshot.instance.status);
    }

    // Dedup guard: trail rows already rendered by the snapshot must not
    // re-render when the (already-open) stream replays their events.
    const seenClosures = new Set(snap.snapshot.trail.map((row) => row.priorQitemId));

    let reconnectsLeft = maxReconnects;
    // 3. Stream loop with honest degradation.
    while (true) {
      if (streamRes?.body) {
        const outcome = await consumeStream(streamRes.body, instanceId, seenClosures, io, opts.json);
        if (outcome !== null) return outcome;
        // Stream ended without a terminal event — the drop path.
        streamRes = null;
      }
      if (reconnectsLeft > 0) {
        reconnectsLeft -= 1;
        io.err(`stream dropped — reconnecting (${maxReconnects - reconnectsLeft}/${maxReconnects})`);
        try {
          const retry = await io.fetchImpl(sseUrl, {
            headers: { Accept: "text/event-stream" },
            signal: aborter.signal,
          });
          if (retry.ok && retry.body) {
            streamRes = retry;
            continue;
          }
        } catch {
          // fall through to next reconnect / poll fallback
        }
        continue;
      }
    // 4. Poll fallback — announced, never silent (the chatroom rule).
    io.err(`stream unavailable — degrading to poll fallback every ${Math.round(pollIntervalMs / 1000)}s`);
    while (true) {
      await io.sleep(pollIntervalMs);
      const poll = await fetchSnapshot(client, instanceId);
      if (!poll.ok) {
        io.out(JSON.stringify(poll.body ?? { error: "poll_failed" }, null, opts.json ? 0 : 2));
        return poll.status >= 500 ? 2 : 1;
      }
      // Render only trail rows not yet seen, preserving exactly-once.
      for (const row of poll.snapshot.trail) {
        if (seenClosures.has(row.priorQitemId)) continue;
        seenClosures.add(row.priorQitemId);
        if (opts.json) io.out(JSON.stringify({ type: "trail", row }));
        else io.out(renderTrailRow(row));
      }
      if (TERMINAL_STATUSES.has(poll.snapshot.instance.status)) {
        if (opts.json) io.out(JSON.stringify({ type: "terminal", status: poll.snapshot.instance.status }));
        else io.out(`  ${glyphFor(poll.snapshot.instance.status)} workflow ${poll.snapshot.instance.status}`);
        return outcomeExitCode(poll.snapshot.instance.status);
      }
    }
    }
  } finally {
    // Kill the SSE socket so the process exits promptly on outcome
    // (the walk-caught hang: an un-aborted keep-alive held the event
    // loop open for minutes after workflow.completed).
    aborter.abort();
  }
}

/**
 * Consume one SSE body until a terminal event for the instance (→
 * exit code) or stream end (→ null: caller reconnects/degrades).
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  instanceId: string,
  seenClosures: Set<string>,
  io: FollowIo,
  json: boolean,
): Promise<number | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let event: WorkflowEvent;
        try {
          event = JSON.parse(line.slice(5).trim()) as WorkflowEvent;
        } catch {
          continue; // malformed data line — skip (chatroom precedent)
        }
        if (event.instanceId !== instanceId) continue;
        if (event.type === "workflow.step_closed" && typeof event.priorQitemId === "string") {
          if (seenClosures.has(event.priorQitemId)) continue; // snapshot already showed it
          seenClosures.add(event.priorQitemId);
        }
        if (json) {
          io.out(JSON.stringify(event));
        } else {
          const rendered = renderEvent(event);
          if (rendered !== null) io.out(rendered);
        }
        if (event.type === "workflow.completed") return 0;
        if (event.type === "workflow.failed") return EXIT_WORKFLOW_FAILED;
      }
    }
  } catch {
    return null; // read error = drop; caller handles honestly
  } finally {
    reader.releaseLock();
  }
}
