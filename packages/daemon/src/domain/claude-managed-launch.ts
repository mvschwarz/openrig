import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { RigEvent } from "./types.js";
import { publicSeatEnvironment } from "./seat-launch-environment.js";
import { SEAT_ENV_KEYS_VAR, parseStoredSeatEnv, validateSeatEnvName } from "./seat-env.js";
import { CLAUDE_PLUGIN_DIRS_ENV, SEAT_NODE_ENV, SEAT_PROJECT_DIR_ENV, seatCorePluginDir } from "./claude-core-plugin-env.js";
import { seatSkillPluginDirForNode } from "./seat-skill-storage.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { claudeClassicRendererEnvPrefix } from "../adapters/yolo-mode.js";
import { parseClaudePermissionModes } from "./permission-drift.js";
import { validateNativePermissionSelection } from "./native-permission-selection.js";
import { seatLaunchAdditionsForLaunch } from "./seat-launch-additions.js";
import { NO_SESSION_BUS } from "./seat-runtime-dir.js";
import { effectiveRuntimeHome } from "./seat-runtime-home.js";
import { claudeSeatTokenFallbackNotice, claudeSeatTokenFileProblem, claudeSeatTokenStep, readClaudeSeatTokenRef, type ClaudeSeatTokenRef } from "./claude-seat-token.js";
import { OUTRANKING_TOKEN_ENV, projectRootForLocalSettings, settingsFileConflicts, type CredentialConflict, type CredentialPrecedence } from "./claude-credential-precedence.js";

export interface ClaudeLaunchTarget {
  nodeId: string;
  cwd?: string;
  session?: string;
  pane?: string | null;
  /** A successor may have a reserved generation before its tenure is committed. */
  generation?: string;
  /** Slice 16: a Claude successor staged beside the seat's current occupant on another runtime (from #1214 by
   *  Aschenbath). The seat still records that occupant until the switch commits; it must still be bound exactly. */
  runtimeSwitch?: { fromRuntime: string; session: string; pane: string; generation: string };
}

interface TargetSnapshot {
  nodeId: string; runtime: string; cwd: string | null; bindingId: string | null;
  session: string | null; pane: string | null; generation: string | null;
}

/** The kernel runs a file as a script only when its first two bytes are `#!`. A managed launch's frozen executable is
 *  then not the process that ends up running, so its path can't prove the launched Claude. Nothing past those two bytes
 *  is read; an unreadable, empty or one-byte file is not a script. */
export function fileStartsWithShebang(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x23 && head[1] === 0x21;
  } catch { return false; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to release */ } }
}

/** Dynamic choices use the managed launch environment, not an interactive shell's
 * aliases or startup files. No cache and no persisted environment/credentials.
 * The help child has only the capability environment. Launch adds the existing
 * managed identity/auth channel by variable NAME, never secret values in text.
 */
const MANAGED_LAUNCH_KEYS = ["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"];

const PANE_TERMINAL_KEYS = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY"];

/** The person's editor and display session, so a managed seat behaves like a plain one for Claude's external-editor
 *  action (EDITOR, VISUAL; Claude falls back to VS Code without them) and for image paste, which runs
 *  `xclip || wl-paste` (DISPLAY with XAUTHORITY reach X11; WAYLAND_DISPLAY reaches the compositor, see below). Names only:
 *  the pane supplies the values. Left out: XDG_SESSION_TYPE and XDG_CURRENT_DESKTOP, which neither path reads. A pane's
 *  XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are forwarded only as OpenRig's own pair (seat-runtime-dir.ts, below):
 *  sd-bus, GDBus and libdbus fall back to $XDG_RUNTIME_DIR/bus when the address is unset, so a runtime directory alone
 *  would hand the seat the session bus (the keyring, notifications) that the cleared environment keeps out. */
const PANE_SESSION_KEYS = ["EDITOR", "VISUAL", "DISPLAY", "XAUTHORITY"];

/** WAYLAND_DISPLAY without XDG_RUNTIME_DIR: a client resolves a relative socket name against XDG_RUNTIME_DIR, but an
 *  absolute path needs nothing else. The pane shell computes the value into a variable ahead of the environment reset: an absolute
 *  value is kept, a relative one is joined to the pane's XDG_RUNTIME_DIR, and a relative one with no XDG_RUNTIME_DIR (or
 *  an unset or empty one) leaves the variable empty, so the name is never forwarded. An assignment is not word-split or
 *  globbed, so a value with a space or a `*` arrives whole. The case patterns are balanced `(…)` so that shells that
 *  mis-parse an unbalanced `)` inside `$(…)` (bash before 4.0, a macOS /bin/sh) accept it. The variable stays in the
 *  shell that runs the command, which is a staged `/bin/sh` script for a managed launch; the final environment excludes it. */
