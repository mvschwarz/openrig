import type { PageRead } from "./page-read.js";
import type { ProjectSelection } from "./types.js";
// The TUI's ONLY daemon surface — thin typed fetch wrappers over the §4.A
// endpoint table, ONE module by design: the R7 no-new-data source-check is a
// one-file read (every route below is an EXISTING, web-consumed daemon read).
// Daemon-direct, never via the Studio serve-shell (FR-9). Phase 1 ships the
// wrappers; Phase 2 binds the three sections to them.

/** Usage across hosts: the daemon answers by its 15 s view deadline; 15 s + 5 s for its own read and the transfer. */
export const USAGE_HOSTS_VIEW_WAIT_MS = 20_000;

export interface DaemonClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string>);
}

export class StartupRequestError extends Error {
  constructor(readonly status: number, readonly result: Record<string, unknown>) {
    super([String(result.message ?? result.error ?? `Startup request returned HTTP ${status}`),
      ...(Array.isArray(result.warnings) ? result.warnings.filter((w): w is string => typeof w === "string") : []),
    ].join("\n"));
  }
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
  absent: Array<{ seat: string; reason: string }>;
  degraded: Array<{ seat: string; reason: string }>;
  pages: number;
  error?: string;
  code?: string;
  notes?: string[];
  reusedWorkspace?: { id: string; tabId: string; view: string };
}

export interface LaunchNodeResult {
  ok: boolean;
  code?: string;
  launched?: Array<{ logicalId?: string }>;
  alreadyRunning?: Array<{ logicalId?: string }>;
  warnings?: string[];
}

export function launchNodeNotice(agent: string, result: LaunchNodeResult): string {
  const notice = result.code === "already_running"
    ? `agent already running: ${agent}`
    : `agent run requested: ${agent}`;
  return [notice, ...(result.warnings ?? [])].join("\n");
}

