// The TUI's ONLY daemon surface — thin typed fetch wrappers over the §4.A
// endpoint table, ONE module by design: the R7 no-new-data source-check is a
// one-file read (every route below is an EXISTING, web-consumed daemon read).
// Daemon-direct, never via the Studio serve-shell (FR-9). Phase 1 ships the
// wrappers; Phase 2 binds the three sections to them.
export interface DaemonClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** One poll of a fleet-restore attempt (the daemon's GET status shape). The verdict is
 *  derived server-side from the rollup counts (never a stored field). */
export interface RestoreFleetStatus {
  done: boolean;
  cancelled: boolean;
  verdict: string;
  rollup: {
    counts: { fully_restored: number; partially_restored: number; failed: number; not_attempted: number };
    sequence: Array<{ rigId: string; outcome: string; reason?: string; remediation?: string }>;
    attention_required: Array<{ rigId: string; seat: string; need: string }>;
  };
}

export interface TerminalOpenResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: unknown[];
  degraded: unknown[];
  pages: number;
  error?: string;
  code?: string;
}

export interface LaunchNodeResult {
  ok: boolean;
  code?: string;
  launched?: Array<{ logicalId?: string }>;
  alreadyRunning?: Array<{ logicalId?: string }>;
}

export function launchNodeNotice(agent: string, result: LaunchNodeResult): string {
  return result.code === "already_running"
    ? `agent already running: ${agent}`
    : `agent run requested: ${agent}`;
}