const WAYLAND_DISPLAY_VAR = "__openrig_wayland_display";
const WAYLAND_DISPLAY_ASSIGNMENT = `${WAYLAND_DISPLAY_VAR}=$(case "\${WAYLAND_DISPLAY-}" in (/*) printf %s "$WAYLAND_DISPLAY";; `
  + `(?*) if [ -n "\${XDG_RUNTIME_DIR-}" ]; then printf %s/%s "$XDG_RUNTIME_DIR" "$WAYLAND_DISPLAY"; fi;; esac)`;

export class ClaudeManagedLaunch {
  constructor(private readonly db: Database.Database,
    private readonly sessionEnv: Readonly<Record<string, string | undefined>>,
    private readonly rendererEnv: Readonly<NodeJS.ProcessEnv>,
    /** Reads one variable from a seat's tmux session environment (the daemon's tmux adapter). */
    private readonly readSessionEnv?: (session: string, key: string) => Promise<string | undefined>,
    /** Where the daemon vendors its plugins; default is `plugins` under the OpenRig home (tests). */
    private readonly pluginsDir?: string) {}

  /** Names the seat's rig and member declare in `env:`, plus any one-off `rig up --env` names the
   *  launch recorded on the tmux session. Their values are already in the pane shell, which is
   *  where the launch forwards them from. The launch keeps ownership of its own variables. */
  private async seatEnvKeys(nodeId: string, session: string | undefined): Promise<string[]> {
    const keys = new Set<string>();
    try {
      const row = this.db.prepare(`SELECT n.env_json AS member, r.env_json AS rig
        FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`).get(nodeId) as { member: string | null; rig: string | null } | undefined;
      for (const json of [row?.rig, row?.member]) for (const key of Object.keys(parseStoredSeatEnv(json) ?? {})) keys.add(key);
    } catch { /* A database from before seat env has no columns to read. */ }
    // A seat that selected the shipped openrig-core plugin has the plugin variable in its pane (the launch, or a
    // handover's respawned pane, put it there). The session's own name list can predate that, so name it here too.
    if (seatCorePluginDir({ id: nodeId, runtime: "claude-code" }, this.db, undefined, this.pluginsDir)
      || seatSkillPluginDirForNode(this.db, nodeId)
      || (seatLaunchAdditionsForLaunch(this.db, nodeId).additions?.pluginDirs.length ?? 0) > 0) keys.add(CLAUDE_PLUGIN_DIRS_ENV);
    if (session && this.readSessionEnv) {
      // A one-off name is a convenience on top of the declared ones. If tmux can't be read, the
      // launch proceeds as it would for a seat with no one-off names.
      try {
        for (const key of (await this.readSessionEnv(session, SEAT_ENV_KEYS_VAR) ?? "").split(",")) {
          if (key) keys.add(key);
        }
      } catch { /* No one-off names. */ }
    }
    return [...keys].filter(key => validateSeatEnvName(key) === null && !MANAGED_LAUNCH_KEYS.includes(key));
  }

  private target(nodeId: string, runtime = "claude-code"): TargetSnapshot {
    const row = this.db.prepare(`SELECT n.id AS nodeId, n.runtime, n.cwd,
      b.id AS bindingId, b.tmux_session AS session, b.tmux_pane AS pane,
      (SELECT generation_uuid FROM occupant_tenures WHERE node_id=n.id
       ORDER BY generation_ordinal DESC LIMIT 1) AS generation
      FROM nodes n LEFT JOIN bindings b ON b.node_id=n.id WHERE n.id=?`).get(nodeId) as TargetSnapshot | undefined;
    if (!row || row.runtime !== runtime || !row.cwd || !path.isAbsolute(row.cwd)) {
      throw new Error("Claude managed launch context is unresolved: an absolute seat cwd and Claude node are required.");
    }
    return row;
  }

