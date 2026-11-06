// The herdr-app terminal provider: OpenRig views as Rig-layout views in a herdr-app client. One provider instance
// serves one app home.
//
// A view opens as:
//   1. journal (each viewer with its op nonce, before anything starts);
//   2. viewers started by herdr-core, outside every tab (`hc run --bg --no-parent`, openrig.* labels), each
//      read-only, each waiting after its attach ends instead of exiting (an exiting viewer makes herdr collapse
//      the layout), and never `--keep` (that would leave a shell behind in the cell);
//   3. ONE atomic write of layouts/rig.json: the person's layout with OpenRig's stack beside their tabs, each view an
//      equal, padded grid with a title row per cell;
//   4. for an explicit open: show the Rig layout, wait for the app to acknowledge the write, select the view (the
//      strip then focuses its first live cell), and only then make interactive viewers writable.
// Removing viewers (close, rollback, a viewer that ended) rewrites the file FIRST and ends a viewer only after the
// app has acknowledged a revision that no longer shows it, and only when the viewer is verifiably OpenRig's
// (journal + labels + exact argv). Anything uncertain is left running and reported.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tileAttachArgv } from "./tile-attach.js";
import { cellFor, deriveRigLayout, RIG_LAYOUT, RIG_STACK, type RigView } from "./herdr-app-layout.js";
import { awaitApplied, newNonce, type ClientState, type HerdrAppClientFiles, type PendingEnd, type ViewerRecord, type ViewRecord } from "./herdr-app-state.js";
import type { AppReply, HcRunner, HerdrAppClient } from "./herdr-app-transport.js";
import type { ComposedPane, ComposedView, OpenViewResult, ProviderLiveness, ProviderStatus, TerminalProvider } from "./terminal-provider.js";

export const HERDR_APP_PROVIDER = "herdr-app";

/** Waits after the attach ends, so the terminal never ends on its own; OpenRig rewrites the cell, then ends it. */
const VIEWER_WRAPPER = 'shift; "$@"; status=$?; printf "\\r\\n%s\\r\\n" "The seat session ended here (exit $status). OpenRig will update this view; nothing else runs in this cell."; exec tail -f /dev/null';

export function viewerArgv(pane: Pick<ComposedPane, "attachArgv" | "paneCommand">, nonce: string): string[] {
  const attach = pane.attachArgv
    ? tileAttachArgv(pane.attachArgv[5]!, pane.attachArgv.slice(6), pane.attachArgv[4]!, true)
    : ["/bin/sh", "-c", pane.paneCommand];
  return ["/bin/sh", "-c", VIEWER_WRAPPER, "openrig-viewer", nonce, ...attach];
}

