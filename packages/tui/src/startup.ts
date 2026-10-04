import { DaemonClient, StartupRequestError } from "./daemon-client.js";
import { probeCrashCart, type CrashCartRenderOpts } from "./crash-cart/from-emit.js";
import { LocalReadingController, localLines, type LocalReadingState, type LocalRequest, type LocalResult } from "./local-reading.js";
import type { Action } from "./types.js";

export interface StartupSeat {
  logicalId: string; nodeId: string; runtime: string; model: string | null;
  revision: string; hasHistory: boolean; intendedAction: string; reason?: string;
  freshRequired: boolean; tokenState: string;
  freshAllowed?: boolean; prerequisite?: string; contextPending?: boolean;
  observed: { state: string; detail: string; sessionName: string };
}
interface StartupRig { rigId: string; rigName: string; seats: StartupSeat[] }
export interface StartupState {
  connection: "probing" | "up" | "down" | "unverified";
  local?: LocalReadingState;
  open: boolean; busy: boolean; page: "probe" | "down" | "unavailable" | "rigs" | "seats" | "kernel" | "confirm";
  target: string; home: string; notice: string; detail: string; expanded: boolean;
  selected: number; scroll: number; rigs: Array<{ id: string; name: string }>;
  rig?: StartupRig; probe?: CrashCartRenderOpts; freshBlocked?: string;
  prerequisites?: { codex: string; claudeCode: string };
  consent?: { rigId: string; seat: StartupSeat };
}
export interface StartupDeps {
  client: DaemonClient;
  home: string;
  probe: () => Promise<string>;
  startDaemon: () => Promise<void>;
  onChange: () => void;
  onHelp?: () => void;
  readLocal?: (request: LocalRequest) => Promise<LocalResult>;
  onNative?: (seat: StartupSeat) => Promise<void>;
  onWork: (rig?: Pick<StartupRig, "rigId" | "rigName">, seat?: StartupSeat) => void;
}