  /** The launch step that gives the seat's Claude its own subscription token (`rig provider switch --seat`), and the
   *  launch's warning when the file won't apply (checked without reading it); null for a seat without a reference.
   *  Launches without an explicit permission mode use it too, through the seat launch environment. */
  seatTokenLaunch(nodeId: string, opts: { removeOnFailure?: boolean } = {}): { ref: ClaudeSeatTokenRef; step: string; warnings: readonly string[] } | null {
    const ref = readClaudeSeatTokenRef(this.db, nodeId);
    if (!ref) return null;
    const problem = claudeSeatTokenFileProblem(ref);
    return { ref, step: claudeSeatTokenStep(ref, shellQuote, opts), warnings: Object.freeze(problem ? [this.tokenNotApplied(nodeId, ref, problem)] : []) };
  }

  /** Where a launch that didn't apply the seat's token is recorded (the daemon's event log); unset, it's only reported. */
  onTokenNotApplied?: (event: Extract<RigEvent, { type: "seat.claude_token_not_applied" }>) => void;

  /** A launch is starting Claude without the seat's own token: record it, and return what the launch reports. */
  tokenNotApplied(nodeId: string, ref: ClaudeSeatTokenRef, reason: string): string {
    try {
      const rig = this.db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(nodeId) as { rig_id?: string } | undefined;
      this.onTokenNotApplied?.({ type: "seat.claude_token_not_applied", rigId: rig?.rig_id ?? "", nodeId, label: ref.label, tokenFile: ref.tokenFile, reason });
    } catch { /* recording is best-effort; the launch still starts and reports it */ }
    return claudeSeatTokenFallbackNotice(ref, reason);
  }

  /** What would outrank the seat's own subscription token at its next launch: names its launch environment carries, and
   *  the settings files it loads. When the token applies, the launch unsets those names for Claude's process, so a pane
   *  shell's own exports can't outrank it. With `storedLogin`, also a `CLAUDE_CODE_OAUTH_TOKEN` it would receive, which Claude
   *  uses ahead of the stored login; a pane shell's own exports can't be read then. Managed settings (a file, MDM or the
   *  server) aren't read; the restarted seat's /status is the evidence for those. */
  async credentialPrecedence(nodeId: string, opts: { storedLogin?: boolean } = {}): Promise<CredentialPrecedence> {
    const target = this.target(nodeId);
    const cwd = target.cwd!;
    const conflicts: CredentialConflict[] = [];
    const instead: CredentialConflict[] = [];
    const names = opts.storedLogin ? [...OUTRANKING_TOKEN_ENV, "CLAUDE_CODE_OAUTH_TOKEN"] : OUTRANKING_TOKEN_ENV;
    const found = (name: string) => name === "CLAUDE_CODE_OAUTH_TOKEN" ? instead : conflicts;
    for (const name of names) {
      if (this.sessionEnv[name]) {
        found(name).push({ name, source: "the daemon's environment, which every managed Claude launch receives",
          remedy: `unset ${name} where the daemon starts, or take it out of recovery.provider_auth_env_allowlist; either reaches every seat` });
      }
    }
    const declared = await this.seatEnvKeys(nodeId, target.session ?? undefined);
    for (const name of names) {
      if (declared.includes(name)) {
        found(name).push({ name, source: "this seat's env: (member or rig) or a one-off launch name", remedy: `remove ${name} from this seat's env: in its rig spec` });
      }
    }
    const checked = [opts.storedLogin ? "the launch environment"
      : "the launch environment (a pane shell's own exports are unset for Claude's process when the token applies)"];
    const notChecked = ["managed settings (a managed-settings.json file, MDM or the server)",
      ...(opts.storedLogin ? ["the pane shell's own exports (its startup files), which a launch without an explicit permission mode keeps"] : [])];
    const root = projectRootForLocalSettings(cwd);
    const files: Array<[string, string]> = [
      [path.join(this.configPaths(cwd, nodeId).configDir, "settings.json"), "user"],
      [path.join(cwd, ".claude", "settings.json"), "project"],
      [path.join(root ?? cwd, ".claude", "settings.local.json"), "project local"],
      // Claude Code also reads a local file an earlier version left in the starting directory.
      ...(root && root !== path.resolve(cwd) ? [[path.join(cwd, ".claude", "settings.local.json"), "project local"] as [string, string]] : []),
    ];
    for (const [file, scope] of files) {
      const settings = settingsFileConflicts(file, scope, undefined, opts);
      conflicts.push(...settings.conflicts);
      instead.push(...(settings.instead ?? []));
      if (settings.checked) checked.push(settings.checked);
      if (settings.notChecked) notChecked.push(settings.notChecked);
    }
    return { conflicts, ...(instead.length ? { instead } : {}), checked, notChecked };
  }

