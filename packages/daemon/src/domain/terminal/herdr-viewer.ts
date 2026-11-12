import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync, realpathSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import { resolveOnPath } from "../../adapters/tmux-exec.js";
import type { ComposedPane } from "./terminal-provider.js";
import { earlierTileAttachment } from "./tile-attach.js";
import { shellQuote } from "../../adapters/shell-quote.js";

export interface ViewerKey { hostId: string; nodeId: string }
export interface ViewerMapping { workspaceId: string; paneId: string; terminalId: string; readOnly: boolean }
export type ViewerResult = { ok: true; viewer: ViewerMapping; created: boolean }
  | { ok: false; code: string; error: string; phase?: Entry["phase"] };
export type InspectViewerSeat = (argv: string[]) => Promise<{ sessionId: string; nodeId: string }>;
export type HerdrViewerRun = (argv: string[]) => Promise<string>;
/** Only the caller which has not dispatched a create may assert this. */
export class ViewerCreateNotDispatchedError extends Error {}
export type CreateViewerPane = (cwd: string, label: string) => Promise<string>;
export interface ViewerPane { workspace_id: string; pane_id: string; terminal_id: string; cwd?: string | null; focused?: boolean }
type Pane = ViewerPane;
interface Entry {
  cwd: string; label: string; command: string; argv: string[]; readOnly: boolean;
  phase: "creating" | "created" | "starting"; pane?: Pane; scriptHash?: string;
}
interface Journal { version: 1; entries: Record<string, Entry> }
const runFile = promisify(execFile);

/** The supported CLI, never guessed socket RPC method parity. Its reported
 * endpoint must match the adapter's selected socket before any mutation. */
export function createHerdrViewerRun(endpoint: { socketPath: string }, sourceEnv: NodeJS.ProcessEnv = process.env): HerdrViewerRun {
  // Herdr's explicit --session wins over the socket override. Select by the
  // already resolved socket alone, including paths outside the config tree.
  const env: NodeJS.ProcessEnv = { ...sourceEnv, HERDR_SOCKET_PATH: endpoint.socketPath };
  delete env.HERDR_SESSION;
  return async args => {
    const binary = resolveOnPath("herdr", env.PATH);
    if (!binary) throw new Error("Herdr CLI is unavailable.");
    const { stdout } = await runFile(binary, args,
      { env, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  };
}
async function inspectSeat(argv: string[]): Promise<{ sessionId: string; nodeId: string }> {
  const call = async (args: string[]) => (await runFile(argv[5]!, [...argv.slice(6), ...args], { encoding: "utf8", timeout: 3000 })).stdout.trim();
  const sessionId = await call(["display-message", "-p", "-t", `=${argv[4]}:`, "#{session_id}"]);
  if (!/^\$\d+$/.test(sessionId)) throw new Error("Seat session identity is unknown.");
  const node = await call(["show-environment", "-t", sessionId, "OPENRIG_NODE_ID"]);
  if (!node.startsWith("OPENRIG_NODE_ID=")) throw new Error("Seat node identity is unknown.");
  return { sessionId, nodeId: node.slice("OPENRIG_NODE_ID=".length) };
}
function body(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || parsed.error) throw new Error("Herdr returned an error or malformed reply.");
  return parsed.result && typeof parsed.result === "object" ? parsed.result as Record<string, unknown> : parsed;
}
function pane(raw: unknown): Pane | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return ["workspace_id", "pane_id", "terminal_id"].every(k => typeof p[k] === "string" && p[k] !== "") ? p as unknown as Pane : null;
}

export function sameHerdrPath(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !left) return false;
  if (left === right) return true;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

/** Complete endpoint-wide attribution; mutable labels are never ownership. */
export async function findAttributedViewerPanes(run: HerdrViewerRun, cwd: string, known?: ViewerPane): Promise<Pane[]> {
  // 0.9.5 emits JSON by default here; unlike status server, list rejects --json.
  const listed = body(await run(["workspace", "list"]));
  if (!Array.isArray(listed.workspaces)) throw new Error("Viewer enumeration is unreadable.");
  const found: Pane[] = [];
  for (const workspace of listed.workspaces as Array<Record<string, unknown>>) {
    if (!workspace || typeof workspace.workspace_id !== "string" || !workspace.workspace_id) throw new Error("Viewer workspace enumeration is incomplete.");
    const listedPanes = body(await run(["pane", "list", "--workspace", workspace.workspace_id]));
    if (!Array.isArray(listedPanes.panes)) throw new Error("Viewer pane enumeration is unreadable.");
    for (const raw of listedPanes.panes) {
      const candidate = pane(raw);
      if (!candidate || candidate.workspace_id !== workspace.workspace_id) throw new Error("Viewer pane enumeration is incomplete.");
      if (sameHerdrPath(candidate.cwd, cwd) || (known && candidate.workspace_id === known.workspace_id
        && candidate.pane_id === known.pane_id && candidate.terminal_id === known.terminal_id)) found.push(candidate);
    }
  }
  return found;
}

