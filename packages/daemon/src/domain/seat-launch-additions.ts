import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { SEAT_SKILL_PLUGIN_NAME, ensureSeatSkillPlugin, insideSeatStorage, insideSeatStorageFolder, recordSeatSkillWrite, seatSkillName, seatSkillPaths, writeInsideSeatStorage, type SeatSkillPaths } from "./seat-skill-storage.js";
import { claudePathBounds } from "./native-process-lineage.js";
import { seatAdditionPluginFolder } from "./rigspec-schema.js";

// OPR.0.7.0.9 — a Claude seat's own launch additions: an agent, an appended system prompt file and plugin folders.
// Their files are copied into the seat's own storage (slice 13's seat root), never into the shared project, and a
// launch passes the copies: the plugin folders through CLAUDE_CODE_PLUGIN_DIRS beside the seat's generated plugin,
// the agent and the prompt file as `--agent` and `--append-system-prompt-file`. A manifest at the seat root records
// what was asked for, each copy's source and bytes, and the prompt each conversation started with.

/** What a seat asked for: source files, resolved to absolute paths by whoever reads the spec. */
export interface SeatLaunchAdditionsInput {
  agentFile?: string;
  appendSystemPromptFile?: string;
  pluginDirs?: string[];
}

/** What a launch passes: the seat-local copies. */
export interface SeatLaunchAdditions {
  /** `openrig:<name>`, the agent copied into the seat's generated plugin. */
  agent?: string;
  appendSystemPromptFile?: string;
  pluginDirs: string[];
}

export type SeatLaunchAdditionsPrepared =
  | { ok: true; additions: SeatLaunchAdditions; /** An addition left out, named (the agent without its namespace). */ notes?: string[] }
  | { ok: false; code: "addition_missing" | "addition_invalid" | "seat_storage_refused"; message: string };

