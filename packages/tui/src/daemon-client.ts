// The TUI's ONLY daemon surface — thin typed fetch wrappers over the §4.A
// endpoint table, ONE module by design: the R7 no-new-data source-check is a
// one-file read (every route below is an EXISTING, web-consumed daemon read).
// Daemon-direct, never via the Studio serve-shell (FR-9). Phase 1 ships the
// wrappers; Phase 2 binds the three sections to them.
export interface DaemonClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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

export class DaemonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env["OPENRIG_URL"] ?? "http://127.0.0.1:7433").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
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
  queueAttention() {
    return this.get(`/api/queue/list?attention=1`);
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
  streamList(limit = 5) {
    return this.get(`/api/stream/list?limit=${limit}`);
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
  launchNode(rigId: string, logicalId: string) {
    return this.post(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/launch`, {});
  }
}
