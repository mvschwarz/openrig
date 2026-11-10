// The herdr-app terminal provider: OpenRig views as Rig-layout views in a herdr-app client. One provider instance
// serves one app home.
//
// A view opens as:
//   1. journal (each viewer with its op nonce, before anything starts);
//   2. viewers started by herdr-core, outside every tab (`hc run --bg --no-parent`, openrig.* labels), each the
//      view's own tile for its seat (an interactive one mirrors the seat and attaches only while someone types in
//      it; a read-only one only shows it), each waiting after its tile ends instead of exiting (an exiting viewer
//      makes herdr collapse the layout), and never `--keep` (that would leave a shell behind in the cell);
//   3. ONE atomic write of layouts/rig.json: the person's layout with OpenRig's stack beside their tabs, each view an
//      equal, padded grid with a title row per cell;
//   4. for an explicit open: show the Rig layout, wait for the app to acknowledge the write, select the view (the
//      strip then focuses its first live cell).
// Removing viewers (close, rollback, a viewer that ended) rewrites the file FIRST and ends a viewer only after the
// app has acknowledged a revision that no longer shows it, and only when the viewer is verifiably OpenRig's
// (journal + labels + exact argv). Anything uncertain is left running and reported.
import { rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { tileAttachArgv } from "./tile-attach.js";
import { cellFor, deriveRigLayout, RIG_LAYOUT, RIG_STACK, type RigView } from "./herdr-app-layout.js";
import { awaitApplied, newNonce, type ClientState, type HerdrAppClientFiles, type PendingEnd, type ViewerRecord, type ViewRecord } from "./herdr-app-state.js";
import { describeCore, type AppReply, type HcRunner, type HerdrAppClient } from "./herdr-app-transport.js";
import type { ComposedPane, ComposedView, OpenViewResult, ProviderLiveness, ProviderStatus, TerminalProvider } from "./terminal-provider.js";

export const HERDR_APP_PROVIDER = "herdr-app";

/** Why a seat of a view herdr-app hasn't confirmed showing is degraded, not opened (`pane_unconfirmed`). */
export const HERDR_APP_UNCONFIRMED_REASON = "herdr-app has not confirmed showing this view. It is in the Rig layout file, and its viewer runs; check the window before opening it again.";

/** How long a viewer start with an unknown `hc run` outcome is polled before OpenRig stops tracking it. */
export const UNKNOWN_START_TTL_MS = 10 * 60 * 1000;

/**
 * `hc` error kinds that mean `terminal.run` rejected the request before allocating or spawning a terminal
 * (`ref/herdr-core` `rpc.rs`, `cli.rs`, `terminals.rs`). Every other kind (including `internal`, `unavailable`,
 * `spawn_failed`, or a missing/unknown kind) is treated as an uncertain start and tracked by its nonce.
 */
const DEFINITE_HC_ERROR_KINDS = new Set(["invalid_params", "not_found", "conflict", "name_taken", "usage"]);

/** herdr-core panes may run programs with TERM=dumb, whose terminfo has no `clear` capability, so a tmux client refuses
 *  with "open terminal failed: terminal does not support clear". When the inherited TERM can't be verified as
 *  clear-capable, use xterm-256color. */
const TERM_GUARD = 'if ! (command -v infocmp >/dev/null 2>&1 && infocmp "$TERM" 2>/dev/null | grep -q "clear="); then TERM=xterm-256color; export TERM; fi;';
/** Waits after the tile ends, so the terminal never ends on its own; OpenRig rewrites the cell, then ends it. */
const VIEWER_ENDED = 'status=$?; printf "\\r\\n%s\\r\\n" "The seat session ended here (exit $status). OpenRig will update this view; nothing else runs in this cell."; exec tail -f /dev/null';
const VIEWER_WRAPPER = `shift; ${TERM_GUARD} "$@"; ${VIEWER_ENDED}`;
/** An interactive local viewer until the app has shown it: the read-only tile (it shows the seat and takes no input)
 *  runs until OpenRig writes this viewer's gate file, then the view's writable tile runs in its place. Input that came
 *  before (typed in the cell, or written to the terminal with hc send) is dropped, never delivered late. If the gate's
 *  window ends first, the cell says so and stays closed. Arguments: the gate file, the window's end (epoch seconds),
 *  the line shown when it ends, the read-only tile's script, then the writable tile's argv. */
const GATED_WRAPPER = [
  "shift;", TERM_GUARD,
  "g=$1; u=$2; m=$3; ro=$4; shift 4; a=$1; b=$2; c=$3; shift 3;",
  // The read-only tile keeps the terminal as its input, so its stty applies (no echo). A background job's stdin is
  // /dev/null before any redirection, so the terminal is kept on fd 3 first.
  'exec 3<&0; "$a" "$b" "$ro" "$@" <&3 3<&- & v=$!; exec 3<&-;',
  'while [ ! -e "$g" ] && kill -0 "$v" 2>/dev/null && [ "$(date +%s)" -lt "$u" ]; do sleep 0.2 2>/dev/null || sleep 1; done;',
  'if [ -e "$g" ] && kill -0 "$v" 2>/dev/null; then kill "$v" 2>/dev/null; wait "$v" 2>/dev/null;',
  // Non-blocking reads until one comes back empty: whatever was waiting on the terminal is gone.
  'if [ -t 0 ]; then stty -icanon min 0 time 0 2>/dev/null; while [ "$(dd bs=65536 count=1 2>/dev/null | wc -c)" -gt 0 ]; do :; done; stty sane 2>/dev/null; fi;',
  '"$a" "$b" "$c" "$@";',
  // The window ended with the gate still closed: no tile at all from here, and the cell says why.
  'elif kill -0 "$v" 2>/dev/null; then kill "$v" 2>/dev/null; wait "$v" 2>/dev/null; printf "\\033[H\\033[2J\\r\\n%s\\r\\n" "$m"; exec tail -f /dev/null;',
  'else wait "$v"; fi;',
  VIEWER_ENDED,
].join(" ");

/** An interactive viewer's gate: its file, when its window ends (epoch seconds), and the line its cell shows then. */
export interface ViewerGate { path: string; until: number; expired: string }

/** The same seat's read-only tile, from the composed tile `sh -c <script> openrig-tile <session> <tmux> <server...>`
 *  (tile-attach.ts). Only when rebuilding the writable tile from those parts gives back the composed argv exactly, so a
 *  different shape (another script, flag or tag) gives null and nothing is built from a guess. Words after tmux are the
 *  tile's server arguments by its own positional contract, so both tiles get all of them. */
export function readOnlyTile(attach: readonly string[]): string[] | null {
  const [, flag, , tag, session, tmux] = attach;
  if (attach.length < 6 || flag !== "-c" || tag !== "openrig-tile" || !session || !tmux) return null;
  const server = attach.slice(6);
  const writable = tileAttachArgv(tmux, server, session, false);
  if (writable.length !== attach.length || writable.some((word, i) => word !== attach[i])) return null;
  return tileAttachArgv(tmux, server, session, true);
}

/** An interactive cell whose read-only tile couldn't be built: it shows this and takes no input (fail closed). */
const UNSHAPED_TILE = 'printf "\\r\\n%s\\r\\n" "OpenRig could not build a read-only view of this seat (the tile command has a shape this OpenRig does not know), so this cell takes no input. Open the view with --window, or update OpenRig."; exec tail -f /dev/null';

/** A viewer's argv. A remote pane runs its ssh paneCommand as composed, and a read-only local pane its read-only tile;
 *  OpenRig rewrites neither. An interactive local pane shows the read-only tile until its gate opens and the view's
 *  writable tile after (`GATED_WRAPPER`); without a gate, or with a tile it can't read, it takes no input at all. */
export function viewerArgv(pane: Pick<ComposedPane, "attachArgv" | "paneCommand" | "readOnly">, nonce: string, gate?: ViewerGate): string[] {
  if (!pane.attachArgv) return ["/bin/sh", "-c", VIEWER_WRAPPER, "openrig-viewer", nonce, "/bin/sh", "-c", pane.paneCommand];
  if (pane.readOnly) return ["/bin/sh", "-c", VIEWER_WRAPPER, "openrig-viewer", nonce, ...pane.attachArgv];
  const readOnly = readOnlyTile(pane.attachArgv);
  // Never the writable tile without its gate: no gate, or a tile shape this code can't read, fails closed.
  if (!gate || !readOnly) return ["/bin/sh", "-c", VIEWER_WRAPPER, "openrig-viewer", nonce, "/bin/sh", "-c", UNSHAPED_TILE, "openrig-unshaped"];
  return ["/bin/sh", "-c", GATED_WRAPPER, "openrig-viewer", nonce, gate.path, String(gate.until), gate.expired, readOnly[2]!, ...pane.attachArgv];
}

export interface HerdrAppProviderDeps {
  files: HerdrAppClientFiles;
  app: HerdrAppClient;
  hc: HcRunner;
  /** This OpenRig instance (label openrig.daemon): another daemon's viewers are never claimed. */
  daemonInstance: string;
  /** OpenRig's own folder the viewers start in. */
  viewerCwd: string;
  /** Installs or checks OpenRig's mods in this app home; never replaces a mod the person changed. `ok: false` only when a
   *  needed mod is missing and could not be installed; a folder left as the person's is a note, and the view opens. */
  ensureMods(): Promise<{ ok: true; notes?: string[] } | { ok: false; error: string }>;
  /** Called when this provider starts owned-view work (an open about to start viewers, a close): prepares what only
   *  that work needs (the viewers folder, the hc events watcher). A status, preview or listing never calls it. */
  ownWork?(): void;
  ackTimeoutMs?: number;
  /** How long an interactive viewer's gate keeps waiting for the app to show it (late acknowledgement, a failed gate
   *  write), across a daemon restart. */
  gateWindowMs?: number;
  /** How often a pending gate checks whether the app shows its viewer yet. */
  gatePollMs?: number;
  nonce?(): string;
  /** This daemon's machine, named when no window answers here (default: os.hostname()). */
  hostname?(): string;
  now?(): Date;
}

type Removal = { terminal: string | null; seat?: string; cellId: string; nonce: string; argv: string[]; since: string };

/** What core says about a terminal. Only a definite answer counts as gone: `not_found`, or a record that is no longer
 *  live. A timeout or an unreachable core is `unknown`, and the viewer stays tracked. */
async function terminalState(hc: HcRunner, terminal: string): Promise<{ state: "live"; record: TerminalRecord } | { state: "gone" } | { state: "unknown"; reason: string }> {
  const got = await hc(["get", "--json", terminal]);
  const record = got.json as TerminalRecord | null;
  if (got.exit === 0 && record && typeof record === "object") return record.state === "live" ? { state: "live", record } : { state: "gone" };
  if (got.error?.kind === "not_found") return { state: "gone" };
  return { state: "unknown", reason: got.error?.message ?? `hc exited ${got.exit}` };
}

type TerminalRecord = { state?: unknown; argv?: unknown; labels?: Record<string, unknown>; pid?: unknown };

function fail(code: string, error: string, extra: Partial<OpenViewResult> = {}): OpenViewResult {
  return { provider: HERDR_APP_PROVIDER, ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code, ...extra };
}

const describe = (reply: AppReply) => reply.kind === "ok" ? "ok" : reply.kind === "refused" ? reply.error : `${reply.kind}: ${reply.reason}`;

export class HerdrAppProvider implements TerminalProvider {
  readonly name = HERDR_APP_PROVIDER;
  readonly panesPerPage = 16;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Cells a pending-gate follower already follows (never two followers for one cell). */
  private readonly watching = new Set<string>();
  /** The followers' timers: each wakes its sleeper early on stop. */
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(private readonly deps: HerdrAppProviderDeps) {}

  /** Ends this provider's own waits (daemon shutdown). Viewers, gates and files are left as they are. */
  stop(): void {
    this.stopped = true;
    for (const [timer, wake] of this.timers) { clearTimeout(timer); wake(); }
    this.timers.clear();
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, ms);
      timer.unref?.();
      this.timers.set(timer, resolve);
    });
  }

  /** The file whose existence lets this viewer take input (in OpenRig's own viewers folder). */
  private gatePath(nonce: string): string { return join(this.deps.viewerCwd, `${nonce}.shown`); }
  /** A pending gate's deadline: wall clock, so it holds across a restart. */
  private gateDeadline(): string { return new Date(Date.now() + this.gateWindow()).toISOString(); }
  private gateWindow(): number { return this.deps.gateWindowMs ?? 10 * 60 * 1000; }
  /** What an interactive cell says when its gate's window ends before herdr-app showed the view. */
  private gateExpired(view: string): string {
    return `herdr-app did not show this view within ${this.windowText()} of its open, so this cell takes no input. Reopen it with: rig terminal open ${view} --provider herdr-app`;
  }
  private windowText(): string {
    const minutes = Math.round(this.gateWindow() / 60_000);
    return minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(this.gateWindow() / 1000)} seconds`;
  }

  get appHome(): string { return this.deps.files.appHome; }

  /** One operation at a time per client: every write is derived from the latest journal. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private nonce(): string { return this.deps.nonce?.() ?? newNonce(); }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }

  async status(): Promise<ProviderStatus> {
    const reply = await this.deps.app.status(1_000);
    // Bounded like the status request: a window that answers status and then stalls costs about a second more, not six.
    const commands = reply.kind === "ok" ? await this.deps.app.commands(1_000) : null;
    const names = commands?.kind === "ok" && Array.isArray(commands.value) ? (commands.value as { name?: unknown }[]).map((c) => c.name) : [];
    const core = this.deps.hc.core ?? {
      session: process.env.HC_SESSION || "default",
      ...(process.env.HC_SOCKET ? { socket: process.env.HC_SOCKET } : {}),
    };
    let pendingStarts: number | "unknown";
    try {
      const state = await this.deps.files.load();
      pendingStarts = state.pendingEnds.filter((p) => p.terminal === null).length
        + state.views.flatMap((v) => v.viewers).filter((v) => v.state === "planned" || v.state === "start-unknown").length;
    } catch {
      pendingStarts = "unknown";
    }
    return {
      provider: HERDR_APP_PROVIDER,
      available: reply.kind === "ok",
      capabilities: {
        rigLayout: reply.kind === "ok",
        layoutSelect: names.includes("layout.select"),
        layoutSwitch: names.includes("layout.switch"),
        paneFocus: names.includes("pane.focus"),
      },
      launch: { socketPath: `${this.deps.files.appHome}/herdr-app.sock`, ...(core.session !== "default" ? { session: core.session } : process.env.HC_SESSION ? { session: process.env.HC_SESSION } : {}) },
      core,
      assumption: "viewers are started with hc in this core; herdr-app must be a client of it",
      pendingStarts,
    };
  }

  async liveness(): Promise<ProviderLiveness> {
    const reply = await this.deps.app.status(1_000);
    return reply.kind === "ok" ? { alive: true } : { alive: false, detail: `herdr-app at ${this.deps.files.appHome}: ${describe(reply)}` };
  }

  openView(view: ComposedView): Promise<OpenViewResult> {
    return this.serial(() => this.open(view));
  }

  /** Close one Rig view: its cells leave the file first, then only its verified viewers end. Seats are untouched. */
  closeView(viewId: string): Promise<OpenViewResult> {
    return this.serial(async () => {
      const state = await this.deps.files.load();
      const view = state.views.find((v) => v.id === viewId);
      if (!view) return fail("view_not_found", `No Rig view ${viewId} in ${this.deps.files.appHome}.`);
      this.deps.ownWork?.();
      const notes = await this.remove(state, [viewId], []);
      return { provider: HERDR_APP_PROVIDER, ok: true, opened: [], absent: [], degraded: [], pages: 0, notes };
    });
  }

  /** The Rig views OpenRig has in this client. */
  async listViews(): Promise<ViewRecord[]> {
    return (await this.deps.files.load()).views;
  }

  /** Bring the file in line with core: a viewer that ended is written as an ended cell; pending ends are retried. */
  reconcile(): Promise<string[]> {
    return this.serial(async () => {
      const state = await this.deps.files.load();
      return this.reconcileState(state);
    });
  }

  private async reconcileState(state: ClientState): Promise<string[]> {
    const notes: string[] = [];
    let changed = false;
    let journalChanged = false;
    for (const view of state.views) {
      const keptViewers: ViewerRecord[] = [];
      for (const viewer of view.viewers) {
        if (viewer.state === "planned" || viewer.state === "start-unknown") {
          state.pendingEnds.push({
            terminal: null,
            seat: viewer.seat,
            cellId: viewer.cellId,
            nonce: viewer.nonce,
            argv: viewer.argv,
            since: view.createdAt || this.now(),
            revision: "unwritten",
          });
          journalChanged = true;
          continue;
        }
        keptViewers.push(viewer);
        if (viewer.state !== "live" || !viewer.terminal) continue;
        const seen = await terminalState(this.deps.hc, viewer.terminal);
        if (seen.state === "unknown") {
          notes.push(`${viewer.label}: its viewer ${viewer.terminal} in ${describeCore(this.deps.hc)} could not be checked (${seen.reason}); it is kept as it is.`);
        } else if (seen.state === "gone") {
          viewer.state = "ended";
          viewer.terminal = null;
          await this.closeGate(viewer.nonce);
          changed = true;
          notes.push(`${viewer.label}: its viewer ended outside OpenRig; its cell now says so.`);
        }
      }
      if (keptViewers.length !== view.viewers.length && keptViewers.length > 0 && state.writtenSha) changed = true;
      view.viewers = keptViewers;
    }
    const beforeViews = state.views.length;
    state.views = state.views.filter((view) => view.viewers.length > 0);
    if (state.views.length !== beforeViews) journalChanged = true;
    if (changed) {
      const written = await this.write(state);
      if (!written.ok) notes.push(written.error);
    } else if (journalChanged) {
      await this.deps.files.save(state);
    }
    if (state.pendingEnds.length) notes.push(...await this.endPending(state));
    return notes;
  }

  private async open(view: ComposedView): Promise<OpenViewResult> {
    const files = this.deps.files;
    const status = await this.deps.app.status(1_000);
    if (status.kind !== "ok") {
      // No window at all here: the app may be running on another machine, which this provider can't reach.
      const where = status.kind === "unavailable"
        ? ` This daemon looked on its own machine (${this.deps.hostname?.() ?? hostname()}); herdr-app has to run on the machine the daemon runs on.` : "";
      return fail("herdr_app_unavailable", `herdr-app is not answering at ${files.appHome} (${describe(status)}).${where} Nothing was started. Viewers start in ${describeCore(this.deps.hc)}; a window attached to a different core would not show them.`,
        { absent: view.absent, degraded: view.degraded });
    }
    const mods = await this.deps.ensureMods();
    if (!mods.ok) {
      const base = mods.error.trimEnd();
      return fail("herdr_app_mods", base.includes("Nothing was started.") ? base : `${base} Nothing was started.`, { absent: view.absent, degraded: view.degraded });
    }
    const state = await files.load();
    const owned = await files.rigOwnership(state);
    if (!owned.ours) return fail("rig_layout_not_owned", owned.reason, { absent: view.absent, degraded: view.degraded });
    const notes = [...(mods.notes ?? []), ...await this.reconcileState(state)];
    const shown = (status.value as { layout?: unknown }).layout;
    state.base ??= typeof shown === "string" && shown !== RIG_LAYOUT ? shown : "main";
    if (!view.pages.length) return fail("nothing_to_open", "No attachable seats in this view; nothing was started.", { absent: view.absent, degraded: view.degraded });
    // The write below needs the person's layout: check it before any viewer starts.
    if (!await files.readLayout(state.base)) {
      return fail("base_layout_missing", `The layout OpenRig builds on, ${state.base}, could not be read from ${files.appHome}/layouts. Nothing was started.`,
        { absent: view.absent, degraded: view.degraded, notes });
    }

    // 1. Journal first (owned-view work starts here).
    this.deps.ownWork?.();
    const name = view.viewDescriptor?.name ?? view.spaceLabel ?? view.id;
    const unshaped: string[] = [];
    const created: ViewRecord[] = view.pages.map((page, index) => {
      const id = `rv-${this.nonce()}`;
      return {
        id, name: view.pages.length > 1 ? `${name} ${index + 1}/${view.pages.length}` : name,
        source: { view: view.id, page: index }, createdAt: this.now(), ...(view.columns ? { columns: view.columns } : {}),
        viewers: page.map((pane) => {
          const nonce = this.nonce();
          const cell = cellFor(id, pane, nonce, null);
          const interactive = !!pane.attachArgv && !pane.readOnly;
          const gated = interactive && !!readOnlyTile(pane.attachArgv!);
          if (interactive && !gated) unshaped.push(pane.label);
          const gateUntil = this.gateDeadline();
          // Rounded up, so the cell never gives up before the daemon does.
          const gate = interactive ? { path: this.gatePath(nonce), until: Math.ceil(Date.parse(gateUntil) / 1000), expired: this.gateExpired(view.id) } : undefined;
          return { cellId: cell.id, seat: pane.seat, label: pane.label, ...(pane.runtime ? { runtime: pane.runtime } : {}),
            nonce, argv: viewerArgv(pane, nonce, gate), readOnly: pane.readOnly,
            attach: pane.attachArgv ? "local" as const : "remote" as const,
            ...(gated ? { gate: "pending" as const, gateUntil } : {}),
            terminal: null, state: "planned" as const };
        }),
      };
    });
    if (unshaped.length) notes.push(`${unshaped.join(", ")}: OpenRig could not build a read-only view of ${unshaped.length === 1 ? "this seat" : "these seats"} (the tile command has a shape this OpenRig does not know), so ${unshaped.length === 1 ? "its cell takes" : "their cells take"} no input and ${unshaped.length === 1 ? "says" : "say"} so. Open the view with --window, or update OpenRig.`);
    state.views.push(...created);
    await files.save(state);

    // 2. Start the viewers.
    const failed: string[] = [];
    let firstReason: string | undefined;
    for (const record of created) for (const viewer of record.viewers) {
      const started = await this.startViewer(record, viewer);
      if ("address" in started) { viewer.terminal = started.address; viewer.state = "live"; }
      else {
        if (started.unknown) viewer.state = "start-unknown";
        failed.push(viewer.seat);
        firstReason ??= started.reason;
      }
    }
    await files.save(state);
    if (failed.length) {
      const rollback = await this.remove(state, created.map((v) => v.id), [], { neverWritten: true });
      return fail("viewer_start_failed", `herdr-core did not start viewers for ${failed.join(", ")} (${describeCore(this.deps.hc)}): ${firstReason ?? "unknown error"}; this open was rolled back. The viewers run in that core; herdr-app has to be one of its clients (HC_SESSION/HC_SOCKET are kept when the daemon starts).`,
        { absent: view.absent, degraded: view.degraded, notes: [...notes, ...rollback] });
    }

    // 3. One atomic write.
    const written = await this.write(state);
    if (!written.ok) {
      const rollback = await this.remove(state, created.map((v) => v.id), [], { neverWritten: true });
      return fail(written.code, written.error, { absent: view.absent, degraded: view.degraded, notes: [...notes, ...rollback] });
    }

    // 4. Reveal: the person asked for this view.
    const revealed = await this.reveal(created, written.revision);
    notes.push(...revealed.notes);
    await files.save(state);
    // Viewers this write released (kept from an earlier failed rewrite) end now, once the app shows it.
    if (state.pendingEnds.length) notes.push(...await this.endPending(state));
    // `opened` is what the app is known to show (terminal-provider.ts); an unconfirmed view keeps its journal and
    // viewers, and its seats are reported as unconfirmed, as the herdr adapter does. No retry, no rollback.
    const seats = created.flatMap((v) => v.viewers.map((viewer) => viewer.seat));
    const opened = revealed.confirmed ? seats : [];
    const degraded = revealed.confirmed ? view.degraded
      : [...view.degraded, ...seats.map((seat) => ({ seat, host: HERDR_APP_PROVIDER, code: "pane_unconfirmed" as const, reason: HERDR_APP_UNCONFIRMED_REASON }))];
    return {
      provider: HERDR_APP_PROVIDER, ok: opened.length > 0 || view.opened.length === 0,
      opened, absent: view.absent, degraded, pages: created.length,
      space: { id: created[0]!.id, label: created[0]!.name },
      ...(notes.length ? { notes } : {}),
    };
  }

  private async startViewer(view: ViewRecord, viewer: ViewerRecord): Promise<{ address: string } | { reason: string; unknown: boolean }> {
    const labels = [
      `openrig.daemon=${this.deps.daemonInstance}`, "openrig.role=viewer", `openrig.view=${view.id}`,
      `openrig.op=${viewer.nonce}`, `openrig.seat=${viewer.seat}`, `openrig.cell=${viewer.cellId}`,
    ].flatMap((label) => ["--label", label]);
    const run = await this.deps.hc(["run", "--bg", "--no-parent", "--no-notify", "--json", "--cwd", this.deps.viewerCwd, ...labels, "--", ...viewer.argv]);
    const address = (run.json as { address?: unknown } | null)?.address;
    if (run.exit === 0 && typeof address === "string") return { address };
    const reason = run.error?.message || `hc exited ${run.exit}`;
    const kind = run.error?.kind;
    if (run.exit > 0 && typeof kind === "string" && DEFINITE_HC_ERROR_KINDS.has(kind)) {
      return { reason, unknown: false };
    }
    // An uncertain start: look for it by its nonce rather than start another.
    const found = await this.deps.hc(["ls", "--json", "--label", `openrig.op=${viewer.nonce}`]);
    const terminals = (found.json as { terminals?: { address?: unknown }[] } | null)?.terminals ?? [];
    const hit = terminals.find((t) => typeof t.address === "string");
    if (hit) return { address: hit.address as string };
    return { reason, unknown: true };
  }

  /** Derive and write the Rig layout from the journal; every write lists live viewer terminals only. */
  private async write(state: ClientState): Promise<{ ok: true; revision: string } | { ok: false; code: string; error: string }> {
    const files = this.deps.files;
    const base = state.base ? await files.readLayout(state.base) : null;
    if (!base) return { ok: false, code: "base_layout_missing", error: `The base layout ${state.base ?? "(none)"} could not be read from ${files.appHome}/layouts.` };
    const revision = `r-${this.nonce()}`;
    const views: RigView[] = state.views.map((v) => ({
      id: v.id, name: v.name, ...(v.columns ? { columns: v.columns } : {}),
      cells: v.viewers.map((viewer) => ({ id: viewer.cellId, seat: viewer.seat, title: viewer.label,
        ...(viewer.runtime ? { detail: viewer.runtime } : {}), terminal: viewer.state === "live" ? viewer.terminal : null })),
    }));
    const derived = deriveRigLayout(base, views, { revision });
    if (!derived.ok) return { ok: false, code: derived.code, error: derived.error };
    const owned = await files.rigOwnership(state);
    if (!owned.ours) return { ok: false, code: "rig_layout_not_owned", error: owned.reason };
    state.writtenSha = await files.writeRig(derived.tree);
    state.revision = revision;
    // Viewers kept from a failed rewrite are absent from this file too: they may end once it is applied.
    for (const end of state.pendingEnds) if (end.revision === "unwritten") end.revision = revision;
    await files.save(state);
    return { ok: true, revision };
  }

  /** Shows the first page of this open: the Rig layout, then the view once the app shows the write. Once the app has
   *  acknowledged the write, every page's interactive viewers take input (their gates open); not before. */
  private async reveal(pages: ViewRecord[], revision: string): Promise<{ notes: string[]; confirmed: boolean }> {
    const view = pages[0]!;
    const notes: string[] = [];
    const app = this.deps.app;
    const before = await app.status(1_000);
    if (before.kind === "ok" && (before.value as { layout?: unknown }).layout !== RIG_LAYOUT) {
      const switched = await app.do("layout.switch", { name: RIG_LAYOUT });
      if (switched.kind !== "ok") notes.push(`Showing OpenRig's Rig layout: ${describe(switched)}.`);
    }
    if (!await awaitApplied(this.deps.files, revision, [], { timeoutMs: this.deps.ackTimeoutMs ?? 8_000 })) {
      // It may still be shown later: its interactive viewers' gates open then, within their window.
      this.watchPending(pages.flatMap((page) => page.viewers).filter((v) => v.gate === "pending").map((v) => v.cellId));
      notes.push(`herdr-app has not confirmed showing this view. It is written to the Rig layout file, but the window may not be showing it; its interactive cells take no input until it does (OpenRig waits ${this.windowText()}; after that each cell says so, and the view has to be opened again). If this window is attached to a different herdr-core than the daemon's (${describeCore(this.deps.hc)}), the viewers never appear here; start the daemon with that core's HC_SESSION/HC_SOCKET.`);
      return { notes, confirmed: false };
    }
    const selected = await app.do("layout.select", { stack: RIG_STACK, child: view.id });
    if (selected.kind !== "ok") notes.push(`Selecting the view: ${describe(selected)}. It is in the Rig strip.`);
    // The app shows it: the interactive viewers take input from now on. A gate that can't be written yet is retried.
    const retry: string[] = [];
    for (const viewer of pages.flatMap((page) => page.viewers)) {
      if (viewer.gate !== "pending" || viewer.state !== "live" || !viewer.terminal) continue;
      if (await this.openGate(viewer)) { viewer.gate = "open"; delete viewer.gateUntil; } else retry.push(viewer.cellId);
    }
    this.watchPending(retry);
    return { notes, confirmed: true };
  }

  /** Writes this viewer's gate file; false when it can't be written (the follower tries again). */
  private async openGate(viewer: ViewerRecord): Promise<boolean> {
    try { await writeFile(this.gatePath(viewer.nonce), ""); return true; } catch { return false; }
  }

  /** Follows pending gates until each opens or its window (`gateUntil`) ends: the app showing the viewer late (an
   *  acknowledgement of that write or a later one lists its terminal), or a gate write that failed. Never selects the
   *  view (the person may be elsewhere) and never starts anything. A cell already followed isn't followed twice. */
  private watchPending(cells: string[]): void {
    const fresh = cells.filter((cell) => !this.watching.has(cell));
    if (!fresh.length) return;
    for (const cell of fresh) this.watching.add(cell);
    let waiting = fresh;
    void (async () => {
      try {
        while (!this.stopped && waiting.length) {
          const ack = await this.deps.files.readAck().catch(() => null);
          waiting = await this.serial(() => this.openPending(waiting, ack?.terminals ?? []));
          if (!waiting.length) return;
          await this.sleep(this.deps.gatePollMs ?? 500);
        }
      } finally {
        for (const cell of fresh) this.watching.delete(cell);
      }
    })().catch(() => {});
  }

  /** One pass: opens the pending gates of viewers the app shows. Returns the cells still waiting within their window. */
  private async openPending(cells: readonly string[], shown: readonly string[]): Promise<string[]> {
    if (this.stopped) return [];
    const state = await this.deps.files.load();
    const waiting: string[] = [];
    let changed = false;
    for (const viewer of state.views.flatMap((v) => v.viewers)) {
      if (!cells.includes(viewer.cellId) || viewer.gate !== "pending") continue;
      if (viewer.attach !== "local" || viewer.readOnly || viewer.state !== "live" || !viewer.terminal) continue;
      const until = viewer.gateUntil ? Date.parse(viewer.gateUntil) : NaN;
      if (!(until > Date.now())) continue;
      if (shown.includes(viewer.terminal) && await this.openGate(viewer)) {
        viewer.gate = "open";
        delete viewer.gateUntil;
        changed = true;
      } else waiting.push(viewer.cellId);
    }
    if (changed) await this.deps.files.save(state);
    return waiting;
  }

  /** After a daemon restart: pending gates the journal records, still inside their window, are followed again. */
  resumePendingGates(): Promise<string[]> {
    return this.serial(async () => {
      if (this.stopped) return [];
      const state = await this.deps.files.load();
      const cells = state.views.flatMap((v) => v.viewers)
        .filter((v) => v.gate === "pending" && v.attach === "local" && !v.readOnly && v.state === "live" && v.terminal
          && v.gateUntil && Date.parse(v.gateUntil) > Date.now())
        .map((v) => v.cellId);
      this.watchPending(cells);
      return cells;
    });
  }

  /**
   * Remove whole views and single viewers. The file is rewritten first; a viewer is ended only once the app has
   * acknowledged a revision without it (or the Rig layout is not shown, so the app reads the new file when it is),
   * and only if it is verifiably this OpenRig's. Returns notes for anything left in place.
   */
  private async remove(state: ClientState, viewIds: readonly string[], cells: readonly string[], opts: { neverWritten?: boolean } = {}): Promise<string[]> {
    const removals: Removal[] = [];
    const since = this.now();
    const take = (viewer: ViewerRecord) => {
      if (viewer.terminal && viewer.state === "live") {
        removals.push({ terminal: viewer.terminal, seat: viewer.seat, cellId: viewer.cellId, nonce: viewer.nonce, argv: viewer.argv, since });
      } else if (viewer.state === "start-unknown" || (viewer.state === "planned" && !opts.neverWritten)) {
        removals.push({ terminal: null, seat: viewer.seat, cellId: viewer.cellId, nonce: viewer.nonce, argv: viewer.argv, since });
      }
    };
    for (const view of state.views) {
      if (viewIds.includes(view.id)) view.viewers.forEach(take);
      else view.viewers.filter((viewer) => cells.includes(viewer.cellId)).forEach(take);
    }
    state.views = state.views.filter((view) => !viewIds.includes(view.id))
      .map((view) => ({ ...view, viewers: view.viewers.filter((viewer) => !cells.includes(viewer.cellId)) }));
    const notes: string[] = [];
    const written = await this.write(state);
    if (!written.ok) {
      if (opts.neverWritten) {
        // An open rolled back before its first write: no layout file ever referenced these viewers.
        const notes = [written.error];
        for (const removal of removals) {
          const verdict = await this.endVerified(removal);
          if (verdict.kept) state.pendingEnds.push({ ...removal, revision: "unwritten" });
          if (verdict.note) notes.push(verdict.note);
        }
        await this.deps.files.save(state);
        return notes;
      }
      // Not removed from the file: ending a referenced viewer now would collapse the person's layout. The next
      // successful write (any write: the journal no longer lists them) releases them.
      state.pendingEnds.push(...removals.map((r) => ({ ...r, revision: "unwritten" })));
      await this.deps.files.save(state);
      return [`${written.error} ${removals.length} viewer(s) left running until the Rig layout can be rewritten.`];
    }
    state.pendingEnds.push(...removals.map((r) => ({ ...r, revision: written.revision })));
    await this.deps.files.save(state);
    notes.push(...await this.endPending(state));
    return notes;
  }

  /** End pending viewers whose removal the app has applied. Uncertain ones stay pending (and running). */
  private async endPending(state: ClientState): Promise<string[]> {
    if (!state.pendingEnds.length) return [];
    const notes: string[] = [];
    const pending = state.pendingEnds;
    const latest = state.revision;
    const unknownStarts = pending.filter((p) => p.terminal === null);
    const knownTerminals = pending.filter((p): p is PendingEnd & { terminal: string } => p.terminal !== null);
    const safe: PendingEnd[] = [...unknownStarts];
    if (knownTerminals.length) {
      const status = await this.deps.app.status(1_000);
      if (status.kind !== "ok") {
        notes.push(`${knownTerminals.length} viewer(s) in ${describeCore(this.deps.hc)} left running: herdr-app's state is uncertain (${describe(status)}).`);
      } else if ((status.value as { layout?: unknown }).layout !== RIG_LAYOUT) {
        // Not shown: the app reads the current file whenever the Rig layout is shown next, so no block refers to them.
        safe.push(...knownTerminals.filter((p) => p.revision !== "unwritten"));
      } else if (latest && await awaitApplied(this.deps.files, latest, knownTerminals.map((p) => p.terminal), { timeoutMs: this.deps.ackTimeoutMs ?? 8_000 })) {
        safe.push(...knownTerminals.filter((p) => p.revision !== "unwritten"));
      } else {
        notes.push(`${knownTerminals.length} viewer(s) in ${describeCore(this.deps.hc)} left running: herdr-app has not confirmed the layout without them yet.`);
      }
    }
    const kept: PendingEnd[] = pending.filter((p) => !safe.includes(p));
    for (const end of safe) {
      const verdict = await this.endVerified(end);
      if (verdict.kept) kept.push(end);
      if (verdict.note) notes.push(verdict.note);
    }
    state.pendingEnds = kept;
    await this.deps.files.save(state);
    return notes;
  }

  /** Removes a viewer's gate file once the viewer is gone. */
  private async closeGate(nonce: string): Promise<void> {
    await rm(this.gatePath(nonce), { force: true }).catch(() => {});
  }

  /** Ends a viewer only when the journal, its labels and its exact argv all say it is this OpenRig's. `kept`: still
   *  pending (core couldn't be asked, or the kill failed), to be tried again. */
  private async endVerified(end: Removal): Promise<{ kept: boolean; note?: string }> {
    let terminal = end.terminal;
    if (terminal === null) {
      const found = await this.deps.hc(["ls", "--json", "--label", `openrig.op=${end.nonce}`]);
      if (found.exit !== 0) {
        return { kept: true, note: `${end.seat ?? end.cellId}: its viewer in ${describeCore(this.deps.hc)} could not be checked (${found.error?.message ?? `hc exited ${found.exit}`}).` };
      }
      const list = (found.json as { terminals?: Array<{ address?: unknown; labels?: Record<string, unknown> }> } | null)?.terminals ?? [];
      const hit = list.find((t) => typeof t.address === "string" && t.labels?.["openrig.daemon"] === this.deps.daemonInstance && t.labels?.["openrig.role"] === "viewer")
        ?? list.find((t) => typeof t.address === "string");
      if (!hit) {
        const nowMs = (this.deps.now?.() ?? new Date()).getTime();
        const sinceMs = Date.parse(end.since);
        if (Number.isFinite(sinceMs) && nowMs - sinceMs > UNKNOWN_START_TTL_MS) {
          return { kept: false, note: `${end.seat ?? end.cellId}: its viewer never appeared in ${describeCore(this.deps.hc)}; no longer tracked.` };
        }
        return { kept: true };
      }
      terminal = hit.address as string;
    }
    const seen = await terminalState(this.deps.hc, terminal);
    if (seen.state === "gone") { await this.closeGate(end.nonce); return { kept: false }; }
    if (seen.state === "unknown") return { kept: true, note: `Viewer ${terminal} was left running for now: core could not be asked (${seen.reason}).` };
    const t = seen.record;
    const ours = t.labels?.["openrig.role"] === "viewer" && t.labels?.["openrig.op"] === end.nonce
      && t.labels?.["openrig.daemon"] === this.deps.daemonInstance
      && JSON.stringify(t.argv) === JSON.stringify(end.argv);
    if (!ours) return { kept: false, note: `Viewer ${terminal} was left in place: it can't be verified as this OpenRig's.` };
    const killed = await this.deps.hc(["kill", terminal]);
    if (killed.exit === 0) await this.closeGate(end.nonce);
    return killed.exit === 0 ? { kept: false } : { kept: true, note: `Viewer ${terminal} could not be ended yet: ${killed.error?.message ?? `hc exited ${killed.exit}`}.` };
  }
}