// Each copy is recorded through slice 13's seat record (`recordSeatSkillWrite`), so its restore and cleanup route
// covers these files too. This manifest holds only what was asked for and each conversation's starting prompt.
interface Manifest {
  additions: SeatLaunchAdditions;
  /** The prompt file's sha256 when each conversation started. */
  conversations?: Record<string, string>;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const manifestPath = (paths: SeatSkillPaths): string => nodePath.join(paths.root, "launch-additions.json");
const additionsRoot = (paths: SeatSkillPaths): string => nodePath.join(paths.root, "additions");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

/** Only a record in the shape OpenRig writes is read; a hand edit or another version's shape isn't (see manifestUnreadable). */
function readManifest(paths: SeatSkillPaths): Manifest | undefined {
  const file = manifestPath(paths);
  if (!insideSeatStorage(paths.root, file)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
  const additions = isRecord(parsed) ? parsed["additions"] : undefined;
  const shaped = isRecord(parsed) && isRecord(additions) && Array.isArray(additions["pluginDirs"])
    && additions["pluginDirs"].every((dir) => typeof dir === "string")
    && optionalString(additions["agent"]) && optionalString(additions["appendSystemPromptFile"])
    && (parsed["conversations"] === undefined || isRecord(parsed["conversations"]));
  return shaped ? parsed as unknown as Manifest : undefined;
}

/** A record in the seat's storage that can't be read as one OpenRig wrote: named rather than silently absent. */
function manifestUnreadable(paths: SeatSkillPaths): boolean {
  const file = manifestPath(paths);
  return insideSeatStorage(paths.root, file) && fs.existsSync(file) && !readManifest(paths);
}

function writeManifest(paths: SeatSkillPaths, manifest: Manifest): void {
  writeInsideSeatStorage(paths.root, manifestPath(paths), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every file under a folder, relative to it (links aren't followed out of it). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = rel ? nodePath.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(nodePath.join(current, entry.name), relative);
      else if (entry.isFile()) out.push(relative);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** The name Claude knows an agent file by: its frontmatter `name` (as written, so a bad one is refused, not
 *  replaced), else its file name. */
function agentName(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8");
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = front?.[1]?.match(/^name:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (name) return name;
  } catch { /* the file name below */ }
  return nodePath.basename(file).replace(/\.md$/, "");
}


/**
 * Copy what a seat asked for into its own storage and record it. Every source is checked first, so a missing one is a
 * named error with nothing written; storage a link refuses gets nothing. A seat that asks for nothing gets nothing,
 * and an earlier request's record is removed (its copies stay as files OpenRig wrote, for cleanup to remove).
 */
export function prepareSeatLaunchAdditions(paths: SeatSkillPaths, input: SeatLaunchAdditionsInput): SeatLaunchAdditionsPrepared {
  const pluginSources = input.pluginDirs ?? [];
  if (!input.agentFile && !input.appendSystemPromptFile && pluginSources.length === 0) {
    const file = manifestPath(paths);
    try {
      if (insideSeatStorage(paths.root, file) && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      return { ok: false, code: "seat_storage_refused", message: `seat_storage_refused: the seat's earlier launch additions record ${file} couldn't be removed (${(error as Error).message}), so this launch would still deliver them` };
    }
    return { ok: true, additions: { pluginDirs: [] } };
  }
  for (const [what, source, kind] of [
    ["the appended system prompt file", input.appendSystemPromptFile, "file"],
    ["the agent file", input.agentFile, "file"],
    ...pluginSources.map((dir) => ["a plugin folder", dir, "folder"] as const),
  ] as const) {
    if (source === undefined) continue;
    let ok = false;
    try { const stat = fs.statSync(source); ok = kind === "file" ? stat.isFile() : stat.isDirectory(); } catch { /* missing */ }
    if (!ok) return { ok: false, code: "addition_missing", message: `addition_missing: ${what} ${source} is not a readable ${kind}; nothing was written` };
  }

  // `--agent` takes the name Claude registers: one plain token, so identity proof can read it back from `ps`.
  const agent = input.agentFile ? agentName(input.agentFile) : undefined;
  if (agent !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) {
    return { ok: false, code: "addition_invalid", message: `addition_invalid: the agent in ${input.agentFile} is named "${agent}"; a seat's agent needs a plain name (letters, digits, . _ -); nothing was written` };
  }

  // A copied plugin named like the seat's own generated plugin would collide with it (same-name behaviour isn't documented).
  for (const dir of pluginSources) {
    let name: unknown;
    try { name = (JSON.parse(fs.readFileSync(nodePath.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown }).name; } catch { /* no manifest */ }
    if (name === SEAT_SKILL_PLUGIN_NAME) {
      return { ok: false, code: "addition_invalid", message: `addition_invalid: the plugin in ${dir} is named "${SEAT_SKILL_PLUGIN_NAME}", the seat's own generated plugin; rename it; nothing was written` };
    }
  }

  // Each plugin folder gets its own destination; two that would land in one (the same basename, names that sanitize
  // to one, or a folder named like the seat's plugin) would mix their files, so they're refused, named.
  const pluginDests = pluginSources.map(seatAdditionPluginFolder);
  const clash = pluginDests.find((name, i) => name === SEAT_SKILL_PLUGIN_NAME || pluginDests.indexOf(name) !== i);
  if (clash !== undefined) {
    const which = pluginSources.filter((_dir, i) => pluginDests[i] === clash);
    return { ok: false, code: "addition_invalid", message: clash === SEAT_SKILL_PLUGIN_NAME && which.length === 1
      ? `addition_invalid: the plugin folder ${which[0]} would be copied to the same destination as the seat's own generated plugin ("${SEAT_SKILL_PLUGIN_NAME}"); rename it; nothing was written`
      : `addition_invalid: the plugin folders ${which.join(", ")} would be copied to the same destination (additions/plugins/${clash}) and mix their files; rename one; nothing was written` };
  }

  const additions: SeatLaunchAdditions = { pluginDirs: [] };
  if (input.appendSystemPromptFile) {
    additions.appendSystemPromptFile = nodePath.join(additionsRoot(paths), "system-prompt.md");
    // The launch-time check, before any write: identity proof must be able to read this path back from `ps`.
    if (!claudePathBounds(additions.appendSystemPromptFile)) {
      return { ok: false, code: "addition_invalid", message: `addition_invalid: ${additions.appendSystemPromptFile} ${UNBOUNDED_PATH}; nothing was written` };
    }
  }
  const agentDest = agent ? nodePath.join(paths.pluginDir, "agents", `${agent}.md`) : undefined;
  const pluginDirDests = pluginDests.map((name) => nodePath.join(additionsRoot(paths), "plugins", name));
  const plannedFiles = [manifestPath(paths), additions.appendSystemPromptFile, agentDest].filter((dest): dest is string => !!dest);
  const refused = plannedFiles.find((file) => !insideSeatStorage(paths.root, file))
    ?? pluginDirDests.find((dir) => !insideSeatStorageFolder(paths.root, dir));
  if (refused) {
    return { ok: false, code: "seat_storage_refused", message: `seat_storage_refused: ${refused} is not inside this seat's storage (a link on the way); the seat's launch additions are not written` };
  }

  // Everything that writes, or reads a folder to plan its copies, is inside this boundary: a failure is a named result.
  const notes: string[] = [];
  const written: string[] = [];
  try {
    const copies: Array<{ source: string; dest: string }> = [];
    if (input.appendSystemPromptFile && additions.appendSystemPromptFile) copies.push({ source: input.appendSystemPromptFile, dest: additions.appendSystemPromptFile });
    if (input.agentFile && agent && agentDest) {
      // The agent is registered as `openrig:<name>` only through the seat's generated plugin. Without that namespace
      // (a linked manifest, or one an operator renamed) the agent isn't delivered; the operator's file is kept.
      ensureSeatSkillPlugin(paths);
      const namespace = seatPluginNamespaceRefusal(paths);
      if (namespace) notes.push(`seat_launch_addition_refused: the agent "${agent}" needs the seat's generated plugin, named "${SEAT_SKILL_PLUGIN_NAME}"; ${namespace}; the agent isn't delivered`);
      else {
        additions.agent = seatSkillName(agent);
        copies.push({ source: input.agentFile, dest: agentDest });
      }
    }
    for (const [i, dir] of pluginSources.entries()) {
      additions.pluginDirs.push(pluginDirDests[i]!);
      for (const file of filesUnder(dir)) copies.push({ source: nodePath.join(dir, file), dest: nodePath.join(pluginDirDests[i]!, file) });
    }
    const unbounded = copies.find((copy) => !insideSeatStorage(paths.root, copy.dest));
    if (unbounded) throw new Error(`${unbounded.dest} is not inside this seat's storage (a link on the way)`);
    const previous = readManifest(paths);
    for (const { source, dest } of copies) {
      const bytes = fs.readFileSync(source);
      writeInsideSeatStorage(paths.root, dest, bytes, fs.statSync(source).mode & 0o777);
      recordSeatSkillWrite(paths.skillsRoot, dest, source, bytes);
      written.push(dest);
    }
    writeManifest(paths, { additions, ...(previous?.conversations ? { conversations: previous.conversations } : {}) });
  } catch (error) {
    // A link that appeared after the check above, or another failure, is a named result, never a throw. Copies written
    // before it are said: they're recorded as OpenRig's (cleanup and restore know them), but the earlier request stays.
    const partial = written.length > 0 ? `; ${written.length} cop${written.length === 1 ? "y was" : "ies were"} written and recorded before the failure, and the seat's earlier request stays in force` : "";
    return { ok: false, code: "seat_storage_refused", message: `seat_storage_refused: ${(error as Error).message}; the seat's launch additions are not delivered${partial}` };
  }
  return { ok: true, additions, ...(notes.length > 0 ? { notes } : {}) };
}

const UNBOUNDED_PATH = "can't be read back from ps as one value (a token that starts with -- or {, or doubled, leading, trailing or non-space whitespace), so identity proof couldn't bound it";

/** Why the seat's generated plugin can't register `openrig:<name>`, or undefined when it can: its manifest must be
 *  inside the seat's storage and named `openrig` (an operator's edit that keeps that name is fine). */
function seatPluginNamespaceRefusal(paths: SeatSkillPaths): string | undefined {
  if (!insideSeatStorage(paths.root, paths.pluginManifestPath)) return `${paths.pluginManifestPath} is not inside this seat's storage (a link on the way)`;
  let name: unknown;
  try { name = (JSON.parse(fs.readFileSync(paths.pluginManifestPath, "utf8")) as { name?: unknown }).name; } catch { /* unreadable */ }
  return name === SEAT_SKILL_PLUGIN_NAME ? undefined : `${paths.pluginManifestPath} names the plugin ${JSON.stringify(name ?? null)}`;
}

/** The additions a seat's launch passes, read from its storage; undefined when it has none. */
export function seatLaunchAdditions(paths: SeatSkillPaths): SeatLaunchAdditions | undefined {
  return readManifest(paths)?.additions;
}

export function seatLaunchAdditionPathsForNode(db: { prepare(sql: string): { get(...params: unknown[]): unknown } }, nodeId: string): SeatSkillPaths | undefined {
  try {
    const row = db.prepare("SELECT rig_id, logical_id, runtime FROM nodes WHERE id = ?").get(nodeId) as
      { rig_id: string; logical_id: string; runtime: string | null } | undefined;
    return row && row.runtime === "claude-code" ? seatSkillPaths({ rigId: row.rig_id, logicalId: row.logical_id, runtime: row.runtime }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a launch of this node passes: only the copies that are present in its storage. A missing one (gone, and a
 * restore couldn't put it back) is left off the launch and named, never passed as a path that doesn't resolve.
 */
export function seatLaunchAdditionsForLaunch(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  nodeId: string,
): { additions?: SeatLaunchAdditions; missing: string[]; refused: string[] } {
  const paths = seatLaunchAdditionPathsForNode(db, nodeId);
  return paths ? seatLaunchAdditionsAt(paths) : { missing: [], refused: [] };
}

/** What a seat's launch passes, as the plan and the seat view report it: null when it has no additions. */
export interface SeatLaunchAdditionsReport extends SeatLaunchAdditions {
  missing: string[];
  refused: string[];
  /** With an agent: whether its prompt is non-empty, which replaces Claude's default system prompt when it runs as the
   *  main agent (Claude's documented behaviour), so the person gets that agent's prompt instead. */
  agentPromptReplacesDefault?: boolean;
}
export function seatLaunchAdditionsReport(paths: SeatSkillPaths): SeatLaunchAdditionsReport | null {
  if (!readManifest(paths) && !manifestLinked(paths) && !manifestUnreadable(paths)) return null;
  const { additions, missing, refused } = seatLaunchAdditionsAt(paths);
  const report: SeatLaunchAdditionsReport = { ...(additions ?? { pluginDirs: [] }), missing, refused };
  if (additions?.agent) {
    const copy = nodePath.join(paths.pluginDir, "agents", `${additions.agent.slice(additions.agent.indexOf(":") + 1)}.md`);
    try { report.agentPromptReplacesDefault = fs.readFileSync(copy, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim().length > 0; } catch { /* unreadable: say nothing */ }
  }
  return report;
}

/** A seat's additions record that became a link: never read through it, and named rather than silently absent. */
function manifestLinked(paths: SeatSkillPaths): boolean {
  const file = manifestPath(paths);
  let exists = false;
  try { fs.lstatSync(file); exists = true; } catch { /* absent */ }
  return exists && !insideSeatStorage(paths.root, file);
}

function seatLaunchAdditionsAt(paths: SeatSkillPaths): { additions?: SeatLaunchAdditions; missing: string[]; refused: string[] } {
  if (manifestLinked(paths)) {
    return { missing: [], refused: [`${manifestPath(paths)} is not inside this seat's storage (a link on the way), so the seat's launch additions aren't read or delivered`] };
  }
  const manifest = readManifest(paths);
  if (!manifest) {
    return { missing: [], refused: manifestUnreadable(paths)
      ? [`${manifestPath(paths)} isn't a launch additions record OpenRig can read (not JSON, or not the shape it writes), so the seat's launch additions aren't read or delivered`] : [] };
  }
  const refused: string[] = [];
  const present = (file: string, kind: "file" | "folder") => {
    if (!(kind === "file" ? insideSeatStorage(paths.root, file) : insideSeatStorageFolder(paths.root, file))) return false;
    try { const stat = fs.statSync(file); return kind === "file" ? stat.isFile() : stat.isDirectory(); } catch { return false; }
  };
  const missing: string[] = [];
  const additions: SeatLaunchAdditions = { pluginDirs: [] };
  const prompt = manifest.additions.appendSystemPromptFile;
  // A limitation, named: `ps` keeps no argument boundaries. A path with ordinary spaces reads back (claudePathBounds);
  // one holding a token that opens with `--` or `{` can't, so it's left off the launch rather than passed ambiguously.
  if (prompt && !claudePathBounds(prompt)) refused.push(`${prompt} ${UNBOUNDED_PATH}`);
  else if (prompt) { if (present(prompt, "file")) additions.appendSystemPromptFile = prompt; else missing.push(prompt); }
  if (manifest.additions.agent) {
    const agentCopy = nodePath.join(paths.pluginDir, "agents", `${manifest.additions.agent.slice(manifest.additions.agent.indexOf(":") + 1)}.md`);
    // Registered as `openrig:<name>` only through the seat's generated plugin; without that namespace it isn't passed.
    const namespace = seatPluginNamespaceRefusal(paths);
    if (namespace) refused.push(`the agent ${manifest.additions.agent} needs the seat's generated plugin, named "${SEAT_SKILL_PLUGIN_NAME}"; ${namespace}`);
    else if (present(agentCopy, "file")) additions.agent = manifest.additions.agent;
    else missing.push(agentCopy);
  }
  for (const dir of manifest.additions.pluginDirs) { if (present(dir, "folder")) additions.pluginDirs.push(dir); else missing.push(dir); }
  const any = additions.agent || additions.appendSystemPromptFile || additions.pluginDirs.length > 0;
  return { ...(any ? { additions } : {}), missing, refused };
}

/** At a node's fresh launch or fork: record the prompt its conversation starts with. */
export function recordConversationPromptForNode(db: { prepare(sql: string): { get(...params: unknown[]): unknown } }, nodeId: string, conversation: string): void {
  const paths = seatLaunchAdditionPathsForNode(db, nodeId);
  if (paths) recordConversationPrompt(paths, conversation);
}

/** At a node's fork: the fork takes its parent's recorded starting prompt. */
export function recordForkConversationPromptForNode(db: { prepare(sql: string): { get(...params: unknown[]): unknown } }, nodeId: string, fork: string, parent: string): void {
  const paths = seatLaunchAdditionPathsForNode(db, nodeId);
  if (paths) recordForkConversationPrompt(paths, fork, parent);
}

/** At a node's resume: the pending note, when its prompt changed since the conversation started. */
export function systemPromptPendingNoteForNode(db: { prepare(sql: string): { get(...params: unknown[]): unknown } }, nodeId: string, conversation: string): string | undefined {
  const paths = seatLaunchAdditionPathsForNode(db, nodeId);
  return paths ? systemPromptPendingNote(paths, conversation) : undefined;
}

/** The additions for a node, from its record: what every Claude launch path asks. */
export function seatLaunchAdditionsForNode(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  nodeId: string,
): SeatLaunchAdditions | undefined {
  try {
    const row = db.prepare("SELECT rig_id, logical_id, runtime FROM nodes WHERE id = ?").get(nodeId) as
      { rig_id: string; logical_id: string; runtime: string | null } | undefined;
    if (!row || row.runtime !== "claude-code") return undefined;
    return seatLaunchAdditions(seatSkillPaths({ rigId: row.rig_id, logicalId: row.logical_id, runtime: row.runtime }));
  } catch {
    return undefined;
  }
}


function promptDigest(paths: SeatSkillPaths, manifest: Manifest): string | undefined {
  const file = manifest.additions.appendSystemPromptFile;
  if (!file || !insideSeatStorage(paths.root, file)) return undefined;
  try { return sha256(fs.readFileSync(file)); } catch { return undefined; }
}

/** At a fresh launch or a fork: the prompt this conversation starts with. */
export function recordConversationPrompt(paths: SeatSkillPaths, conversation: string): void {
  const manifest = readManifest(paths);
  if (!manifest) return;
  const digest = promptDigest(paths, manifest);
  if (!digest) return;
  writeManifest(paths, { ...manifest, conversations: { ...manifest.conversations, [conversation]: digest } });
}

/**
 * At a fork: a fork starts from its parent's conversation, so it takes the parent's recorded starting prompt; with
 * none recorded, the fork has none either (unknown), never today's file.
 */
export function recordForkConversationPrompt(paths: SeatSkillPaths, fork: string, parent: string): void {
  const manifest = readManifest(paths);
  if (!manifest) return;
  const conversations = { ...manifest.conversations };
  const inherited = conversations[parent];
  if (inherited) conversations[fork] = inherited; else delete conversations[fork];
  writeManifest(paths, { ...manifest, conversations });
}

/**
 * At a resume, keyed by the conversation being resumed (a historical restore reads its own start):
 * - no recorded start: unknown;
 * - the seat's prompt file differs from the one this conversation started with: pending. Claude (v2.1.265 or later,
 *   not bare mode) keeps the recorded prompt until compaction or a new conversation; earlier versions, and providers
 *   that rebuild every request, use the new text at once. OpenRig doesn't observe compaction here, so after one the
 *   new text may already be in use. Never reported as used.
 */
export function systemPromptPendingNote(paths: SeatSkillPaths, conversation: string): string | undefined {
  const manifest = readManifest(paths);
  if (!manifest) return undefined;
  const current = promptDigest(paths, manifest);
  if (!current) return undefined;
  const file = manifest.additions.appendSystemPromptFile;
  const started = manifest.conversations?.[conversation];
  if (!started) return `system_prompt_unknown: no record of the prompt this conversation started with; whether Claude uses ${file}'s current text is unknown`;
  if (started === current) return undefined;
  return `system_prompt_pending: ${file} changed since this conversation started; Claude (v2.1.265 or later, not bare mode) uses the new text after compaction or in a new conversation; earlier versions use it at once, as do sessions that don't fetch feature flags (Bedrock, Agent Platform, Foundry) before v2.1.268; OpenRig doesn't observe compaction here`;
}

/** What a fork's copy of its source seat's launch additions did: `kept` when the new seat holds a record for its launch to
 *  keep; `omitted` names what the source's own launch wouldn't pass, or the copy left out. */
export interface SeatLaunchAdditionsCarry {
  status: "carried" | "partial" | "not_carried";
  kept: boolean;
  omitted: string[];
}

/**
 * At a fork, into a new seat that converge has already validated: copy what the source seat's own launch would pass
 * (its copies, through the same containment checks), and its conversations' starting prompts, so the fork's start
 * reads its parent's. Undefined when the source seat has no additions record.
 */
export function carrySeatLaunchAdditions(source: SeatSkillPaths, target: SeatSkillPaths): SeatLaunchAdditionsCarry | undefined {
  // Every failure here is a named result: the new seat already exists, and its launch must still be reached.
  let read: ReturnType<typeof seatLaunchAdditionsAt>;
  try { read = seatLaunchAdditionsAt(source); } catch (error) {
    return { status: "not_carried", kept: false, omitted: [`the source seat's record ${manifestPath(source)} couldn't be read as launch additions (${(error as Error).message})`] };
  }
  const { additions, missing, refused } = read;
  const omitted = [...missing.map((file) => `${file} is missing`), ...refused];
  if (!additions) return omitted.length > 0 ? { status: "not_carried", kept: false, omitted } : undefined;
  const prepared = prepareSeatLaunchAdditions(target, {
    ...(additions.agent ? { agentFile: nodePath.join(source.pluginDir, "agents", `${additions.agent.slice(additions.agent.indexOf(":") + 1)}.md`) } : {}),
    ...(additions.appendSystemPromptFile ? { appendSystemPromptFile: additions.appendSystemPromptFile } : {}),
    pluginDirs: additions.pluginDirs,
  });
  if (!prepared.ok) return { status: "not_carried", kept: false, omitted: [...omitted, prepared.message] };
  omitted.push(...(prepared.notes ?? []));
  try {
    const conversations = readManifest(source)?.conversations;
    const manifest = readManifest(target);
    if (conversations && manifest) writeManifest(target, { ...manifest, conversations: { ...conversations, ...manifest.conversations } });
  } catch (error) {
    // The copies stay kept; without the record, a resume reads the fork's starting prompt as unknown.
    omitted.push(`the source's starting-prompt record wasn't written (${(error as Error).message}), so a resume reads the fork's starting prompt as unknown`);
  }
  const { agent, appendSystemPromptFile, pluginDirs } = prepared.additions;
  const any = agent || appendSystemPromptFile || pluginDirs.length > 0;
  return { status: !any ? "not_carried" : omitted.length > 0 ? "partial" : "carried", kept: true, omitted };
}

/** The argv a Claude launch passes for a seat's additions: none without them, so the command stays byte-identical.
 *  The prompt file is followed by OpenRig's identity options, which the identity parser relies on. */
export function seatLaunchAdditionArgs(additions: SeatLaunchAdditions | undefined): string[] {
  if (!additions) return [];
  return [
    ...(additions.agent ? ["--agent", additions.agent] : []),
    ...(additions.appendSystemPromptFile ? ["--append-system-prompt-file", additions.appendSystemPromptFile] : []),
  ];
}
