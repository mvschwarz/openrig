// What OpenRig keeps for one herdr-app client (one app home): its journal of views and viewers, and the Rig layout
// file it owns there: the journal is written first, and a viewer is verified before it is closed.
//
// - The journal lives in OpenRig's private folder, one file per app home, written atomically. A viewer is journalled
//   BEFORE it is started, with its op nonce, so an uncertain start can be found again by its labels.
// - `layouts/rig.json` is OpenRig's only while OpenRig wrote it: it is replaced only when it is absent, byte-identical
//   to OpenRig's last write, or still carries OpenRig's last revision (herdr itself rewrites the file after some
//   changes). Anything else is the person's, and OpenRig refuses rather than overwrite it.
// - The app's acknowledgement (<app home>/openrig/ack.json, written by the rig-strip mod) is accepted only for the
//   exact revision OpenRig wrote, and only when it lists none of the terminals being removed.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RIG_LAYOUT, RIG_STACK, type LayoutNode } from "./herdr-app-layout.js";

export interface ViewerRecord {
  cellId: string;
  seat: string;
  label: string;
  runtime?: string;
  /** Op nonce: in the viewer's `openrig.op` label and its argv. */
  nonce: string;
  /** The exact argv the viewer was started with (verified before it is ever ended). */
  argv: string[];
  /** As the view composed the pane: a read-only tile only shows its seat; an interactive one takes typed keys. */
  readOnly: boolean;
  /** Interactive local viewers only. pending: the app hasn't shown it yet, so it takes no input; open: its gate file is
   *  written, and its writable tile runs. */
  gate?: "pending" | "open";
  /** While pending: until when (ISO, wall clock) OpenRig keeps waiting for the app to show it, across a daemon restart. */
  gateUntil?: string;
  /** Local seats run the view's own tile for the seat (openrig-tile); remote seats run their own ssh command. */
  attach: "local" | "remote";
  terminal: string | null;
  /** planned: journalled, not confirmed started; start-unknown: hc run outcome unknown; live: its terminal is known; ended: written as an ended cell. */
  state: "planned" | "start-unknown" | "live" | "ended";
}

export interface ViewRecord {
  id: string;
  name: string;
  /** The OpenRig view argument and page this was opened for. */
  source: { view: string; page: number };
  createdAt: string;
  columns?: number;
  viewers: ViewerRecord[];
}

/** A viewer whose cell is gone from the file (or whose start was uncertain) waiting to be verified and ended. */
export interface PendingEnd {
  terminal: string | null;
  seat?: string;
  cellId: string;
  nonce: string;
  argv: string[];
  revision: string;
  since: string;
}

export interface ClientState {
  appHome: string;
  /** The person's layout the Rig layout is derived from. */
  base: string | null;
  views: ViewRecord[];
  revision: string | null;
  /** sha256 of OpenRig's last rig.json write. */
  writtenSha: string | null;
  pendingEnds: PendingEnd[];
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const newNonce = () => randomBytes(4).toString("hex");

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${newNonce()}.tmp`);
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

async function readText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

export class HerdrAppClientFiles {
  constructor(readonly appHome: string, private readonly journalDir: string) {}

  get journalPath(): string { return path.join(this.journalDir, `${sha256(path.resolve(this.appHome)).slice(0, 16)}.json`); }
  get rigPath(): string { return path.join(this.appHome, "layouts", `${RIG_LAYOUT}.json`); }
  get ackPath(): string { return path.join(this.appHome, "openrig", "ack.json"); }
  layoutPath(name: string): string { return path.join(this.appHome, "layouts", `${name}.json`); }

  async load(): Promise<ClientState> {
    const text = await readText(this.journalPath);
    const empty: ClientState = { appHome: path.resolve(this.appHome), base: null, views: [], revision: null, writtenSha: null, pendingEnds: [] };
    if (!text) return empty;
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${this.journalPath} is not a journal object; OpenRig did not use or overwrite it.`);
    }
    const parsed = raw as Partial<ClientState>;
    const now = new Date().toISOString();
    const views = (parsed.views ?? []).map((v) => ({
      ...v,
      viewers: (v.viewers ?? []).map((viewer) => ({
        ...viewer,
        attach: viewer.attach ?? (Array.isArray(viewer.argv) && viewer.argv.includes("openrig-tile") ? "local" as const : "remote" as const),
      })),
    }));
    const pendingEnds = (parsed.pendingEnds ?? []).map((p) => ({ ...p, since: p.since ?? now }));
    return { ...empty, ...parsed, views, pendingEnds };
  }

  async save(state: ClientState): Promise<void> {
    await writeAtomic(this.journalPath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async readLayout(name: string): Promise<LayoutNode | null> {
    const text = await readText(this.layoutPath(name));
    if (text === null) return null;
    try {
      const tree: unknown = JSON.parse(text);
      return tree && typeof tree === "object" && !Array.isArray(tree) ? tree as LayoutNode : null;
    } catch {
      return null;
    }
  }

  /** Whose `layouts/rig.json` is it? */
  async rigOwnership(state: Pick<ClientState, "writtenSha" | "revision">): Promise<{ ours: true } | { ours: false; reason: string }> {
    const text = await readText(this.rigPath);
    if (text === null || (state.writtenSha !== null && sha256(text) === state.writtenSha)) return { ours: true };
    try {
      const tree = JSON.parse(text) as LayoutNode;
      const stack = findNode(tree, RIG_STACK) as { header?: { content?: { mod?: string; props?: { revision?: unknown } } } } | null;
      // herdr rewrites the shown layout after some changes (a block removed, a mod docked): still OpenRig's write.
      if (state.revision !== null && stack?.header?.content?.mod === "rig-strip" && stack.header.content.props?.revision === state.revision) return { ours: true };
    } catch { /* unreadable: not provably ours */ }
    return { ours: false, reason: `${this.rigPath} exists and was not written by this OpenRig. Rename or remove it to let OpenRig own the Rig layout; OpenRig won't overwrite it.` };
  }

  /** Atomic write of the Rig layout (temp + rename; never `layout.set`). Returns the written text's sha. */
  async writeRig(tree: LayoutNode): Promise<string> {
    const text = `${JSON.stringify(tree, null, 1)}\n`;
    await writeAtomic(this.rigPath, text);
    return sha256(text);
  }

  async readAck(): Promise<{ revision: string; terminals: string[] } | null> {
    try {
      const parsed = JSON.parse((await readText(this.ackPath)) ?? "null") as { revision?: unknown; terminals?: unknown } | null;
      if (!parsed || typeof parsed.revision !== "string" || !Array.isArray(parsed.terminals)) return null;
      return { revision: parsed.revision, terminals: parsed.terminals.filter((t): t is string => typeof t === "string") };
    } catch {
      return null;
    }
  }
}

export function findNode(node: unknown, id: string): LayoutNode | null {
  if (!node || typeof node !== "object") return null;
  const n = node as LayoutNode;
  if (n.id === id) return n;
  for (const child of n.children ?? []) { const hit = findNode(child, id); if (hit) return hit; }
  return null;
}

/** Wait until the app acknowledges `revision` with none of `removed` still shown. False when it doesn't in time. */
export async function awaitApplied(files: Pick<HerdrAppClientFiles, "readAck">, revision: string, removed: readonly string[],
  opts: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const ack = await files.readAck();
    if (ack && ack.revision === revision && !removed.some((t) => ack.terminals.includes(t))) return true;
    if (now() >= deadline) return false;
    await sleep(opts.pollMs ?? 100);
  }
}