export interface HerdrAppProviderDeps {
  files: HerdrAppClientFiles;
  app: HerdrAppClient;
  hc: HcRunner;
  /** This OpenRig instance (label openrig.daemon): another daemon's viewers are never claimed. */
  daemonInstance: string;
  /** OpenRig's own folder the viewers start in. */
  viewerCwd: string;
  /** Installs or checks OpenRig's mods in this app home; never replaces a mod the person changed. */
  ensureMods(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Runs tmux (the viewer's own tmux and server args come first in argv). */
  runTmux?(argv: string[]): Promise<string>;
  /** A process's parent pid, or null (finds the tmux client a viewer runs). */
  parentPid?(pid: number): Promise<number | null>;
  ackTimeoutMs?: number;
  nonce?(): string;
  now?(): Date;
}

type Removal = { terminal: string; cellId: string; nonce: string; argv: string[] };

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

  constructor(private readonly deps: HerdrAppProviderDeps) {}

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
    return {
      provider: HERDR_APP_PROVIDER,
      available: reply.kind === "ok",
      capabilities: {
        rigLayout: reply.kind === "ok",
        layoutSelect: names.includes("layout.select"),
        layoutSwitch: names.includes("layout.switch"),
        paneFocus: names.includes("pane.focus"),
      },
      launch: { socketPath: `${this.deps.files.appHome}/herdr-app.sock`, ...(process.env.HC_SESSION ? { session: process.env.HC_SESSION } : {}) },
      core: { session: process.env.HC_SESSION || "default", ...(process.env.HC_SOCKET ? { socket: process.env.HC_SOCKET } : {}) },
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
    for (const view of state.views) {
      for (const viewer of view.viewers) {
        if (viewer.state !== "live" || !viewer.terminal) continue;
        const seen = await terminalState(this.deps.hc, viewer.terminal);
        if (seen.state === "unknown") {
          notes.push(`${viewer.label}: its viewer ${viewer.terminal} could not be checked (${seen.reason}); it is kept as it is.`);
        } else if (seen.state === "gone") {
          viewer.state = "ended";
          viewer.terminal = null;
          changed = true;
          notes.push(`${viewer.label}: its viewer ended outside OpenRig; its cell now says so.`);
        }
      }
    }
    if (changed) {
      const written = await this.write(state);
      if (!written.ok) notes.push(written.error);
    }
    if (state.pendingEnds.length) notes.push(...await this.endPending(state));
    return notes;
  }

  private async open(view: ComposedView): Promise<OpenViewResult> {
    const files = this.deps.files;
    const status = await this.deps.app.status(1_000);
    if (status.kind !== "ok") {
      return fail("herdr_app_unavailable", `herdr-app is not answering at ${files.appHome} (${describe(status)}). Nothing was started.`,
        { absent: view.absent, degraded: view.degraded });
    }
    const mods = await this.deps.ensureMods();
    if (!mods.ok) return fail("herdr_app_mods", mods.error, { absent: view.absent, degraded: view.degraded });
    const state = await files.load();
    const owned = await files.rigOwnership(state);
    if (!owned.ours) return fail("rig_layout_not_owned", owned.reason, { absent: view.absent, degraded: view.degraded });
    const notes = await this.reconcileState(state);
    const shown = (status.value as { layout?: unknown }).layout;
    state.base ??= typeof shown === "string" && shown !== RIG_LAYOUT ? shown : "main";
    if (!view.pages.length) return fail("nothing_to_open", "No attachable seats in this view; nothing was started.", { absent: view.absent, degraded: view.degraded });
    // The write below needs the person's layout: check it before any viewer starts.
    if (!await files.readLayout(state.base)) {
      return fail("base_layout_missing", `The layout OpenRig builds on, ${state.base}, could not be read from ${files.appHome}/layouts. Nothing was started.`,
        { absent: view.absent, degraded: view.degraded, notes });
    }

    // 1. Journal first.
    const name = view.viewDescriptor?.name ?? view.spaceLabel ?? view.id;
    const created: ViewRecord[] = view.pages.map((page, index) => {
      const id = `rv-${this.nonce()}`;
      return {
        id, name: view.pages.length > 1 ? `${name} ${index + 1}/${view.pages.length}` : name,
        source: { view: view.id, page: index }, createdAt: this.now(), ...(view.columns ? { columns: view.columns } : {}),
        viewers: page.map((pane) => {
          const nonce = this.nonce();
          const cell = cellFor(id, pane, nonce, null);
          return { cellId: cell.id, seat: pane.seat, label: pane.label, ...(pane.runtime ? { runtime: pane.runtime } : {}),
            nonce, argv: viewerArgv(pane, nonce), readOnly: pane.readOnly, terminal: null, state: "planned" as const };
        }),
      };
    });
    state.views.push(...created);
    await files.save(state);

    // 2. Start the viewers.
    const failed: string[] = [];
    for (const record of created) for (const viewer of record.viewers) {
      const started = await this.startViewer(record, viewer);
      if (started) { viewer.terminal = started; viewer.state = "live"; }
      else failed.push(viewer.seat);
    }
    await files.save(state);
    if (failed.length) {
      const rollback = await this.remove(state, created.map((v) => v.id), [], { neverWritten: true });
      return fail("viewer_start_failed", `herdr-core did not start viewers for ${failed.join(", ")}; this open was rolled back.`,
        { absent: view.absent, degraded: view.degraded, notes: [...notes, ...rollback] });
    }

    // 3. One atomic write.
    const written = await this.write(state);
    if (!written.ok) {
      const rollback = await this.remove(state, created.map((v) => v.id), [], { neverWritten: true });
      return fail(written.code, written.error, { absent: view.absent, degraded: view.degraded, notes: [...notes, ...rollback] });
    }

    // 4. Reveal: the person asked for this view.
    notes.push(...await this.reveal(created, written.revision));
    // Viewers this write released (kept from an earlier failed rewrite) end now, once the app shows it.
    if (state.pendingEnds.length) notes.push(...await this.endPending(state));
    return {
      provider: HERDR_APP_PROVIDER, ok: true,
      opened: created.flatMap((v) => v.viewers.map((viewer) => viewer.seat)),
      absent: view.absent, degraded: view.degraded, pages: created.length,
      space: { id: created[0]!.id, label: created[0]!.name },
      ...(notes.length ? { notes } : {}),
    };
  }

  private async startViewer(view: ViewRecord, viewer: ViewerRecord): Promise<string | null> {
    const labels = [
      `openrig.daemon=${this.deps.daemonInstance}`, "openrig.role=viewer", `openrig.view=${view.id}`,
      `openrig.op=${viewer.nonce}`, `openrig.seat=${viewer.seat}`, `openrig.cell=${viewer.cellId}`,
    ].flatMap((label) => ["--label", label]);
    const run = await this.deps.hc(["run", "--bg", "--no-parent", "--no-notify", "--json", "--cwd", this.deps.viewerCwd, ...labels, "--", ...viewer.argv]);
    const address = (run.json as { address?: unknown } | null)?.address;
    if (run.exit === 0 && typeof address === "string") return address;
    // An uncertain start: look for it by its nonce rather than start another.
    const found = await this.deps.hc(["ls", "--json", "--label", `openrig.op=${viewer.nonce}`]);
    const terminals = (found.json as { terminals?: { address?: unknown }[] } | null)?.terminals ?? [];
    const hit = terminals.find((t) => typeof t.address === "string");
    return hit ? hit.address as string : null;
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

  /** Shows the first page of this open; every page's interactive viewers get the keyboard, since the strip switches
   *  between pages without coming back to the daemon. */
  private async reveal(pages: ViewRecord[], revision: string): Promise<string[]> {
    const view = pages[0]!;
    const notes: string[] = [];
    const app = this.deps.app;
    const before = await app.status(1_000);
    if (before.kind === "ok" && (before.value as { layout?: unknown }).layout !== RIG_LAYOUT) {
      const switched = await app.do("layout.switch", { name: RIG_LAYOUT });
      if (switched.kind !== "ok") notes.push(`Showing OpenRig's Rig layout: ${describe(switched)}.`);
    }
    if (!await awaitApplied(this.deps.files, revision, [], { timeoutMs: this.deps.ackTimeoutMs ?? 8_000 })) {
      notes.push("herdr-app has not confirmed showing this view yet. It is written to the Rig layout and appears there; its viewers stay read-only until it is shown.");
      return notes;
    }
    const selected = await app.do("layout.select", { stack: RIG_STACK, child: view.id });
    if (selected.kind !== "ok") {
      notes.push(`Selecting the view: ${describe(selected)}. It is in the Rig strip; its viewers stay read-only.`);
      return notes;
    }
    for (const viewer of pages.flatMap((page) => page.viewers)) {
      if (viewer.readOnly || viewer.state !== "live" || !viewer.terminal) continue;
      const writable = await this.makeWritable(viewer);
      if (writable) notes.push(writable);
    }
    return notes;
  }

  /** The explicit reveal hands this viewer's tmux client the keyboard (`switch-client -r` toggles read-only). */
  private async makeWritable(viewer: ViewerRecord): Promise<string | null> {
    const tile = viewer.argv.indexOf("openrig-tile");
    if (tile < 0 || !this.deps.runTmux) return `${viewer.label}: stays read-only (no local tmux attachment to hand the keyboard to).`;
    const session = viewer.argv[tile + 1]!;
    const tmux = viewer.argv.slice(tile + 2);
    const got = await this.deps.hc(["get", "--json", viewer.terminal!]);
    // core reports the viewer's own process (the wrapper); its tmux client runs beneath it.
    const viewerPid = (got.json as { pid?: unknown } | null)?.pid;
    const parentPid = this.deps.parentPid ?? processParent;
    const beneath = async (pid: number) => {
      for (let p: number | null = pid, hops = 0; p && p > 1 && hops < 16; p = await parentPid(p), hops++) if (p === viewerPid) return true;
      return false;
    };
    try {
      // The viewer's client may still be attaching; look a few times.
      for (let attempt = 0; attempt < 10; attempt++) {
        const listed = await this.deps.runTmux([...tmux, "list-clients", "-t", `=${session}`, "-F", "#{client_pid} #{client_tty} #{client_readonly} #{session_name}"]);
        let client: string[] | undefined;
        for (const line of listed.split("\n")) {
          const fields = line.trim().split(" ");
          if (typeof viewerPid === "number" && await beneath(Number(fields[0]))) { client = fields; break; }
        }
        if (client) {
          if (client[3] !== session) return `${viewer.label}: stays read-only (its tmux client shows ${client[3]}, not ${session}).`;
          // `-r` toggles read-only. `-t` is required: without it tmux also moves the client to its current session.
          if (client[2] === "1") await this.deps.runTmux([...tmux, "switch-client", "-c", client[1]!, "-t", `=${session}`, "-r"]);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (error) {
      return `${viewer.label}: stays read-only (${(error as Error).message}).`;
    }
    return `${viewer.label}: stays read-only (its tmux client could not be identified).`;
  }

  /**
   * Remove whole views and single viewers. The file is rewritten first; a viewer is ended only once the app has
   * acknowledged a revision without it (or the Rig layout is not shown, so the app reads the new file when it is),
   * and only if it is verifiably this OpenRig's. Returns notes for anything left in place.
   */
  private async remove(state: ClientState, viewIds: readonly string[], cells: readonly string[], opts: { neverWritten?: boolean } = {}): Promise<string[]> {
    const removals: Removal[] = [];
    const take = (viewer: ViewerRecord) => {
      if (viewer.terminal && viewer.state === "live") removals.push({ terminal: viewer.terminal, cellId: viewer.cellId, nonce: viewer.nonce, argv: viewer.argv });
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
    const status = await this.deps.app.status(1_000);
    const pending = state.pendingEnds;
    const latest = state.revision;
    let safe: PendingEnd[] = [];
    if (status.kind !== "ok") {
      notes.push(`${pending.length} viewer(s) left running: herdr-app's state is uncertain (${describe(status)}).`);
    } else if ((status.value as { layout?: unknown }).layout !== RIG_LAYOUT) {
      // Not shown: the app reads the current file whenever the Rig layout is shown next, so no block refers to them.
      safe = pending.filter((p) => p.revision !== "unwritten");
    } else if (latest && await awaitApplied(this.deps.files, latest, pending.map((p) => p.terminal), { timeoutMs: this.deps.ackTimeoutMs ?? 8_000 })) {
      safe = pending.filter((p) => p.revision !== "unwritten");
    } else {
      notes.push(`${pending.length} viewer(s) left running: herdr-app has not confirmed the layout without them yet.`);
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

  /** Ends a viewer only when the journal, its labels and its exact argv all say it is this OpenRig's. */
  /** Ends a viewer only when the journal, its labels and its exact argv all say it is this OpenRig's. `kept`: still
   *  pending (core couldn't be asked, or the kill failed), to be tried again. */
  private async endVerified(end: Removal): Promise<{ kept: boolean; note?: string }> {
    const seen = await terminalState(this.deps.hc, end.terminal);
    if (seen.state === "gone") return { kept: false };
    if (seen.state === "unknown") return { kept: true, note: `Viewer ${end.terminal} was left running for now: core could not be asked (${seen.reason}).` };
    const t = seen.record;
    const ours = t.labels?.["openrig.role"] === "viewer" && t.labels?.["openrig.op"] === end.nonce
      && t.labels?.["openrig.daemon"] === this.deps.daemonInstance
      && JSON.stringify(t.argv) === JSON.stringify(end.argv);
    if (!ours) return { kept: false, note: `Viewer ${end.terminal} was left in place: it can't be verified as this OpenRig's.` };
    const killed = await this.deps.hc(["kill", end.terminal]);
    return killed.exit === 0 ? { kept: false } : { kept: true, note: `Viewer ${end.terminal} could not be ended yet: ${killed.error?.message ?? `hc exited ${killed.exit}`}.` };
  }
}

/** The parent of `pid` (Linux /proc, else `ps`), or null. */
export async function processParent(pid: number): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || null;
  } catch {
    try {
      return Number((await promisify(execFile)("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" })).stdout.trim()) || null;
    } catch { return null; }
  }
}

export const execTmux = async (argv: string[]): Promise<string> => (await promisify(execFile)(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 5_000 })).stdout;