export class DaemonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private optionalFetchImpl: typeof fetch;
  private readonly headerSource: Record<string, string> | (() => Record<string, string>);

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env["OPENRIG_URL"] ?? "http://127.0.0.1:7433").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.optionalFetchImpl = this.fetchImpl;
    this.headerSource = options.headers ?? {};
  }

  forPage(page: PageRead, signal: AbortSignal): DaemonClient {
    const client = new DaemonClient({ baseUrl: this.baseUrl, headers: this.headerSource,
      fetchImpl: page.fetch(this.fetchImpl, signal) });
    client.optionalFetchImpl = page.fetch(this.fetchImpl, signal, true);
    return client;
  }

  private get headers(): Record<string, string> {
    return typeof this.headerSource === "function" ? this.headerSource() : this.headerSource;
  }

  /** S19 AM-R18 — open the oracle's SSE event stream (FR-8: HTTP stays in THIS module).
   *  FEATURE-DETECTED: a non-OK or non-event-stream answer (an older daemon, a foreign
   *  server) returns null — the caller disables the leg permanently and the TUI behaves
   *  exactly as S16 shipped it (click-to-refresh). Never retried on null. Opening
   *  timeouts/network errors reject so the subscriber can back off and retry. */
  async openActivityEvents(): Promise<Response | null> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5_000);
    deadline.unref?.();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/activity/events`, {
        headers: { ...this.headers, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        // No subscriber will own a rejected body; release its connection now.
        void res.body?.cancel().catch(() => {});
        return null;
      }
      return res;
    } finally {
      // Bound only opening headers; an established SSE stream stays live.
      clearTimeout(deadline);
    }
  }

  private async get(route: string, fetchImpl = this.fetchImpl): Promise<unknown> {
    const res = await fetchImpl(`${this.baseUrl}${route}`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      const parsed = await res.json().catch(() => null);
      const detail = parsed && typeof parsed === "object" && "error" in parsed ? ` — ${(parsed as { error: unknown }).error}` : "";
      throw new Error(`daemon read failed: GET ${route} → ${res.status}${detail}`);
    }
    return res.json();
  }

  private async post(route: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = parsed && typeof parsed === "object" && "error" in parsed ? ` — ${(parsed as { error: unknown }).error}` : "";
      throw new Error(`daemon write failed: POST ${route} → ${res.status}${detail}`);
    }
    return parsed;
  }

  /** Running daemon identity. `selfHostId` may be absent on an older daemon. */
  async configBrowser() {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/config?view=browser`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const reason = error instanceof Error && error.name === "TimeoutError" ? "Read timed out after 5 seconds."
        : code === "ECONNREFUSED" ? "Connection refused by the displayed daemon target."
        : code === "ENOTFOUND" ? "The displayed daemon hostname could not be resolved."
        : "Read failed; the cause was not identified.";
      throw new Error(reason);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} · ${res.status === 401 || res.status === 403 ? "Access denied by the displayed daemon."
      : res.status === 404 ? "CONFIG browser endpoint was not found; version compatibility is unverified."
      : "CONFIG could not be read; the cause was not identified."}`);
    const data = await res.json().catch(() => null) as Partial<import("./config/config-model.js").ConfigRead> | null;
    // Older daemons ignore the view query and return raw settings; never render that response.
    if (!data || data.readOnly !== true || !Array.isArray(data.entries) || !Array.isArray(data.sources) || !Array.isArray(data.exclusions)) {
      throw new Error("Response did not contain the CONFIG browser contract; compatibility is unverified.");
    }
    return data;
  }

  /** Delivered updates, in the same Feed view as the asks (`view`). */
  humanUpdates(view?: string | null) { return this.get(`/api/queue/human-updates?limit=20${view ? `&view=${encodeURIComponent(view)}` : ""}`); }
  connections() { return this.get("/api/gateway/connections"); }
  slackManifest() { return this.get("/api/gateway/slack/manifest"); }

  fileRoots() { return this.get("/api/files/roots") as Promise<{ roots: import("./reading.js").FileRoot[]; hint?: string }>; }

  async readFile(target: import("./reading.js").FileTarget): Promise<import("./reading.js").FileReadResult> {
    if (!target.root) return { error: "root_unknown", message: "Source is outside the configured readable roots. No other root was searched." };
    const query = new URLSearchParams({ root: target.root, path: target.path });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/files/read?${query}`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
      const data = await response.json() as Record<string, unknown> | null;
      if (!response.ok) return { error: String(data?.error ?? `HTTP ${response.status}`), message: String(data?.message ?? "Current file could not be read") };
      if (!data || typeof data.content !== "string" || typeof data.absolutePath !== "string" || typeof data.mtime !== "string" || typeof data.contentHash !== "string" || typeof data.truncated !== "boolean") {
        return { error: "invalid_file_response", message: "Reader did not serve current-file content and metadata" };
      }
      return data as unknown as import("./reading.js").FileRead;
    } catch (error) { return { error: "read_unavailable", message: error instanceof Error ? error.message : String(error) }; }
  }

  health() {
    return this.get("/healthz");
  }

  /** Slice 01 — the provider read model, as `rig provider status --json` prints it. GET only: the daemon answers it
   *  from memory and never starts a native read for it; this client never calls the refresh route. A failed or
   *  absent route resolves to its status (404: a daemon without provider routes) instead of throwing. */
  async providerStatus(): Promise<import("./usage/usage-model.js").UsageRead["status"]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/provider/status`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      return { status: null, error: error instanceof Error ? error.message : "Read failed; the cause was not identified." };
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) return { status: res.status, error: typeof data?.["error"] === "string" ? data["error"] : `HTTP ${res.status}` };
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: res.status, error: "the response was not a provider read model" };
    return { model: data };
  }

  /** Slice 01 — usage windows across registered hosts, as `rig provider status --all-hosts --json` prints them. GET
   *  only: the daemon and every host answer from memory, and this client has no method for the refresh route. A
   *  failed or absent route resolves to its status, with the daemon's own message (409: usage windows off here). */
  async usageAcrossHosts(): Promise<import("./usage/usage-hosts-model.js").UsageHostsRead["status"]> {
    let res: Response;
    try {
      // 20 s, not the usual 5 s: the daemon answers this view within its own 15 s deadline whatever the registry's
      // size (hosts it hasn't heard from by then are listed as such), plus 5 s for its own read and the transfer. The
      // page reader is per page, so a slow read here holds up neither other sections nor the live refresh of other pages.
      res = await this.fetchImpl(`${this.baseUrl}/api/provider/usage/hosts`, { headers: this.headers, signal: AbortSignal.timeout(USAGE_HOSTS_VIEW_WAIT_MS) });
    } catch (error) {
      return { status: null, error: error instanceof Error ? error.message : "Read failed; the cause was not identified." };
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      return {
        status: res.status,
        error: typeof data?.["error"] === "string" ? data["error"] : `HTTP ${res.status}`,
        ...(typeof data?.["message"] === "string" ? { message: data["message"] } : {}),
      };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: res.status, error: "the response was not a usage-across-hosts view" };
    return { view: data };
  }

  /** Slice 02 — the cost view, as `rig usage cost --json` prints it. GET only, computed from what the daemon already
   *  stores: no provider lookup, native read or charge lookup. A failed or absent route resolves to its status. */
  async usageCost(): Promise<import("./cost/cost-read.js").CostRead["status"]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/telemetry/usage/cost`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      return { status: null, error: error instanceof Error ? error.message : "Read failed; the cause was not identified." };
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) return { status: res.status, error: typeof data?.["error"] === "string" ? data["error"] : `HTTP ${res.status}` };
    // Every seat must be an object naming its seat and status, or the whole body isn't a cost view: a malformed
    // member reads as unavailable, never as a partial view or a render failure.
    const isSeat = (s: unknown) => !!s && typeof s === "object" && !Array.isArray(s)
      && typeof (s as Record<string, unknown>)["seatSession"] === "string" && typeof (s as Record<string, unknown>)["status"] === "string";
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data["seats"]) || !data["seats"].every(isSeat)) {
      return { status: res.status, error: "the response was not a cost view" };
    }
    return { body: { seats: data["seats"] as import("./cost/cost-read.js").CostBody["seats"], note: typeof data["note"] === "string" ? data["note"] : "" } };
  }

  /** Bounded canonical findings; the TUI filters this one record set by scope. */
  healthFindings(limit = 200) {
    return this.get(`/api/health?limit=${limit}`);
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
  /** With `host`, the rigs of that registered host, read through this daemon (its read-only `?host=` forwarding). */
  rigsSummary(host?: string) {
    return this.get(host ? `/api/rigs/summary?host=${encodeURIComponent(host)}` : `/api/rigs/summary`);
  }
  /** The registered hosts (`rig host list`), each with a quick reachability probe. */
  hosts() {
    return this.get(`/api/hosts`);
  }
  rigNodes(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
  }
  /** The existing per-seat effort report: requested, saved, emitted and observed.
   * A refusal is an answer, so the page reader doesn't count it as a failed read. */
  async seatEffort(seatRef: string): Promise<unknown> {
    const route = `/api/seat/effort/${encodeURIComponent(seatRef)}`;
    const res = await this.optionalFetchImpl(`${this.baseUrl}${route}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5_000),
    });
    const parsed = await res.json().catch(() => null);
    if (res.ok) return parsed;
    if (parsed && typeof parsed === "object"
      && (parsed as { ok?: unknown }).ok === false
      && typeof (parsed as { code?: unknown }).code === "string"
      && typeof (parsed as { message?: unknown }).message === "string") {
      return parsed;
    }
    if (res.status === 404 && parsed == null) return null;
    const detail = parsed && typeof parsed === "object" && "error" in parsed
      ? ` — ${(parsed as { error: unknown }).error}`
      : "";
    throw new Error(`daemon read failed: GET ${route} → ${res.status}${detail}`);
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
  projects() { return this.get("/api/scopes/projects"); }
  private projectQuery(project?: ProjectSelection | null): string {
    return project ? `&project=${encodeURIComponent(project.id)}&projectRoot=${encodeURIComponent(project.root)}` : "";
  }
  scopesDetailed(project?: ProjectSelection | null) {
    return this.get(`/api/scopes?detail=1${this.projectQuery(project)}`);
  }

  /** EXECUTION view via the shipped generic view route; no new endpoint. */
  execution(mission?: string, project?: ProjectSelection | null) {
    const query = `${mission ? `&mission=${encodeURIComponent(mission)}` : ""}${this.projectQuery(project)}`;
    return this.get(`/api/views/execution${query ? "?" + query.slice(1) : ""}`);
  }
  /** Existing six-tab slice payload; read only for the opened slice. */
  sliceDetail(directory: string, mission?: string | null, project?: ProjectSelection | null) {
    const query = `${mission ? `&mission=${encodeURIComponent(mission)}` : ""}${this.projectQuery(project)}`;
    return this.get(`/api/slices/${encodeURIComponent(directory)}${query ? "?" + query.slice(1) : ""}`);
  }

  /** One bounded typed queue chronology for the current topology scope. */
  queueRecentTransitions(scope: { kind: "instance" } | { kind: "rig"; rig: string }, limit = 20) {
    const query = scope.kind === "instance"
      ? "scope=instance"
      : `scope=rig&rig=${encodeURIComponent(scope.rig)}`;
    return this.get(`/api/queue/recent-transitions?${query}&limit=${limit}`);
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
  humanAttention(item?: string | null, view?: string | null) {
    const query = [item ? `item=${encodeURIComponent(item)}` : null, view ? `view=${encodeURIComponent(view)}` : null].filter(Boolean).join("&");
    return this.get(`/api/attention${query ? `?${query}` : ""}`);
  }
  queueItem(qitemId: string, options: { optional?: boolean } = {}) {
    return this.get(`/api/queue/${encodeURIComponent(qitemId)}`, options.optional ? this.optionalFetchImpl : this.fetchImpl);
  }
  reviewRig() {
    return this.get(`/api/review/rig`);
  }
  reviewFleet() {
    return this.get(`/api/review/fleet`);
  }
  /** The mission-control write Steering uses to answer a request (POST /api/mission-control/action). */
  missionControlAction(input: { verb: "approve" | "answer" | "resolve"; qitemId: string; actorSession: string; questionId?: string; optionId?: string; decision?: string; authority?: "primary-user" }) {
    return this.post("/api/mission-control/action", input) as Promise<{ verb: string; qitemId: string; closedQitem: unknown;
      answer?: { outcome: "recorded" | "answered"; unanswered: string[]; message?: string } }>;
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
  async terminalViews(): Promise<{ saved: Array<{ id: string; name: string; members: Array<{ seat: string }> }>; rigs: string[] }> {
    return await this.get("/api/terminal/views") as { saved: Array<{ id: string; name: string; members: Array<{ seat: string }> }>; rigs: string[] };
  }
  /** The preview behind "Open terminals". That action opens through `rig terminal open --window`, which composes with
   *  Rex's layout from inside Rex and otherwise Herdr's (falling back to plain tmux), or, from inside cmux, through
   *  `rig terminal open --provider cmux`. Preview with the provider it will use: its planId is the open's expected plan.
   *  A provider-less preview may pick cmux, whose plan the window opener never matches. */
  async previewTerminal(view: string, provider: "herdr" | "rex" | "cmux" = "herdr"): Promise<import("./terminals/terminal-model.js").TerminalPreview> {
    // The interactive TUI has a TTY; measure each preview again after a resize. Unknown stays narrow. The cmux open sends
    // no width, and a wide one changes the kernel view's layout and so its plan, so a cmux preview sends none either.
    const columns = provider !== "cmux" && process.stdout.isTTY ? process.stdout.columns : undefined;
    const viewport = Number.isSafeInteger(columns) && columns! > 0 ? `&viewportColumns=${columns}` : "";
    return await this.get(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=${provider}${viewport}`) as import("./terminals/terminal-model.js").TerminalPreview;
  }
  async openTerminal(view: string, expectedPlan?: string): Promise<TerminalOpenResult> {
    const result = (await this.post(`/api/terminal/open`, { view, ...(expectedPlan !== undefined ? { expectedPlan } : {}) })) as TerminalOpenResult;
    if (!Array.isArray(result.opened) || result.opened.length === 0) {
      throw new Error(`terminal open failed: ${result.error ?? result.code ?? ([...new Set(result.degraded?.map(m => m.reason))].join("; ") || "no tiles opened")}`);
    }
    return result;
  }
  /** the `rig launch` per-seat contract */
  async launchNode(rigId: string, logicalId: string): Promise<LaunchNodeResult> {
    return (await this.post(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/launch`, {})) as LaunchNodeResult;
  }

  async startupRequest<T>(route: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/startup${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 15_000 : 120_000),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || result.ok === false) throw new StartupRequestError(response.status, result);
    return result as T;
  }
}