export class DaemonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env["OPENRIG_URL"] ?? "http://127.0.0.1:7433").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** S19 AM-R18 — open the oracle's SSE event stream (FR-8: HTTP stays in THIS module).
   *  FEATURE-DETECTED: a non-OK or non-event-stream answer (an older daemon, a foreign
   *  server) returns null — the caller disables the leg permanently and the TUI behaves
   *  exactly as S16 shipped it (click-to-refresh). Never retried on null. */
  async openActivityEvents(): Promise<Response | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/activity/events`, {
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return null;
      return res;
    } catch {
      return null; // unreachable daemon at open — the leg stays off; refresh still works
    }
  }

  private async get(route: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`);
    if (!res.ok) throw new Error(`daemon read failed: GET ${route} → ${res.status}`);
    return res.json();
  }

  private async post(route: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = parsed && typeof parsed === "object" && "error" in parsed ? ` — ${(parsed as { error: unknown }).error}` : "";
      throw new Error(`daemon write failed: POST ${route} → ${res.status}${detail}`);
    }
    return parsed;
  }

  // --- Crash-cart fleet restore (B1 conductor — the TUI OWNS the kick/poll/cancel
  //     lifecycle so it can retain the attempt id, render progress from the poll stream,
  //     and reach the cancel endpoint; it no longer delegates blind to a buffered child) ---
  /** Kick the async fleet restore; the daemon answers on-commit with a fleet-attempt handle. */
  restoreFleet(): Promise<{ fleetAttemptId: string; status: string }> {
    return this.post("/api/crash-cart/restore-fleet", {}) as Promise<{ fleetAttemptId: string; status: string }>;
  }
  /** Poll one fleet-attempt's progress + rollup + derived verdict. */
  restoreFleetStatus(id: string): Promise<RestoreFleetStatus> {
    return this.get(`/api/crash-cart/restore-fleet/${encodeURIComponent(id)}`) as Promise<RestoreFleetStatus>;
  }
  /** Request stop-before-next-rig cancel on a running fleet attempt. */
  cancelRestoreFleet(id: string): Promise<{ ok: boolean; cancelled: boolean }> {
    return this.post(`/api/crash-cart/restore-fleet/${encodeURIComponent(id)}/cancel`, {}) as Promise<{
      ok: boolean;
      cancelled: boolean;
    }>;
  }

  // --- Topology (§4.A rows 1–3) ---
  rigGraph(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/graph`);
  }
  ps() {
    return this.get(`/api/ps`);
  }
  rigsSummary() {
    return this.get(`/api/rigs/summary`);
  }
  rigNodes(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
  }
  reviewAgents(scope: "rig" | "fleet" = "rig") {
    return this.get(`/api/review/agents?scope=${scope}`);
  }

  // --- Specs (§4.A row 4) ---
  specsLibrary(kind?: string) {
    return this.get(`/api/specs/library${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`);
  }
  rigSpec(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/spec.json`);
  }
  /** structured spec detail (spec-library.ts /:id/review — the live route;
   * the spec's §4.A cite `GET /api/specs/review` 404s at tip, QA-found) */
  specLibraryReview(id: string) {
    return this.get(`/api/specs/library/${encodeURIComponent(id)}/review`);
  }

  // --- Needs-You (§4.A rows 5–6): composeNeedsYou legs + host/rig-down beside ---
  /** SCOPES view (d64d2f5c): the store-direct one-read hydrate. */
  scopesDetailed() {
    return this.get("/api/scopes?detail=1");
  }

  queueAttention() {
    return this.get(`/api/queue/list?attention=1`);
  }
  /** ALL blocked qitems via the SAME shipped /list route with ?state=blocked
   * (queue.ts reads c.req.query("state") and filters). Mirror of queueAttention
   * — a client-method addition on an existing route, NOT a new endpoint.
   * The PULSE render filters these to NON-human blockedOn. */
  queueBlocked() {
    return this.get(`/api/queue/list?state=blocked`);
  }
  /** ALL in-progress qitems via the SAME shipped /list route with ?state=in-progress
   * (queue.ts reads c.req.query("state") and filters). Mirror of queueBlocked — a
   * client-method addition on an existing route, NOT a new endpoint. The PULSE
   * PARKED join keeps only idle, un-handed-off owners. */
  queueInProgress() {
    return this.get(`/api/queue/list?state=in-progress`);
  }
  /** ALL unclaimed pending qitems via the SAME shipped /list route with
   * ?state=pending (the UP NEXT backlog). Mirror of queueInProgress — a
   * client-method addition on an existing route, NOT a new endpoint. The daemon
   * serves ts_created DESC; the PULSE render keeps only unclaimed + caps display.
   * Bounded so a huge backlog can't unbound the frame. */
  queuePending(limit = 50) {
    return this.get(`/api/queue/list?state=pending&limit=${limit}`);
  }
  /** Recent terminal transitions (JUST FINISHED) via the SAME shipped /list
   * route with a COMMA multi-state ?state=done,handed-off (queue.ts splits
   * stateRaw on ","). No fleet-wide finish-time transitions endpoint exists, so
   * this is a bounded RECENT WINDOW fetched in ts_created order; the PULSE render
   * re-sorts by tsUpdated DESC (finish time) for newest-first. NOT a new endpoint. */
  queueRecentlyFinished(limit = 20) {
    return this.get(`/api/queue/list?state=done,handed-off&limit=${limit}`);
  }
  /** A single qitem by id via the shipped GET /api/queue/:qitemId (queue.ts:864,
   * returns the QueueItem or 404). Used for the BLOCKED ON AGENTS bounded per-row
   * lookup: blockedOn is a qitem POINTER, so the blocking agent is that qitem's
   * owner (destinationSession). NOT a new endpoint. */
  queueItem(qitemId: string) {
    return this.get(`/api/queue/${encodeURIComponent(qitemId)}`);
  }
  reviewRig() {
    return this.get(`/api/review/rig`);
  }
  reviewFleet() {
    return this.get(`/api/review/fleet`);
  }
  attentionAggregate() {
    return this.get(`/api/queue/attention-aggregate`);
  }
  rigStatus(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/status`);
  }

  // --- rig-stream footer (§4.A row 7: the rig stream read surface) ---
  /** legacy chronological page contract, retained for additive API compatibility */
  streamList(limit = 100, afterSortKey?: string) {
    return this.get(`/api/stream/list?limit=${limit}${afterSortKey ? `&afterSortKey=${encodeURIComponent(afterSortKey)}` : ""}`);
  }
  /** newest bounded page of the maintained active stream, returned oldest→newest */
  streamLatest(limit = 5) {
    return this.get(`/api/stream/list?limit=${limit}&direction=latest`);
  }

  // --- drive-structure writes (BR-8: EXISTING contracts only; the ONLY two) ---
  /** the web's TerminalLauncher contract: POST /api/terminal/open {view} */
  async openTerminal(view: string): Promise<TerminalOpenResult> {
    const result = (await this.post(`/api/terminal/open`, { view })) as TerminalOpenResult;
    if (!Array.isArray(result.opened) || result.opened.length === 0) {
      throw new Error(`terminal open failed: ${result.error ?? result.code ?? "no tiles opened"}`);
    }
    return result;
  }
  /** the `rig launch` per-seat contract */
  async launchNode(rigId: string, logicalId: string): Promise<LaunchNodeResult> {
    return (await this.post(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/launch`, {})) as LaunchNodeResult;
  }
}