  /** Bootstrap shares prepare's stored-node cwd when the binding omits it. */
  boundCwd(nodeId: string): string {
    return this.target(nodeId).cwd!;
  }

  /** The config dir a seat's Claude selects: its own home from its member or rig `env:`, else the daemon's. */
  private selectedConfigDir(nodeId: string | undefined): string | undefined {
    return effectiveRuntimeHome(this.db, nodeId, "claude-code", this.sessionEnv.CLAUDE_CONFIG_DIR);
  }

  /** Bootstrap and the launched child must use the same native selection.
   * Unset config uses HOME/.claude.json; even an explicit default-looking
   * directory selects <configDir>/.claude.json instead (#154/#225).
   */
  configPaths(cwd: string, nodeId?: string): { configDir: string; statePath: string } {
    const { HOME } = this.sessionEnv;
    const CLAUDE_CONFIG_DIR = this.selectedConfigDir(nodeId);
    if (!HOME || !path.isAbsolute(HOME)) throw new Error("Claude managed launch context is unresolved: absolute HOME is required.");
    const configDir = path.resolve(cwd, CLAUDE_CONFIG_DIR ?? path.join(HOME, ".claude"));
    return { configDir, statePath: path.join(CLAUDE_CONFIG_DIR === undefined ? HOME : configDir, ".claude.json") };
  }

  /** The state file under the seat's own or the daemon's non-empty CLAUDE_CONFIG_DIR, or undefined when neither
   * selects one. Classic bootstrap provisions it in addition to HOME/.claude.json. */
  selectedStatePath(cwd: string, nodeId?: string): string | undefined {
    return this.selectedConfigDir(nodeId) ? this.configPaths(cwd, nodeId).statePath : undefined;
  }

