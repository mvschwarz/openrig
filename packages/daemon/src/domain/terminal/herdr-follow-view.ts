import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWindowsPrivateDirectory } from "../windows-owned-text.js";
import { replaceWindowsPrivateTextFile } from "../private-text-file.js";
import { nativeViewerShellCommand } from "./native-viewer-command.js";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import { HerdrViewer, ViewerCreateNotDispatchedError, findAttributedViewerPanes, sameHerdrPath, sameViewerCwd, readHerdrViewerBody as body, parseHerdrViewerPane as pane,
  type HerdrViewerRun, type InspectViewerSeat, type ViewerKey, type ViewerMapping, type ViewerPane } from "./herdr-viewer.js";
import { DEFAULT_FOLLOW_POLICY, planFollowingTiles, type FollowControls, type FollowPolicy, type FollowTile, type FollowingStatus } from "./terminal-follow-policy.js";
import type { ComposedPane, ComposedView, OpenViewResult } from "./terminal-provider.js";
import type { HerdrTransport } from "./herdr-transport.js";
import { earlierTileAttachment } from "./tile-attach.js";
import { RESUME_REPORT_INTERVAL_MS, RESUME_REPORT_ROUNDS } from "./herdr-adapter.js";

export type ReadFollowInput = (target: ComposedPane) => Promise<"empty" | "text" | "unknown">;
/** `resume`: Herdr holds this tile's own resume command, so a Herdr restart brings it back attached. */
interface Tile extends FollowTile { member: ViewerKey; target: ComposedPane; viewer: ViewerMapping; reason?: string; resume?: true }
interface Canvas {
  version: 1; cwd: string; phase: "creating" | "created" | "starting";
  pane?: ViewerPane; policy: FollowPolicy; tiles: Tile[]; events: string[];
  stripConfirmed?: boolean;
  closing?: string;
  viewerFailures?: Record<string, { target: string; reason: string }>;
}
export interface HerdrFollowDeps {
  socketPath: string;
  run: HerdrViewerRun;
  transport: HerdrTransport;
  input?: ReadFollowInput;
  inspect?: InspectViewerSeat;
  platform?: NodeJS.Platform;
  root?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const keyOf = (hostId: string | null, nodeId: string | null) => JSON.stringify([hostId, nodeId]);
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** A presentation journal for ONE stable workspace per selector/endpoint.
 * It stores owned viewer provenance, never authoritative task membership.
 * Joins split without focus; departures close only verified viewer clients.
 * No layout.apply, lifecycle calls, terminal input, or membership polling.
 */
export class HerdrFollowView {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: HerdrFollowDeps) {}