export class StartupController {
  readonly state: StartupState;
  private local?: LocalReadingController;
  private automaticEntry = true;
  /** Any user input, including Help and a control-socket command, owns navigation. */
  interacted(): void { this.automaticEntry = false; }
  constructor(private readonly deps: StartupDeps) {
    this.state = { connection: "probing", open: true, busy: false, page: "probe", target: deps.client.baseUrl,
      home: deps.home, notice: "Reading startup state…", detail: "", expanded: false,
      selected: 0, scroll: 0, rigs: [] };
  }
  private changed() { this.deps.onChange(); }
  private async run(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.changed();
    try { await action(); }
    catch (error) {
      this.state.notice = error instanceof Error ? error.message : String(error);
      this.state.detail = this.state.notice;
      if (error instanceof StartupRequestError && (error.status === 401 || error.status === 403 || error.result.freshAllowed === false)) {
        this.state.freshBlocked = this.state.notice;
      }
    } finally { this.state.busy = false; this.changed(); }
  }
  async open() {
    this.interacted();
    this.local?.close(); this.local = undefined; this.state.local = undefined;
    this.state.open = true; this.state.consent = undefined;
    this.changed(); await this.refresh();
  }
  async refresh() {
    await this.run(async () => {
      this.state.consent = undefined;
      this.state.connection = "probing";
      this.state.notice = "Reading actual state…";
      let rigs;
      try {
        // Normal entry uses the selected target's authenticated read and its existing
        // deadline. The shorter recovery probe is not a prerequisite for reading work.
        rigs = await this.deps.client.rigsSummary();
        if (!Array.isArray(rigs) || rigs.some((r) => !r || typeof r.id !== "string" || typeof r.name !== "string")) throw new Error("The daemon did not return a usable rig list.");
      } catch (error) {
        const probe = await probeCrashCart(this.deps.probe);
        const readError = error instanceof Error ? error.message : String(error);
        this.state.probe = probe;
        this.state.detail = [readError, probe.unavailable ?? JSON.stringify(probe.daemonEvidence ?? {})].join("\n");
        if (probe.daemonState === "down" && !probe.unavailable) {
          this.state.connection = "down";
          this.state.page = "down";
          this.state.notice = probe.crashCart?.mode === "first-run" ? "Welcome. This instance has no saved rigs yet." : "The daemon is stopped. Saved rigs remain available.";
        } else {
          this.state.connection = "unverified";
          this.state.page = "unavailable";
          this.state.notice = readError;
        }
        return;
      }
      this.state.probe = undefined;
      this.state.detail = "";
      this.state.connection = "up";
      this.state.rigs = rigs.sort((a, b) => Number(b.name === "kernel") - Number(a.name === "kernel") || a.name.localeCompare(b.name));
      if (this.state.rig && this.state.rigs.some((r) => r.id === this.state.rig!.rigId)) await this.readRig(this.state.rig.rigId);
      else { this.state.page = "rigs"; this.state.selected = 0; }
      this.state.notice = "Daemon connected. Choose what to bring back.";
      // The served fold is running only for a nonempty rig whose nodes are all
      // observed running. Missing, stopped, degraded and unverified are not proof.
      const running = rigs.find(r => r.lifecycleState === "running");
      if (this.automaticEntry && this.state.open && running) {
        this.automaticEntry = false;
        this.state.open = false;
        this.deps.onWork();
      }
    });
  }
  private async readRig(id: string) {
    const rig = await this.deps.client.startupRequest<StartupRig>(`/${encodeURIComponent(id)}`);
    if (!Array.isArray(rig.seats) || rig.seats.some((s) => typeof s.logicalId !== "string" || typeof s.revision !== "string" || !s.observed)) throw new Error("Seat startup choices are unavailable from this daemon.");
    rig.seats.sort((a, b) => Number(b.logicalId === "operator.agent") - Number(a.logicalId === "operator.agent") || a.logicalId.localeCompare(b.logicalId));
    this.state.rig = rig;
    this.state.page = "seats";
    this.state.selected = Math.min(this.state.selected, Math.max(0, rig.seats.length - 1));
    this.state.consent = undefined;
    this.state.freshBlocked = undefined;
  }
  async key(key: string) {
    this.interacted();
    const s = this.state;
    // Read navigation is independent of the serialized effect/probe lane.
    if (key === "?") { this.deps.onHelp?.(); return; }
    if (key === "w") {
      s.consent = undefined; s.open = false; this.local?.close(); s.local = undefined;
      this.deps.onWork(s.rig); this.changed(); return;
    }
    if (s.local && this.local) {
      if (!await this.local.key(key)) { s.local = undefined; this.local = undefined; }
      this.changed(); return;
    }
    if ((key === "L" || key === "l" && s.page !== "kernel")) {
      this.local = new LocalReadingController(this.deps.readLocal ?? (async () => ({ error: "Local reader unavailable in this launcher" })), () => this.changed());
      s.local = this.local.state; s.consent = undefined;
      if (s.page === "confirm") s.page = "seats";
      await this.local.load(); return;
    }
    if (key === "escape" && (s.busy || !["confirm", "seats", "kernel"].includes(s.page))) {
      s.consent = undefined; s.open = false; this.deps.onWork(); this.changed(); return;
    }
    if (s.busy) return;
    if (key === "d") { s.expanded = !s.expanded; this.changed(); return; }
    if (key === "r") { await this.refresh(); return; }
    if (key === "escape") {
      s.consent = undefined; s.scroll = 0;
      if (s.page === "confirm") { s.page = "seats"; s.notice = "Fresh start declined. No new conversation was launched."; }
      else if (["seats", "kernel"].includes(s.page)) { s.page = "rigs"; s.rig = undefined; s.selected = 0; }
      this.changed(); return;
    }
    const count = s.page === "rigs" ? s.rigs.length : s.rig?.seats.length ?? 0;
    if (s.expanded && (key === "up" || key === "down")) {
      s.scroll = Math.max(0, s.scroll + (key === "down" ? 1 : -1)); this.changed(); return;
    }
    if (key === "up" || key === "down" || key.startsWith("select:")) {
      const index = key.startsWith("select:") ? Number(key.slice(7)) : s.selected + (key === "down" ? 1 : -1);
      s.selected = Math.max(0, Math.min(count - 1, index)); s.expanded = false; s.freshBlocked = undefined;
      this.changed(); return;
    }
    if (s.page === "down" && ["s", "enter"].includes(key)) {
      let confirmed = false;
      await this.run(async () => { s.notice = "Starting this daemon only… seats will be selected next."; this.changed(); await this.deps.startDaemon(); confirmed = true; });
      const failure = s.notice;
      await this.refresh();
      if (!confirmed) { s.notice = failure; s.detail = failure; this.changed(); }
      return;
    }
    if (s.page === "rigs" && key === "k" && !s.rigs.some((r) => r.name === "kernel")) {
      await this.run(async () => { s.prerequisites = await this.deps.client.startupRequest("/prerequisites"); s.page = "kernel"; }); return;
    }
    if (s.page === "kernel" && ["c", "l"].includes(key)) {
      await this.run(async () => {
        const runtime = key === "c" ? "codex" : "claude-code";
        s.notice = "Preparing kernel topology… no seats are being launched."; this.changed();
        const result = await this.deps.client.startupRequest<{ rigId: string }>("/kernel", { runtime });
        s.selected = 0; await this.readRig(result.rigId);
        s.notice = "Kernel prepared. The operator is recommended; choose the seat to start.";
      }); return;
    }
    if (s.page === "rigs" && key === "enter" && s.rigs[s.selected]) {
      await this.run(async () => { const id = s.rigs[s.selected]!.id; s.selected = 0; await this.readRig(id); s.notice = "Only the selected seat will be started. Other seats retain their history."; }); return;
    }
    const seat = s.rig?.seats[s.selected];
    if (s.page === "seats" && key === "t" && s.rig?.seats.some((seat) => seat.observed.state === "transport_unavailable")) {
      await this.run(async () => {
        s.notice = "Starting the terminal service only…"; this.changed();
        await this.deps.client.startupRequest("/terminal", {});
        await this.readRig(s.rig!.rigId);
        s.notice = "Terminal service available. Choose the seat and conversation deliberately.";
      }); return;
    }
    if (s.page === "seats" && seat && key === "o" && ["running", "attention_required"].includes(seat.observed.state)) {
      await this.run(async () => {
        if (!this.deps.onNative) throw new Error("Native terminal access is unavailable in this TUI launcher.");
        await this.deps.onNative(seat);
        await this.readRig(s.rig!.rigId);
        s.notice = "Returned from the existing native terminal. Inspect its state before continuing.";
      }); return;
    }
    if (s.page === "seats" && seat && key === "c" && seat.contextPending) {
      await this.launch(s.rig!.rigId, seat, "continue"); return;
    }
    if (s.page === "seats" && seat && key === "f" && seat.hasHistory && seat.freshAllowed !== false && !s.freshBlocked) {
      s.consent = { rigId: s.rig!.rigId, seat: { ...seat } }; s.page = "confirm";
      this.changed(); return;
    }
    if (s.page === "confirm" && key === "y" && s.consent) {
      const consent = s.consent; s.consent = undefined; s.page = "seats";
      await this.launch(consent.rigId, consent.seat, "fresh"); return;
    }
    if (s.page === "seats" && seat && key === "enter") {
      if (["running", "attention_required"].includes(seat.observed.state)) { s.open = false; this.deps.onWork(s.rig, seat); this.changed(); return; }
      await this.launch(s.rig!.rigId, seat, seat.hasHistory ? "resume" : "start");
    }
  }
  private async launch(rigId: string, seat: StartupSeat, action: string) {
    await this.run(async () => {
      this.state.notice = `${action === "resume" ? "Resuming" : "Starting"} ${seat.logicalId}…`;
      this.changed();
      let warnings: string[] = [];
      try {
        const result = await this.deps.client.startupRequest<{ message?: string; status?: string; code?: string; warnings?: string[] }>(
          `/${encodeURIComponent(rigId)}/${encodeURIComponent(seat.logicalId)}`, { action, revision: seat.revision });
        this.state.notice = action === "fresh" ? "A new conversation was started with the configured context. Previous history is retained." : result.message ?? result.status ?? result.code ?? "Launch finished; inspect the observed state.";
        warnings = result.warnings ?? [];
        this.state.notice = [this.state.notice, ...warnings].join("\n");
      } catch (error) {
        // Read effects after every failed/lost response. Never automatically replay a POST.
        await this.readRig(rigId).catch(() => {});
        throw error;
      }
      const notice = this.state.notice;
      await this.readRig(rigId);
      this.state.selected = Math.max(0, this.state.rig!.seats.findIndex((s) => s.nodeId === seat.nodeId));
      const observed = this.state.rig!.seats[this.state.selected]?.observed;
      this.state.notice = observed && observed.state !== "running" ? [observed.detail, ...warnings].join("\n") : notice;
    });
  }
}