function ownedViewerDirectory(entry: Entry, root: string, endpoint: string): string {
  if (!/^openrig-viewer-[0-9a-f-]{36}$/.test(entry.label)
    || entry.cwd !== path.join(root, endpoint, entry.label.slice("openrig-viewer-".length))) {
    throw new Error("Viewer provenance has no owned attribution directory.");
  }
  return entry.cwd;
}
function prepareViewerCommand(entry: Entry, root: string, endpoint: string): string {
  const file = path.join(ownedViewerDirectory(entry, root, endpoint), "attach.sh");
  const source = `exec ${entry.command}\n`;
  const hash = createHash("sha256").update(source).digest("hex");
  try { writeFileSync(file, source, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(file).isFile()
      || lstatSync(file).isSymbolicLink() || createHash("sha256").update(readFileSync(file)).digest("hex") !== hash) throw error;
  }
  entry.scriptHash = hash;
  // Keep terminal input short even while the login shell uses canonical mode.
  return `/bin/sh '${file.replace(/'/g, `'"'"'`)}'`;
}
function retireViewerDirectory(entry: Entry, root: string, endpoint: string): void {
  const cwd = ownedViewerDirectory(entry, root, endpoint), file = path.join(cwd, "attach.sh");
  if (entry.scriptHash) {
    try {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()
        || createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.scriptHash) {
        throw new Error("The owned viewer script changed; it was preserved.");
      }
      unlinkSync(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try { rmdirSync(cwd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** One owned viewer per seat/endpoint. The journal is presentation provenance,
 * not task membership. It is written BEFORE each possible effect so neither a
 * lost reply nor a daemon restart authorizes a second create/run. Labels alone
 * never establish ownership: a received create reply binds the returned IDs;
 * lost replies require unique private-cwd recovery. The foreground attach
 * argv and current seat binding are always confirmed before reuse.
 */
export class HerdrViewer {
  private pending = Promise.resolve();
  constructor(private readonly socketPath: string, private readonly run: HerdrViewerRun,
    private readonly platform = process.platform, private readonly root = getDefaultOpenRigPath("private/terminal-viewers"),
    private readonly inspect: InspectViewerSeat = inspectSeat) {}

  ensure(key: ViewerKey, target: ComposedPane, stillCurrent: () => Promise<boolean> = async () => true, createPane?: CreateViewerPane): Promise<ViewerResult> {
    // ponytail: one endpoint queue; per-seat locks if creation throughput needs it.
    const result = this.pending.then(() => this.ensureOnce(key, target, true, stillCurrent, createPane));
    this.pending = result.then(() => {}, () => {});
    return result;
  }
  lookup(key: ViewerKey, target: ComposedPane): Promise<ViewerResult> {
    const result = this.pending.then(() => this.ensureOnce(key, target, false));
    this.pending = result.then(() => {}, () => {}); return result;
  }
  private async ownedPanes(entry: Entry): Promise<Pane[]> {
    return findAttributedViewerPanes(this.run, entry.cwd, entry.pane);
  }
  private async ensureOnce(key: ViewerKey, target: ComposedPane, provision = true, stillCurrent: () => Promise<boolean> = async () => true, createPane?: CreateViewerPane): Promise<ViewerResult> {
    let entry: Entry | undefined;
    const unconfirmed = (error: string): ViewerResult => ({ ok: false, code: "viewer_unconfirmed", error, ...(entry ? { phase: entry.phase } : {}) });
    try {
      if (this.platform !== "linux" && this.platform !== "darwin") return { ok: false, code: "viewer_unsupported", error: "Ensure-viewer supports Linux and macOS with Herdr protocol 22." };
      const status = body(await this.run(["status", "server", "--json"]));
      if (status.protocol !== 22 || status.running !== true || !sameHerdrPath(status.socket, this.socketPath)) {
        return unconfirmed("Herdr protocol 22 and the selected socket must be confirmed; pane and process replies are checked separately.");
      }
      if (provision && !await stillCurrent()) return unconfirmed("Task membership changed while waiting to provision; refresh its preview.");
      if (!target.attachArgv) return unconfirmed("Only verified local tmux bindings support ensure-viewer.");
      const binding = await this.inspect(target.attachArgv);
      if (binding.nodeId !== key.nodeId) return unconfirmed("The current tmux binding does not match this member’s node identity.");
      if (provision) mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const endpoint = createHash("sha256").update(this.socketPath).digest("hex");
      const file = path.join(this.root, `${endpoint}.json`);
      let journal: Journal;
      try { journal = JSON.parse(readFileSync(file, "utf8")) as Journal; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        journal = { version: 1, entries: {} };
      }
      if (journal.version !== 1 || !journal.entries || typeof journal.entries !== "object" || Array.isArray(journal.entries)) return unconfirmed("Viewer provenance is unreadable; no provider mutation was attempted.");
      const save = () => {
        const tmp = `${file}.${randomUUID()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(journal)}\n`, { mode: 0o600 }); renameSync(tmp, file);
      };
      const id = JSON.stringify([key.hostId, key.nodeId]);
      entry = journal.entries[id];
      let created = false;
      let reopen = false;
      let earlier = false;
      // Updating provenance alone cannot replace a live client. Keep old observers unchanged; a writable
      // legacy viewer is reopened explicitly, preserving the source agent and avoiding unowned client changes.
      if (entry && entry.command !== target.paneCommand && entry.readOnly === target.readOnly && Array.isArray(entry.argv)
        && entry.command === entry.argv.map(shellQuote).join(" ")
        && earlierTileAttachment(entry.argv, target.attachArgv, target.readOnly)) {
        earlier = true;
        reopen = !entry.readOnly;
      }
      if (entry && !earlier && (entry.command !== target.paneCommand || entry.readOnly !== target.readOnly)) {
        return unconfirmed("The seat attachment changed; the existing viewer must be inspected before reprovisioning.");
      }
      if (!entry) {
        if (!provision) return { ok: false, code: "viewer_not_provisioned", error: "No owned viewer has been provisioned for this member." };
        if (Object.keys(journal.entries).length >= 256) return unconfirmed("This endpoint has 256 retained viewer records; inspect its viewer provenance before adding more.");
        const token = randomUUID();
        const cwd = path.join(this.root, endpoint, token); mkdirSync(cwd, { recursive: true, mode: 0o700 });
        entry = { cwd, label: `openrig-viewer-${token}`, command: target.paneCommand, argv: target.attachArgv, readOnly: target.readOnly, phase: "creating" };
        journal.entries[id] = entry; save();
        // No retry here. A timeout is reconciled by enumeration on the next request.
        let raw: string;
        try {
          raw = await (createPane ? createPane(cwd, entry.label)
            : this.run(["workspace", "create", "--cwd", cwd, "--label", entry.label, "--no-focus"]));
        } catch (error) {
          if (createPane && error instanceof ViewerCreateNotDispatchedError) {
            // This invocation positively refused BEFORE dispatch, not an empty
            // enumeration or a timeout after a possible provider effect.
            delete journal.entries[id]; save();
            try { rmdirSync(cwd); } catch { /* An unused directory must not prevent a later join. */ }
            return unconfirmed(error.message);
          }
          throw error;
        }
        const reply = body(raw);
        const made = pane(reply.root_pane);
        if (!made) return unconfirmed("Create returned no pane/terminal identity; its effect remains uncertain.");
        // These IDs came from this creation call. Its cwd may already reflect an rc cd.
        entry.pane = made; entry.phase = "created"; save(); created = true;
      }
      if (!entry.pane) {
        // A unique private cwd attributes a previously initiated create, not a
        // caller ID or mutable display label. Empty/unreadable is still unknown.
        const found = await this.ownedPanes(entry);
        if (found.length !== 1) return unconfirmed("Uncertain viewer creation has no unique private-cwd mapping.");
        entry.pane = found[0]!; entry.phase = "created"; if (provision) save();
      }
      let current: Pane | null;
      try { current = pane(body(await this.run(["pane", "get", entry.pane.pane_id])).pane); }
      catch { current = null; } // A missing ID alone never proves absence.
      // pane get reports the shell's live cwd; the recorded IDs survive an rc's cd.
      if (!current || current.pane_id !== entry.pane.pane_id || current.terminal_id !== entry.pane.terminal_id
        || current.workspace_id !== entry.pane.workspace_id) {
        if (!provision || (await this.ownedPanes(entry)).length !== 0) {
          return unconfirmed("Viewer identity changed or disappeared; an enumerable viewer cannot be replaced.");
        }
        // Only complete empty readback retires provenance. Remove the exact owned
        // script and directory; never provider panes or arbitrary journal paths.
        retireViewerDirectory(entry, this.root, endpoint);
        delete journal.entries[id]; save();
        return { ok: false, code: "viewer_not_provisioned", error: "The old viewer is confirmed absent; ensure again to create a verified replacement." };
      }
      if (reopen) return unconfirmed(`Close only the owned Herdr viewer pane ${current.pane_id}, then reopen this view with rig terminal open. The agent's tmux session is preserved; its old client cannot be migrated by changing saved argv alone.`);
      if (entry.phase === "created") {
        if (!provision) return unconfirmed("The created viewer process is not yet confirmed.");
        if (!await stillCurrent()) return unconfirmed("Task membership changed before the viewer process started.");
        const beforeRun = await this.inspect(target.attachArgv);
        if (beforeRun.nodeId !== key.nodeId || beforeRun.sessionId !== binding.sessionId) return unconfirmed("The seat binding changed before the viewer process started.");
        const command = prepareViewerCommand(entry, this.root, endpoint);
        entry.phase = "starting"; save();
        // pane run rc0/empty stdout is not proof. It is sent ONCE then checked.
        await this.run(["pane", "run", current.pane_id, command]);
      }
      const process = body(await this.run(["pane", "process-info", "--pane", current.pane_id]));
      const info = process.process_info as { foreground_processes?: Array<{ argv?: unknown }> } | undefined;
      // The tile's own script (attach.sh execs it) carries the exact server/session argv, and stays in the foreground
      // while it views the seat and while it attaches. Kept tiles from earlier releases may show only their foreground
      // tmux client, with the same exact argv. No mutable title/agent label.
      const argv = entry.argv;
      const server = argv.slice(6); // tileAttachArgv: sh,-c,script,name,session,tmux,...server
      // Recognize legacy ignore-size writable clients as well as sizing attaches.
      const flags = entry.readOnly ? [["-r"]] : [["-f", "ignore-size"], []];
      const targetName = argv[4]!;
      const verified = info?.foreground_processes?.some(p => {
        const actual = p.argv;
        if (Array.isArray(actual) && actual.length === argv.length && argv.every((word, index) => actual[index] === word)) return true;
        return Array.isArray(actual) && flags.some(flag => {
          const expected = [argv[5]!, ...server, "attach", ...flag, "-t"];
          return expected.every((word, index) => actual[index] === word)
            && actual.length === expected.length + 1
            && (actual[expected.length] === `=${targetName}` || actual[expected.length] === binding.sessionId);
        });
      });
      const afterBinding = await this.inspect(target.attachArgv);
      if (afterBinding.nodeId !== key.nodeId || afterBinding.sessionId !== binding.sessionId) return unconfirmed("The seat binding changed while provisioning its viewer.");
      if (!verified) return unconfirmed("The viewer process is not confirmed; no pane run was repeated.");
      return { ok: true, viewer: { workspaceId: current.workspace_id, paneId: current.pane_id, terminalId: current.terminal_id, readOnly: entry.readOnly }, created };
    } catch (error) {
      return unconfirmed(`Viewer effect is unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A follow view may forget a tile it closed only after endpoint-wide
   * enumeration proves its attributed pane is absent. Never closes a pane. */
  forgetClosed(key: ViewerKey, expected: ViewerMapping): Promise<boolean> {
    const result = this.pending.then(async () => {
      try {
        const status = body(await this.run(["status", "server", "--json"]));
        if ((this.platform !== "linux" && this.platform !== "darwin") || status.protocol !== 22
          || status.running !== true || !sameHerdrPath(status.socket, this.socketPath)) return false;
        const endpoint = createHash("sha256").update(this.socketPath).digest("hex");
        const file = path.join(this.root, `${endpoint}.json`);
        const journal = JSON.parse(readFileSync(file, "utf8")) as Journal;
        if (journal.version !== 1 || !journal.entries || typeof journal.entries !== "object" || Array.isArray(journal.entries)) return false;
        const id = JSON.stringify([key.hostId, key.nodeId]);
        const entry = journal.entries[id];
        if (!entry?.pane || entry.pane.pane_id !== expected.paneId || entry.pane.terminal_id !== expected.terminalId
          || entry.pane.workspace_id !== expected.workspaceId || !/^openrig-viewer-[0-9a-f-]{36}$/.test(entry.label)
          || entry.cwd !== path.join(this.root, endpoint, entry.label.slice("openrig-viewer-".length))) return false;
        if ((await this.ownedPanes(entry)).length !== 0) return false;
        retireViewerDirectory(entry, this.root, endpoint);
        delete journal.entries[id];
        const temporary = `${file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(journal) + "\n", { mode: 0o600 }); renameSync(temporary, file);
        return true;
      } catch { return false; }
    });
    this.pending = result.then(() => {}, () => {});
    return result;
  }
}

export { body as readHerdrViewerBody, pane as parseHerdrViewerPane, inspectSeat as inspectViewerSeat };