  follow(viewId: string, view: ComposedView | null, controls: FollowControls, stillCurrent: () => Promise<boolean>, membershipError?: string): Promise<OpenViewResult> {
    const result = this.pending.then(() => this.apply(viewId, view, controls, stillCurrent, membershipError));
    this.pending = result.catch(() => {}); return result;
  }
  /**
   * Give Herdr each new tile's resume command, its own attach script, so a Herdr restart brings the tile back attached.
   * A Claude, Codex or Pi tile carries Herdr's detection hint in that script, and reports under the runtime's label as
   * one-shot tiles do (#1796), so Herdr's own screen detection keeps the tile's state; Herdr takes it once it has
   * detected the agent, so a `resume_not_accepted` is retried in rounds. Any other tile has no agent for Herdr to
   * detect, so OpenRig holds it with one state report that carries the command. What isn't taken is a note.
   */
  private async reportResume(opened: Array<{ tile: Tile; argv: string[]; agent?: "claude" | "codex" | "pi" }>): Promise<string[]> {
    const notes: string[] = [];
    let waiting: typeof opened = [];
    for (const item of opened) {
      const argv = item.argv;
      if (argv.some(arg => /['\u0000-\u001f\u007f]/.test(arg))) { notes.push(`${item.tile.seat}: its tile path can't be a Herdr restart command; after a Herdr restart, follow again.`); continue; }
      if (item.agent) { waiting.push(item); continue; }
      try {
        await this.deps.transport.request("pane.report_agent", { pane_id: item.tile.viewer.paneId, source: "openrig-tile", agent: "openrig-tile",
          state: "idle", seq: this.deps.now?.() ?? Date.now(), resume_argv: argv });
        item.tile.resume = true;
      } catch (error) { notes.push(`${item.tile.seat}: Herdr didn't take its restart command (${error instanceof Error ? error.message : String(error)}); after a Herdr restart, follow again.`); }
    }
    for (let round = 1; waiting.length > 0 && round <= RESUME_REPORT_ROUNDS; round++) {
      if (round > 1) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(RESUME_REPORT_INTERVAL_MS);
      const next: typeof waiting = [];
      for (const item of waiting) {
        try {
          await this.deps.transport.request("pane.report_agent_session", { pane_id: item.tile.viewer.paneId, source: "openrig", agent: item.agent, resume_argv: item.argv });
          item.tile.resume = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/resume_not_accepted/.test(message)) next.push(item);
          else notes.push(`${item.tile.seat}: Herdr didn't take its restart command (${message}); after a Herdr restart, follow again.`);
        }
      }
      waiting = next;
    }
    for (const item of waiting) notes.push(`${item.tile.seat}: Herdr hadn't detected its agent yet, so the tile has no restart command; after a Herdr restart, follow again.`);
    return notes;
  }

  /** A restored canvas, confirmably this one: its strip the only pane in its own directory, in the same workspace and
   *  pane, and every tile resumed and rebound by its viewer (same pane, its private directory, attached again). Null
   *  when any of that can't be shown; nothing changes then. */
  private async rebindRestored(state: Canvas, root: string): Promise<{ strip: ViewerPane; viewers: Map<string, ViewerMapping> } | null> {
    if (!state.pane || state.tiles.some(tile => !tile.resume)) return null;
    try {
      const platform = this.deps.platform ?? process.platform;
      const strips = (await findAttributedViewerPanes(this.deps.run, state.cwd, platform))
        .filter(found => sameViewerCwd(found.cwd, state.cwd, platform));
      const strip = strips.length === 1 && strips[0]!.workspace_id === state.pane.workspace_id && strips[0]!.pane_id === state.pane.pane_id ? strips[0]! : null;
      if (!strip) return null;
      const viewers = new HerdrViewer(this.deps.socketPath, this.deps.run, this.deps.platform, path.join(root, "viewers"), this.deps.inspect);
      const rebound = new Map<string, ViewerMapping>();
      for (const tile of state.tiles) {
        const verified = await viewers.rebind(tile.member, tile.target);
        if (!verified.ok) return null;
        rebound.set(tile.key, verified.viewer);
      }
      return { strip: { workspace_id: strip.workspace_id, pane_id: strip.pane_id, terminal_id: strip.terminal_id }, viewers: rebound };
    } catch { return null; }
  }

  private async apply(viewId: string, view: ComposedView | null, controls: FollowControls, stillCurrent: () => Promise<boolean>, membershipError?: string, replaced?: string): Promise<OpenViewResult> {
    const platform = this.deps.platform ?? process.platform;
    const privateDirectory = (directory: string) => platform === "win32" ? ensureWindowsPrivateDirectory(directory) : mkdirSync(directory, {recursive:true,mode:0o700});
    const id = createHash("sha256").update(JSON.stringify([this.deps.socketPath, viewId])).digest("hex");
    const root = path.join(this.deps.root ?? getDefaultOpenRigPath("private/terminal-following/provider"), id);
    const file = path.join(root, "canvas.json"), log = path.join(root, "events.log");
    let state: Canvas | undefined;
    const now = () => this.deps.now?.() ?? Date.now();
    const result = (ok: boolean, status: FollowingStatus["state"], error?: string, nextAt?: number): OpenViewResult => ({
      provider: "herdr", ok, opened: state?.tiles.map(t => t.seat) ?? [], absent: view?.absent ?? [], degraded: view?.degraded ?? [],
      pages: state?.pane ? 1 : 0, ...(state?.pane ? { workspaceId: state.pane.workspace_id } : {}),
      ...(error ? { code: "follow_unconfirmed", error } : {}),
      following: { id, enabled: controls.enabled, state: status, maxTiles: state?.policy.maxTiles ?? DEFAULT_FOLLOW_POLICY.maxTiles,
        tiles: state?.tiles.map(({ key, seat, departedAt }) => ({ key, seat, departedAt })) ?? [], events: state?.events ?? [], overflow: [], ...(nextAt ? { nextAt } : {}) },
    });
    const unsupported = (reason: string): OpenViewResult => {
      if (state) throw new Error(`${reason} Keeping the existing canvas.`);
      const answer = result(false, "disabled", reason);
      answer.code = "follow_unsupported"; answer.following!.enabled = false;
      return answer;
    };
    const save = () => {
      privateDirectory(root);
      if (platform === "win32") replaceWindowsPrivateTextFile(file, JSON.stringify(state) + "\n");
      else {
        const temporary = `${file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 }); renameSync(temporary, file);
      }
      const lines = state!.events.join("\n") + "\n";
      let previous = ""; try { previous = readFileSync(log, "utf8"); } catch { /* initial own strip */ }
      if (previous !== lines) {
        if (platform === "win32") replaceWindowsPrivateTextFile(log, lines);
        else writeFileSync(log, lines, { mode: 0o600 });
      }
    };
    const notice = (line: string) => {
      if (state!.events.at(-1) !== line) state!.events = [...state!.events, line].slice(-60);
    };
    const viewerFailure = (key: string, target: ComposedPane, failure: { phase?: string; error: string }) => {
      const current = `${failure.phase ?? "unknown"}: ${failure.error}`;
      const attachment = JSON.stringify([target.paneCommand, target.attachArgv, target.readOnly]);
      const failures = state!.viewerFailures ??= {};
      if (!failures[key] || failures[key].target !== attachment) failures[key] = { target: attachment, reason: current };
      return `current confirmation: ${current}; first failure: ${failures[key]!.reason}`;
    };
    try {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Canvas;
        if (saved.version !== 1 || !saved.policy || !Array.isArray(saved.tiles) || !Array.isArray(saved.events)
          || !sameHerdrPath(saved.cwd, path.join(root, "strip"))) throw new Error("Following provenance is unreadable; it was preserved.");
        state = saved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!controls.enabled) return result(true, "disabled"); // Keep the fixed canvas exactly as it is.
      if (!view?.task?.complete) {
        const message = membershipError ?? "Task membership is incomplete; keeping the previous view.";
        if (state) { notice(message); save(); }
        return result(false, "retained", message);
      }
      if (!["linux", "darwin", "win32"].includes(platform)) return unsupported("Live following supports Linux, macOS and Windows with Herdr protocol 22.");
      const status = body(await this.deps.run(["status", "server", "--json"]));
      if (status.running !== true || !sameHerdrPath(status.socket, this.deps.socketPath)) {
        throw new Error("Herdr protocol 22 or the selected endpoint is unconfirmed; keeping the previous view.");
      }
      if (status.protocol !== 22) return unsupported("Live following requires Herdr protocol 22 and confirmed pane/process replies.");
      if (!await stillCurrent()) throw new Error("Task membership changed before reconciliation; keeping the previous view.");
      if (!state) {
        state = { version: 1, cwd: path.join(root, "strip"), phase: "creating", policy: { ...DEFAULT_FOLLOW_POLICY, ...(view.task.kind === "slice" || view.task.kind === "mission" ? { maxTiles: 4 } : {}), pins: [], suppressed: {} },
          stripConfirmed: false, tiles: [], events: [...(replaced && replaced !== "rebound" ? [replaced] : []), `Following ${view.task.name}. Opening a tile can change an agent's terminal size.`] };
        privateDirectory(state.cwd); save();
        // Persist first. An uncertain response is enumerated on the next call,
        // never interpreted as permission for another workspace.
        const reply = body(await this.deps.run(["workspace", "create", "--cwd", state.cwd,
          "--label", view.task.name, "--no-focus"]));
        const made = pane(reply.root_pane);
        if (!made) throw new Error("Workspace creation returned no pane/terminal identity.");
        // A successful creation reply binds these IDs even if the rc already ran cd.
        state.pane = made; state.phase = "created"; save();
      }
      if (!state.pane) {
        const found = await findAttributedViewerPanes(this.deps.run, state.cwd, state.pane, platform);
        if (found.length !== 1) throw new Error("Uncertain workspace creation has no unique attributed pane; no create was repeated.");
        state.pane = found[0]!; state.phase = "created"; save();
      }
      const currentPane = async (expected: ViewerPane | ViewerMapping): Promise<ViewerPane> => {
        const isStored = "pane_id" in expected;
        const current = pane(body(await this.deps.run(["pane", "get", isStored ? expected.pane_id : expected.paneId])).pane);
        if (!current || current.pane_id !== (isStored ? expected.pane_id : expected.paneId)
          || current.terminal_id !== (isStored ? expected.terminal_id : expected.terminalId)
          || current.workspace_id !== (isStored ? expected.workspace_id : expected.workspaceId)
          || typeof current.focused !== "boolean") {
          throw new Error("Provider generation or pane attribution changed; keeping the previous view.");
        }
        return current;
      };
      const stripArgv = platform === "win32"
        ? [process.execPath, fileURLToPath(new URL("../../../assets/terminal/follow-events.mjs", import.meta.url)), log]
        : ["/usr/bin/tail", "-n", "30", "-F", log];
      try { await currentPane(state.pane); }
      catch (error) {
        // After a Herdr restart (or once the person closes the workspace) Herdr no longer has this canvas's strip: it
        // comes back as a new terminal, or not at all. A complete enumeration without its exact identity says so, and
        // the canvas yields to a fresh one, kept aside as provenance, so re-following recovers the view. An unreadable
        // enumeration proves nothing and keeps the previous view, as any failed read does; a fresh canvas never yields.
        const stored = state.pane;
        let gone = false;
        if (!replaced) { // a fresh or just re-bound canvas never yields again in the same follow
          try {
            gone = !(await findAttributedViewerPanes(this.deps.run, state.cwd, stored, platform)).some(found => found.pane_id === stored.pane_id
              && found.terminal_id === stored.terminal_id && found.workspace_id === stored.workspace_id);
          } catch { /* unknown, not gone */ }
        }
        if (!gone) throw error;
        // Herdr restores a workspace with the same pane ids in new terminals, and reruns each tile's resume command once a
        // client attaches. A canvas whose strip is back in its own directory and whose every tile resumed and is verified
        // attached again is this canvas: it re-binds instead of yielding, so restored tiles don't get a second workspace.
        const rebound = await this.rebindRestored(state, root);
        if (rebound) {
          state.pane = rebound.strip; state.phase = "created"; state.stripConfirmed = false;
          for (const tile of state.tiles) tile.viewer = rebound.viewers.get(tile.key)!;
          notice("Herdr restarted; this workspace and its tiles were found again and re-attached."); save();
          return this.apply(viewId, view, controls, stillCurrent, membershipError, "rebound");
        }
        const kept = `${root}.replaced-${now()}-${randomUUID().slice(0, 8)}`;
        renameSync(root, kept);
        return this.apply(viewId, view, controls, stillCurrent, membershipError,
          `Herdr no longer has the previous workspace (it restarted, or the workspace was closed); this is a new one. If the old one is still open, close it. Its record is kept at ${kept}.`);
      }
      if (state.phase === "created") {
        let command = `printf '\\033[2J\\033[3J\\033[H'; exec /usr/bin/tail -n 30 -F ${quote(log)}`;
        if (platform === "win32") {
          const observed = body(await this.deps.run(["pane", "process-info", "--pane", state.pane.pane_id]));
          command = nativeViewerShellCommand(stripArgv, observed.process_info, state.cwd);
        }
        state.phase = "starting"; save();
        await this.deps.run(["pane", "run", state.pane.pane_id, command]);
      }
      let stripReady = false;
      // A first login shell can take seconds. Observe its single dispatched run
      // for a bounded startup window, never steady membership polling.
      const stripDeadline = Date.now() + (state.stripConfirmed === false ? 10000 : 0);
      while (true) {
        const strip = body(await this.deps.run(["pane", "process-info", "--pane", state.pane.pane_id]));
        const processes = (strip.process_info as { foreground_processes?: Array<{ argv?: string[] }> } | undefined)?.foreground_processes;
        stripReady = processes?.some(p => JSON.stringify(p.argv) === JSON.stringify(stripArgv)) ?? false;
        if (stripReady) break;
        const remaining = stripDeadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
      }
      if (!stripReady) {
        throw new Error("The explanation strip process is unconfirmed; pane run was not repeated.");
      }
      await currentPane(state.pane); // Reconfirm generation after a slow shell start.
      if (!state.stripConfirmed) { state.stripConfirmed = true; save(); }
      const members = view.task.members.map(m => ({ key: keyOf(m.key.hostId, m.key.nodeId), seat: m.seat }));
      for (const key of Object.keys(state.viewerFailures ?? {})) {
        if (!members.some(member => member.key === key) && !state.tiles.some(tile => tile.key === key)) delete state.viewerFailures![key];
      }
      const controlsToKeys = (seats: string[] = []) => seats.map(seat => {
        const member = members.find(m => m.seat === seat) ?? state!.tiles.find(m => m.seat === seat);
        if (!member) throw new Error(`No current or retained member named ${seat}.`);
        return member.key;
      });
      const policy = state.policy;
      for (const field of ["maxTiles", "graceMs", "focusRetentionMs"] as const) if (controls[field] !== undefined) policy[field] = controls[field]!;
      policy.pins = [...new Set([...policy.pins, ...controlsToKeys(controls.pin)])].filter(key => !controlsToKeys(controls.unpin).includes(key));
      for (const key of controlsToKeys(controls.suppress)) policy.suppressed[key] = now() + (controls.suppressionMs ?? 60000);
      for (const key of controlsToKeys(controls.unsuppress)) delete policy.suppressed[key];
      const viewers = new HerdrViewer(this.deps.socketPath, this.deps.run, this.deps.platform,
        path.join(root, "viewers"), this.deps.inspect);
      if (state.closing) {
        const closing = state.tiles.find(t => t.key === state!.closing);
        if (!closing || !await viewers.forgetClosed(closing.member, closing.viewer)) {
          throw new Error("A prior close has an uncertain outcome; it was not repeated.");
        }
        state.tiles = state.tiles.filter(t => t.key !== state!.closing); delete state.closing; save();
      }
      const observations = new Map<string, { focused: boolean; input: "empty" | "text" | "unknown" }>();
      // Validate ALL old identities before any change. One failed read retains
      // the whole view, rather than presenting an untrusted partial inventory.
      for (const tile of state.tiles) {
        let expectedTarget = tile.target;
        const currentMember = view.task.members.find(m => keyOf(m.key.hostId, m.key.nodeId) === tile.key);
        if (currentMember?.availability === "available") {
          const target = view.opened.find(p => p.seat === currentMember.seat);
          // Recognise an older generated script, but don't rewrite its saved target until the
          // actual viewer is verified. An old live writable client may require an explicit reopen.
          if (target?.attachArgv && tile.target.attachArgv && target.paneCommand !== tile.target.paneCommand
            && target.readOnly === tile.target.readOnly && earlierTileAttachment(tile.target.attachArgv, target.attachArgv, target.readOnly)) {
            expectedTarget = target;
          }
          if (!target || target.paneCommand !== expectedTarget.paneCommand || target.readOnly !== expectedTarget.readOnly
            || JSON.stringify(target.attachArgv) !== JSON.stringify(expectedTarget.attachArgv)) {
            throw new Error(`${tile.seat}: Core's current attachment differs from the retained viewer; keeping the previous view unconfirmed.`);
          }
        }
        let current: ViewerPane;
        try { current = await currentPane(tile.viewer); }
        catch (error) { throw new Error(`${tile.seat}: unknown: ${error instanceof Error ? error.message : String(error)}`); }
        const verified = await viewers.lookup(tile.member, expectedTarget);
        if (!verified.ok) throw new Error(`${tile.seat}: ${viewerFailure(tile.key, tile.target, verified)} Keeping the whole view.`);
        if (JSON.stringify(verified.viewer) !== JSON.stringify(tile.viewer)) throw new Error(`${tile.seat}: Viewer mapping changed; keeping the whole view.`);
        tile.target = expectedTarget;
        delete state.viewerFailures?.[tile.key];
        observations.set(tile.key, { focused: current.focused!, input: await this.deps.input?.(tile.target) ?? "unknown" });
      }
      const plan = planFollowingTiles(state.tiles, members, true, observations, policy, now());
      const opened: Array<{ tile: Tile; argv: string[]; agent?: "claude" | "codex" | "pi" }> = [];
      save(); // presentation choices survive lost replies and daemon restarts.
      for (const join of plan.joins) {
        const member = view.task.members.find(m => keyOf(m.key.hostId, m.key.nodeId) === join.key)!;
        const target = member.availability === "available" && view.opened.find(p => p.seat === join.seat);
        if (!target || !member.key.hostId || !member.key.nodeId) { notice(`${join.seat}: ${member.reason ?? "Terminal is unavailable; the member remains in this task."}`); continue; }
        const memberKey = { hostId: member.key.hostId, nodeId: member.key.nodeId };
        let verified = await viewers.ensure(memberKey, target, stillCurrent, async (cwd) => {
          const anchor = state!.tiles.at(-1)?.viewer;
          try {
            await currentPane(state!.pane!);
            if (!await stillCurrent()) throw new Error("Membership changed before the split.");
            if (anchor) await currentPane(anchor);
          } catch (error) {
            throw new ViewerCreateNotDispatchedError(error instanceof Error ? error.message : String(error));
          }
          const split = body(await this.deps.run(["pane", "split", "--pane", anchor?.paneId ?? state!.pane!.pane_id,
            "--direction", anchor && state!.tiles.length % 2 ? "right" : "down", "--no-focus", "--cwd", cwd]));
          return JSON.stringify({ root_pane: split.pane });
        });
        if (!verified.ok) { viewerFailure(join.key, target, verified); save(); }
        for (let attempt = 0; !verified.ok && attempt < 5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          verified = await viewers.lookup(memberKey, target); // read-only: never repeats a create/run.
        }
        if (!verified.ok) { notice(`${join.seat}: ${viewerFailure(join.key, target, verified)}`); continue; }
        delete state.viewerFailures?.[join.key];
        state.tiles.push({ key: join.key, seat: join.seat, target, member: { hostId: member.key.hostId, nodeId: member.key.nodeId }, viewer: verified.viewer });
        notice(`${join.seat}: ${join.reason}`); save();
        // A tile reports its restart command when it first enters the canvas, whether this call created its viewer or an
        // earlier, interrupted follow did (resumed from the journal, or confirmed by the lookup above). Retained tiles never
        // pass through here, so they aren't reported again.
        opened.push({ tile: state.tiles.at(-1)!, argv: verified.resumeArgv, ...(verified.agent ? { agent: verified.agent } : {}) });
      }
      for (const line of await this.reportResume(opened)) notice(line);
      if (opened.some(o => o.tile.resume)) save();
      for (const leaving of plan.leaves) {
        const tile = state.tiles.find(t => t.key === leaving.key)!;
        const retainInput = () => {
          if (!members.some(m => m.key === tile.key)) {
            const deadline = tile.inputRecheckAt ?? (now() + 30000);
            tile.inputRecheckAt = deadline;
            if (deadline > now()) plan.nextAt = Math.min(plan.nextAt ?? Infinity, deadline);
            tile.departedAt ??= now(); plan.tiles.push(tile);
            plan.retained.push({ key: tile.key, seat: tile.seat, reason: "Left the task; keeping its typed or unconfirmed input." });
          }
          notice(`${tile.seat}: Keeping its tile because input is typed or unconfirmed.`); save();
        };
        const retainLateFocus = (current: ViewerPane): boolean => {
          if (!current.focused || observations.get(tile.key)?.focused || policy.focusRetentionMs === 0) return false;
          tile.departedAt ??= now();
          tile.focusRetainUntil = now() + policy.focusRetentionMs;
          const reason = "Left the task; keeping the newly focused tile briefly for reading.";
          plan.retained.push({ key: tile.key, seat: tile.seat, reason }); plan.tiles.push(tile);
          plan.nextAt = Math.min(plan.nextAt ?? Infinity, tile.focusRetainUntil);
          notice(`${tile.seat}: ${reason}`); save(); return true;
        };
        if (!await stillCurrent()) throw new Error("Membership changed before a departure; remaining tiles were kept.");
        // A draft can appear after planning. Suppression is an explicit request
        // to hide, but it still must not destroy an in-progress typed draft.
        if (await this.deps.input?.(tile.target) !== "empty") { retainInput(); continue; }
        const current = await currentPane(tile.viewer);
        if (retainLateFocus(current)) continue;
        if (current.focused) {
          const survivor = state.tiles.find(t => t.key !== tile.key && !plan.leaves.some(l => l.key === t.key));
          const focus = survivor ? await currentPane(survivor.viewer) : await currentPane(state.pane);
          await this.deps.transport.request("pane.focus", { pane_id: focus.pane_id });
          if (!(await currentPane(focus)).focused || (await currentPane(tile.viewer)).focused) throw new Error("Focus transfer was not confirmed; the departing tile was kept.");
        }
        const verified = await viewers.lookup(tile.member, tile.target);
        if (!verified.ok || JSON.stringify(verified.viewer) !== JSON.stringify(tile.viewer)) throw new Error("Departure viewer identity changed; no tile was closed.");
        if (!await stillCurrent()) throw new Error("Membership changed before closing; remaining viewers were kept.");
        if (await this.deps.input?.(tile.target) !== "empty") { retainInput(); continue; }
        if (retainLateFocus(await currentPane(tile.viewer))) continue;
        state.closing = tile.key; save();
        await this.deps.run(["pane", "close", tile.viewer.paneId]);
        if (!await viewers.forgetClosed(tile.member, tile.viewer)) throw new Error("Tile close remains unconfirmed; no second close was attempted.");
        state.tiles = state.tiles.filter(t => t.key !== tile.key); delete state.viewerFailures?.[tile.key]; delete state.closing; notice(`${tile.seat}: ${leaving.reason}`); save();
      }
      for (const retained of plan.retained) {
        const tile = state.tiles.find(t => t.key === retained.key);
        if (!tile) continue;
        const changed = tile.reason !== retained.reason;
        tile.departedAt = plan.tiles.find(t => t.key === tile.key)?.departedAt;
        tile.inputRecheckAt = plan.tiles.find(t => t.key === tile.key)?.inputRecheckAt;
        tile.reason = retained.reason;
        if (changed) {
          notice(`${tile.seat}: ${retained.reason}`);
          await this.deps.run(["pane", "report-metadata", tile.viewer.paneId, "--source", "openrig-follow",
            "--display-agent", `${tile.seat} (no longer in this task)`, "--seq", String(now())]);
        }
      }
      // Clear a previous departure marker when a member rejoins.
      for (const tile of state.tiles) if (members.some(m => m.key === tile.key)) {
        if (tile.reason) await this.deps.run(["pane", "report-metadata", tile.viewer.paneId, "--source", "openrig-follow", "--display-agent", tile.seat, "--seq", String(now())]);
        delete tile.departedAt; delete tile.focusRetainUntil; delete tile.inputRecheckAt; delete tile.reason;
      }
      for (const member of view.task.members) if (member.availability !== "available") notice(`${member.seat}: ${member.reason ?? member.availability}`);
      for (const overflow of plan.overflow) notice(`${overflow.seat}: ${overflow.reason}`);
      if (!members.length && !state.tiles.length) notice(view.task.kind === "qitem"
        ? "No open obligation remains. Automatic following has stopped; the workspace is kept. Use --follow to resume it."
        : `No active work; waiting for associated work while following this ${view.task.kind}.`);
      save();
      const unavailableJoins = plan.joins.filter(join => !state!.tiles.some(tile => tile.key === join.key)
        && view.task!.members.some(m => keyOf(m.key.hostId, m.key.nodeId) === join.key && m.availability === "available"));
      const answer = result(unavailableJoins.length === 0, members.length === 0 && state.tiles.length === 0 ? "empty" : "following",
        unavailableJoins.length ? "Some current members have unconfirmed viewers; see the explanation strip. Inspect before refreshing." : undefined, plan.nextAt);
      if (view.task.kind === "qitem" && answer.following!.state === "empty") answer.following!.enabled = false;
      answer.following!.overflow = plan.overflow;
      answer.following!.tiles = state.tiles.map(t => ({ key: t.key, seat: t.seat, departedAt: t.departedAt,
        ...(plan.retained.find(r => r.key === t.key) ? { reason: plan.retained.find(r => r.key === t.key)!.reason } : {}) }));
      return answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state) {
        notice(`Keeping the previous view: ${message.slice(0, 800)}`);
        try { save(); } catch { /* Report the original failure; preserve prior provider effects. */ }
      }
      return result(false, "retained", message);
    }
  }
}
