// The TUI's ONLY daemon surface — thin typed fetch wrappers over the §4.A
// endpoint table, ONE module by design: the R7 no-new-data source-check is a
// one-file read (every route below is an EXISTING, web-consumed daemon read).
// Daemon-direct, never via the Studio serve-shell (FR-9). Phase 1 ships the
// wrappers; Phase 2 binds the three sections to them.
export interface DaemonClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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
  specsReview() {
    return this.get(`/api/specs/review`);
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
}