export function startupLines(s: StartupState): Array<{ text: string; action?: Action }> {
  const button = (text: string, key: string) => ({ text, action: { type: "startup" as const, key } });
  const lines: Array<{ text: string; action?: Action }> = [
    { text: "OpenRig · Start and return" }, { text: `Daemon: ${s.target}` }, { text: "" }, { text: s.notice }, { text: "" },
  ];
  lines.push(button("?  Help", "?"), button("w  Skip startup · ordinary views", "w"));
  lines.push(button("L  Local reading · Specs and intent", "L"));
  if (s.page === "down" || s.page === "unavailable") lines.push({ text: "In your terminal: rig doctor · rig doctor --help" });
  if (s.local) return localLines(s.local);
  if (s.busy) return [...lines, { text: "Working… repeated input will not start another operation." }, { text: "Esc Back / skip · q Quit; an accepted operation continues." }];
  if (s.page === "down") lines.push(button("Enter / s  Start daemon; choose seats next", "s"));
  if (s.page === "rigs") {
    s.rigs.forEach((r, i) => lines.push(button(`${i === s.selected ? "▶" : " "} ${r.name}${r.name === "kernel" ? " · recommended first" : ""}`, `select:${i}`)));
    if (!s.rigs.some((r) => r.name === "kernel")) lines.push(button("k  Set up kernel (operator recommended)", "k"));
    if (s.rigs.length) lines.push(button("Enter  Choose seats in selected rig", "enter"));
  }
  if (s.page === "kernel") {
    lines.push({ text: "Choose the runtime for this new kernel. No model or credential will be changed." });
    lines.push(button(`c  Codex · ${s.prerequisites?.codex ?? "unavailable"}`, "c"), button(`l  Claude Code · ${s.prerequisites?.claudeCode ?? "unavailable"}`, "l"));
    lines.push({ text: "Unavailable means installation/authentication needs repair before setup." });
  }
  if (s.page === "seats" && s.rig) {
    lines.push({ text: `${s.rig.rigName} · choose one seat; unselected seats remain unchanged` });
    s.rig.seats.forEach((seat, i) => lines.push(button(`${i === s.selected ? "▶" : " "} ${seat.logicalId} · ${seat.observed.state} · ${seat.hasHistory ? seat.intendedAction : "new seat"}`, `select:${i}`)));
    if (s.rig.seats.some((seat) => seat.observed.state === "transport_unavailable")) lines.push(button("t  Start terminal service (no seats); then inspect recovery choices", "t"));
    const seat = s.rig.seats[s.selected];
    if (seat) {
      lines.push({ text: "" }, { text: `${seat.logicalId} · ${seat.runtime} · model ${seat.model ?? "configured default"}` },
        { text: seat.prerequisite ?? (seat.observed.state === "running" && seat.contextPending
          ? "This fresh conversation is waiting for its configured context. Press c to finish that delivery."
          : ["running", "attention_required", "unverified"].includes(seat.observed.state) ? seat.observed.detail : seat.reason ?? seat.observed.detail) },
        button(seat.observed.state === "running" ? "Enter  Open live work" : seat.observed.state === "attention_required" ? "Enter  Inspect this existing runtime" : `Enter  ${seat.hasHistory ? "Resume previous conversation" : "Start this new seat"}`, "enter"));
      if (["running", "attention_required"].includes(seat.observed.state)) lines.push(button("o  Open native terminal here · detach to return (default Ctrl-b, d)", "o"));
      if (seat.contextPending) lines.push(button("c  Finish configured context after resolving the native prerequisite", "c"));
      if (seat.hasHistory && seat.freshAllowed !== false && !s.freshBlocked) lines.push(button("f  Consider a fresh conversation…", "f"));
    }
  }
  if (s.page === "confirm" && s.consent) {
    lines.push({ text: `Start a NEW conversation for ${s.consent.seat.logicalId}?` },
      { text: "It will not contain the old conversation. The old history is retained; configured context and durable duties will be re-primed." },
      { text: "This decision applies only to this seat and the state just inspected." },
      button("y  Confirm this fresh start", "y"), button("Esc  Decline; leave stopped", "escape"));
  }
  lines.push(button("r  Refresh actual state", "r"), button("d  Diagnostic details", "d"), button("Esc  Back / decline", "escape"), { text: "↑↓ choose · q quit · S opens startup from ordinary work" });
  if (s.expanded) lines.push({ text: "" }, { text: `Instance: ${s.home}` }, { text: s.detail || JSON.stringify(s.rig?.seats[s.selected] ?? s.probe ?? {}) });
  return lines;
}
