import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import { HerdrViewer, findAttributedViewerPanes, readHerdrViewerBody as body, parseHerdrViewerPane as pane,
  type HerdrViewerRun, type InspectViewerSeat, type ViewerKey, type ViewerMapping, type ViewerPane } from "./herdr-viewer.js";
import { DEFAULT_FOLLOW_POLICY, planFollowingTiles, type FollowControls, type FollowPolicy, type FollowTile, type FollowingStatus } from "./terminal-follow-policy.js";
import type { ComposedPane, ComposedView, OpenViewResult } from "./terminal-provider.js";
import type { HerdrTransport } from "./herdr-transport.js";

export type ReadFollowInput = (target: ComposedPane) => Promise<"empty" | "text" | "unknown">;
interface Tile extends FollowTile { member: ViewerKey; target: ComposedPane; viewer: ViewerMapping; reason?: string }
interface Canvas {
  version: 1; cwd: string; phase: "creating" | "created" | "starting";
  pane?: ViewerPane; policy: FollowPolicy; tiles: Tile[]; events: string[];
  closing?: string;
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
  private async apply(viewId: string, view: ComposedView | null, controls: FollowControls, stillCurrent: () => Promise<boolean>, membershipError?: string): Promise<OpenViewResult> {
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
    const save = () => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 }); renameSync(temporary, file);
      const lines = state!.events.join("\n") + "\n";
      let previous = ""; try { previous = readFileSync(log, "utf8"); } catch { /* initial own strip */ }
      if (previous !== lines) writeFileSync(log, lines, { mode: 0o600 });
    };
    const notice = (line: string) => {
      if (state!.events.at(-1) !== line) state!.events = [...state!.events, line].slice(-60);
    };
    try {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Canvas;
        if (saved.version !== 1 || !saved.policy || !Array.isArray(saved.tiles) || !Array.isArray(saved.events)
          || saved.cwd !== path.join(root, "strip")) throw new Error("Following provenance is unreadable; it was preserved.");
        state = saved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!controls.enabled) return result(true, "disabled"); // Keep the fixed canvas exactly as it is.
      if (!view?.task?.complete) {
        const message = membershipError ?? "Task membership is incomplete; keeping the previous view.";
        if (state) { notice(message); save(); }
        return result(false, "retained", message);
      }
      if ((this.deps.platform ?? process.platform) !== "linux") throw new Error("Following is qualified on Linux Herdr 0.9.5/protocol 22 only.");
      const status = body(await this.deps.run(["status", "server", "--json"]));
      if (status.version !== "0.9.5" || status.protocol !== 22 || status.running !== true || status.socket !== this.deps.socketPath) {
        throw new Error("The qualified provider endpoint is unconfirmed; keeping the previous view.");
      }
      if (!await stillCurrent()) throw new Error("Task membership changed before reconciliation; keeping the previous view.");
      if (!state) {
        state = { version: 1, cwd: path.join(root, "strip"), phase: "creating", policy: { ...DEFAULT_FOLLOW_POLICY, ...(view.task.kind === "slice" || view.task.kind === "mission" ? { maxTiles: 4 } : {}), pins: [], suppressed: {} },
          tiles: [], events: [`Following ${view.task.name}. Opening a tile can change an agent's terminal size.`] };
        mkdirSync(state.cwd, { recursive: true, mode: 0o700 }); save();
        // Persist first. An uncertain response is enumerated on the next call,
        // never interpreted as permission for another workspace.
        const reply = body(await this.deps.run(["workspace", "create", "--cwd", state.cwd,
          "--label", view.task.name, "--no-focus"]));
        const made = pane(reply.root_pane);
        if (!made || made.cwd !== state.cwd) throw new Error("Workspace creation returned no attributable pane/terminal pair.");
        state.pane = made; state.phase = "created"; save();
      }
      if (!state.pane) {
        const found = await findAttributedViewerPanes(this.deps.run, state.cwd);
        if (found.length !== 1) throw new Error("Uncertain workspace creation has no unique attributed pane; no create was repeated.");
        state.pane = found[0]!; state.phase = "created"; save();
      }
      const currentPane = async (expected: ViewerPane | ViewerMapping): Promise<ViewerPane> => {
        const isStored = "pane_id" in expected;
        const current = pane(body(await this.deps.run(["pane", "get", isStored ? expected.pane_id : expected.paneId])).pane);
        if (!current || current.pane_id !== (isStored ? expected.pane_id : expected.paneId)
          || current.terminal_id !== (isStored ? expected.terminal_id : expected.terminalId)
          || current.workspace_id !== (isStored ? expected.workspace_id : expected.workspaceId)
          || (isStored && current.cwd !== expected.cwd) || typeof current.focused !== "boolean") {
          throw new Error("Provider generation or pane attribution changed; keeping the previous view.");
        }
        return current;
      };
      await currentPane(state.pane);
      if (state.phase === "created") {
        state.phase = "starting"; save();
        await this.deps.run(["pane", "run", state.pane.pane_id, `/usr/bin/tail -n 30 -F ${quote(log)}`]);
      }
      let stripReady = false;
      // Bounded process-start observation, not steady membership polling.
      for (let attempt = 0; attempt < 6; attempt++) {
        const strip = body(await this.deps.run(["pane", "process-info", "--pane", state.pane.pane_id]));
        const processes = (strip.process_info as { foreground_processes?: Array<{ argv?: string[] }> } | undefined)?.foreground_processes;
        stripReady = processes?.some(p => JSON.stringify(p.argv) === JSON.stringify(["/usr/bin/tail", "-n", "30", "-F", log])) ?? false;
        if (stripReady) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!stripReady) {
        throw new Error("The explanation strip process is unconfirmed; pane run was not repeated.");
      }
      const members = view.task.members.map(m => ({ key: keyOf(m.key.hostId, m.key.nodeId), seat: m.seat }));
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
        const currentMember = view.task.members.find(m => keyOf(m.key.hostId, m.key.nodeId) === tile.key);
        if (currentMember?.availability === "available") {
          const target = view.opened.find(p => p.seat === currentMember.seat);
          if (!target || target.paneCommand !== tile.target.paneCommand || target.readOnly !== tile.target.readOnly
            || JSON.stringify(target.attachArgv) !== JSON.stringify(tile.target.attachArgv)) {
            throw new Error(`${tile.seat}: Core's current attachment differs from the retained viewer; keeping the previous view unconfirmed.`);
          }
        }
        const current = await currentPane(tile.viewer);
        const verified = await viewers.lookup(tile.member, tile.target);
        if (!verified.ok || JSON.stringify(verified.viewer) !== JSON.stringify(tile.viewer)) throw new Error("A retained viewer is unconfirmed; keeping the whole view.");
        observations.set(tile.key, { focused: current.focused!, input: await this.deps.input?.(tile.target) ?? "unknown" });
      }
      const plan = planFollowingTiles(state.tiles, members, true, observations, policy, now());
      save(); // presentation choices survive lost replies and daemon restarts.
      for (const join of plan.joins) {
        const member = view.task.members.find(m => keyOf(m.key.hostId, m.key.nodeId) === join.key)!;
        const target = member.availability === "available" && view.opened.find(p => p.seat === join.seat);
        if (!target || !member.key.hostId || !member.key.nodeId) { notice(`${join.seat}: ${member.reason ?? "Terminal is unavailable; the member remains in this task."}`); continue; }
        const memberKey = { hostId: member.key.hostId, nodeId: member.key.nodeId };
        let verified = await viewers.ensure(memberKey, target, stillCurrent, async (cwd) => {
          await currentPane(state!.pane!);
          if (!await stillCurrent()) throw new Error("Membership changed before the split.");
          const anchor = state!.tiles.at(-1)?.viewer;
          if (anchor) await currentPane(anchor);
          const split = body(await this.deps.run(["pane", "split", "--pane", anchor?.paneId ?? state!.pane!.pane_id,
            "--direction", anchor && state!.tiles.length % 2 ? "right" : "down", "--no-focus", "--cwd", cwd]));
          return JSON.stringify({ root_pane: split.pane });
        });
        for (let attempt = 0; !verified.ok && attempt < 5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          verified = await viewers.lookup(memberKey, target); // read-only: never repeats a create/run.
        }
        if (!verified.ok) { notice(`${join.seat}: ${verified.error}`); continue; }
        state.tiles.push({ key: join.key, seat: join.seat, target, member: { hostId: member.key.hostId, nodeId: member.key.nodeId }, viewer: verified.viewer });
        notice(`${join.seat}: ${join.reason}`); save();
      }
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
        state.tiles = state.tiles.filter(t => t.key !== tile.key); delete state.closing; notice(`${tile.seat}: ${leaving.reason}`); save();
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
        : "No active work; waiting for associated work while following this slice.");
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