  private context(cwd: string, nodeId: string) {
    const { PATH, HOME } = this.sessionEnv;
    const CLAUDE_CONFIG_DIR = this.selectedConfigDir(nodeId);
    if (!PATH || !HOME || !path.isAbsolute(HOME)) throw new Error("Claude managed launch context is unresolved: managed PATH and absolute HOME are required.");
    // Relative/empty PATH entries are interpreted at the intended seat cwd,
    // including for /usr/bin/env shebangs inside the selected executable.
    const search = PATH.split(path.delimiter).map(p => path.resolve(cwd, p));
    const { configDir } = this.configPaths(cwd, nodeId);
    const env: Record<string, string> = { PATH: search.join(path.delimiter), HOME };
    // Session storage needs a directory, but exporting the default changes
    // Claude's global config selection. Preserve an unset native selection.
    if (CLAUDE_CONFIG_DIR !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
    if (claudeClassicRendererEnvPrefix(this.rendererEnv)) env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
    let executable: string | undefined;
    for (const dir of search) {
      const candidate = path.join(dir, "claude");
      try { accessSync(candidate, constants.X_OK); if (!statSync(candidate).isFile()) continue; }
      catch { continue; }
      executable = realpathSync(candidate); break;
    }
    if (!executable) throw new Error("Claude managed launch executable is unavailable on the intended PATH; no fallback was selected.");
    const identity = (file: string) => {
      const s = statSync(file);
      return [realpathSync(file), s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs];
    };
    return Object.freeze({ env: Object.freeze(env), configDir, executable, executableIsScript: fileStartsWithShebang(executable),
      fileIdentity: Object.freeze(identity(executable)), cwdIdentity: Object.freeze(identity(cwd).slice(0, 3)) });
  }

  async prepare(request: ClaudeLaunchTarget, mode: string): Promise<{
    assertCurrent: () => void; command: (args: readonly string[], launchEnv?: Readonly<Record<string, string>>) => string; configDir: string; executable: string; executableIsScript: boolean;
    /** Launch notes for the person, such as a seat token that won't apply. */
    warnings: readonly string[];
  }> {
    const target = Object.freeze({ ...request, ...(request.runtimeSwitch ? { runtimeSwitch: Object.freeze({ ...request.runtimeSwitch }) } : {}) });
    const switching = target.runtimeSwitch;
    const before = this.target(target.nodeId, switching?.fromRuntime);
    const cwd = before.cwd!;
    if (target.session !== undefined && (!before.pane || !before.generation)) {
      throw new Error("Claude managed launch context is unresolved: a bound pane and current occupant are required.");
    }
    // A staged switch successor: the seat's current occupant is still bound exactly, and the successor is elsewhere.
    const staged = !!switching && switching.fromRuntime !== "claude-code" && switching.session === before.session
      && switching.pane === before.pane && switching.generation === before.generation
      && !!target.session && target.session !== before.session && !!target.pane && target.pane !== before.pane
      && !!target.generation && target.generation !== before.generation;
    if ((target.cwd !== undefined && target.cwd !== cwd) || (switching && !staged)
      || (!staged && target.session !== undefined && target.session !== before.session)
      || (!staged && target.pane != null && target.pane !== before.pane)) {
      throw new Error("Claude managed launch target disagrees with the current binding; no input or selection changed.");
    }
    const context = this.context(cwd, target.nodeId);
    // This is the existing managed session channel, not arbitrary shell variables.
    // Filter out the explicit capability environment and overwrite launch identity.
    const inherited = Object.keys(this.sessionEnv).filter(key => this.sessionEnv[key] !== undefined
      && !MANAGED_LAUNCH_KEYS.includes(key));
    if (inherited.some(key => !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid managed environment key.");
    const assertCurrent = () => {
      if (JSON.stringify(this.target(target.nodeId, switching?.fromRuntime)) !== JSON.stringify(before)
        || JSON.stringify(this.context(cwd, target.nodeId)) !== JSON.stringify(context)
        || JSON.stringify(Object.keys(this.sessionEnv).filter(key => this.sessionEnv[key] !== undefined
          && !["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"].includes(key))) !== JSON.stringify(inherited)) {
        throw new Error("Claude managed launch context changed during capability discovery/input; retry explicitly.");
      }
    };
    const help = await new Promise<string>((resolve, reject) => {
      execFile(context.executable, ["--help"], { cwd, env: context.env, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
        (error, stdout) => error ? reject(new Error("Claude managed capability query failed; no fallback was selected.")) : resolve(stdout));
    });
    assertCurrent();
    validateNativePermissionSelection("claude-code", mode, parseClaudePermissionModes(help));
    const generation = target.generation ?? before.generation;
    const identity: Record<string, string> = { OPENRIG_NODE_ID: target.nodeId, OPENRIG_RUNTIME: "claude-code",
      ...(before.session ? { OPENRIG_SESSION_NAME: before.session } : {}),
      ...(generation ? { OPENRIG_OCCUPANT_GENERATION: generation } : {}) };
    const seatKeys = await this.seatEnvKeys(target.nodeId, before.session ?? undefined);
    const publicEnv = publicSeatEnvironment(this.sessionEnv);
    const assignments = Object.entries({ ...context.env, ...publicEnv, ...identity }).map(([key, value]) => `export ${shellQuote(`${key}=${value}`)}`);
    const forwarded = inherited.filter(key => !(key in identity) && !(key in publicEnv)).map(key => `export ${key}="\${${key}-}"`);
    // A declared name is forwarded only when the pane shell has it set, so a one-off name recorded on
    // the session never reaches a successor pane that was not given it. Set-but-empty stays empty.
    const seatForwarded = seatKeys.filter(key => !inherited.includes(key) && !(key in identity) && !(key in publicEnv))
      .map(key => `if [ "\${${key}+set}" ]; then export ${key}; fi`);
    // A seat that loads the openrig-core plugin has its launch project in its pane (OPENRIG_SEAT_PROJECT_DIR): the plugin's
    // hooks use it to tell the seat from a Claude started elsewhere inside it. Forwarded by name; the pane supplies the value.
    const loadsCorePlugin = seatCorePluginDir({ id: target.nodeId, runtime: "claude-code" }, this.db, undefined, this.pluginsDir) !== undefined;
    const projectForwarded = loadsCorePlugin ? [SEAT_PROJECT_DIR_ENV, SEAT_NODE_ENV]
      .map(key => `if [ "\${${key}+set}" ]; then export ${key}; fi`) : [];
    // Expand in the target pane shell, whose terminal can differ from the daemon.
    // Empty and absent values remain absent after the reset. TERM_PROGRAM is how Claude tells it runs
    // inside tmux; without it Claude never asks tmux for extended keys, and Shift+Enter reaches it
    // as a plain Enter. TMUX is left out on purpose: a bare `tmux` follows $TMUX ahead of
    // TMUX_TMPDIR, so tools the seat runs (and any daemon it starts) would follow the seat's own tmux server.
    const terminalKeys = [...PANE_TERMINAL_KEYS, ...PANE_SESSION_KEYS];
    const selectedKeys = [...Object.keys(context.env), ...Object.keys(publicEnv), ...Object.keys(identity), ...inherited,
      ...seatKeys, ...(loadsCorePlugin ? [SEAT_PROJECT_DIR_ENV, SEAT_NODE_ENV] : [])];
    const otherwise = (key: string) => selectedKeys.includes(key) ? "" : ` else unset ${key};`;
    const terminal = terminalKeys.map(key => `if [ -n "\${${key}-}" ]; then export ${key};${otherwise(key)} fi`);
    terminal.push(`if [ -n "$${WAYLAND_DISPLAY_VAR}" ]; then export WAYLAND_DISPLAY="$${WAYLAND_DISPLAY_VAR}";${otherwise("WAYLAND_DISPLAY")} fi`);
    // The runtime directory reaches Claude when the pane has OpenRig's pair (the directory and the bus address that can't
    // connect), or beside the seat's own declared bus address. A pane's own runtime directory or bus address, from a shell
    // profile or tmux's update-environment, stays out as before. Declared names are forwarded above as they are.
    const ownBus = selectedKeys.includes("DBUS_SESSION_BUS_ADDRESS");
    const openRigBus = `[ "\${DBUS_SESSION_BUS_ADDRESS-}" = ${shellQuote(NO_SESSION_BUS)} ]`;
    const runtimeDir = [
      ...(selectedKeys.includes("XDG_RUNTIME_DIR") ? [] : [`if [ -n "\${XDG_RUNTIME_DIR-}" ] && `
        + `${ownBus ? '[ -n "${DBUS_SESSION_BUS_ADDRESS-}" ]' : openRigBus}; then export XDG_RUNTIME_DIR; else unset XDG_RUNTIME_DIR; fi`]),
      ...(ownBus ? [] : [`if ${openRigBus}; then export DBUS_SESSION_BUS_ADDRESS; else unset DBUS_SESSION_BUS_ADDRESS; fi`]),
    ];
    // A seat's own subscription token (rig provider switch --seat) is read from its file as Claude starts, after the
    // removals are worked out, so the value never passes through OpenRig. The reduction keeps the name the step sets; when the
    // file can't be read, Claude still starts, and a token the reduction would have removed is removed by the step instead.
    const tokenKept = selectedKeys.includes("CLAUDE_CODE_OAUTH_TOKEN");
    const token = this.seatTokenLaunch(target.nodeId, { removeOnFailure: !tokenKept });
    const tokenStep = token ? `${token.step} && ` : "";
    const warnings = token?.warnings ?? Object.freeze([]);
    return Object.freeze({ assertCurrent, warnings, configDir: context.configDir, executable: context.executable, executableIsScript: context.executableIsScript, command: (args: readonly string[], launchEnv: Readonly<Record<string, string>> = {}) => {
      assertCurrent();
      const launch = Object.entries(launchEnv).map(([key, value]) => `export ${shellQuote(`${key}=${value}`)}`);
      const keep = [...selectedKeys, ...terminalKeys, "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
        ...Object.keys(launchEnv), ...(token ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [])];
      // env -0 keeps multiline values out of the name parser. The existing daemon's Node reads
      // that pipe with an empty environment (no pane NODE_OPTIONS); only removal names reach argv.
      const removalArgs = `const data=require("node:fs").readFileSync(0,"utf8"); if(!data.endsWith("\\0"))process.exit(1); `
        + `const keep=new Set(${JSON.stringify(keep)}); const quote=${shellQuote.toString()}; `
        + `process.stdout.write("set -- "+data.split("\\0").filter(s=>s.includes("=")).map(s=>s.slice(0,s.indexOf("="))).filter(k=>!keep.has(k)).flatMap(k=>["-u",quote(k)]).join(" "));`;
      const clear = `__openrig_remove=$(/usr/bin/env -0 | /usr/bin/env -i ${shellQuote(process.execPath)} -e ${shellQuote(removalArgs)}) && eval "$__openrig_remove"`;
      return `${WAYLAND_DISPLAY_ASSIGNMENT}; cd ${shellQuote(cwd)} && {
${[...assignments, ...forwarded, ...seatForwarded, ...projectForwarded, ...terminal, ...runtimeDir, ...launch].join("\n")}
${clear} && ${tokenStep}exec /usr/bin/env "$@" ${[shellQuote(context.executable), ...args.map(shellQuote)].join(" ")}
}`;
    } });
  }
}
