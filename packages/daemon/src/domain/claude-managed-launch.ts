import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { shellQuote } from "../adapters/shell-quote.js";
import { claudeClassicRendererEnvPrefix } from "../adapters/yolo-mode.js";
import { parseClaudePermissionModes } from "./permission-drift.js";
import { validateNativePermissionSelection } from "./native-permission-selection.js";

export interface ClaudeLaunchTarget {
  nodeId: string;
  cwd?: string;
  session?: string;
  pane?: string | null;
  /** A successor may have a reserved generation before its tenure is committed. */
  generation?: string;
}

interface TargetSnapshot {
  nodeId: string; runtime: string; cwd: string | null; bindingId: string | null;
  session: string | null; pane: string | null; generation: string | null;
}

/** Dynamic choices use the managed launch environment, not an interactive shell's
 * aliases or startup files. No cache and no persisted environment/credentials.
 * The help child has only the capability environment. Launch adds the existing
 * managed identity/auth channel by variable NAME, never secret values in text.
 */
export class ClaudeManagedLaunch {
  constructor(private readonly db: Database.Database,
    private readonly sessionEnv: Readonly<Record<string, string | undefined>>,
    private readonly rendererEnv: Readonly<NodeJS.ProcessEnv>) {}

  private target(nodeId: string): TargetSnapshot {
    const row = this.db.prepare(`SELECT n.id AS nodeId, n.runtime, n.cwd,
      b.id AS bindingId, b.tmux_session AS session, b.tmux_pane AS pane,
      (SELECT generation_uuid FROM occupant_tenures WHERE node_id=n.id
       ORDER BY generation_ordinal DESC LIMIT 1) AS generation
      FROM nodes n LEFT JOIN bindings b ON b.node_id=n.id WHERE n.id=?`).get(nodeId) as TargetSnapshot | undefined;
    if (!row || row.runtime !== "claude-code" || !row.cwd || !path.isAbsolute(row.cwd)) {
      throw new Error("Claude managed launch context is unresolved: an absolute seat cwd and Claude node are required.");
    }
    return row;
  }

  private context(cwd: string) {
    const { PATH, HOME, CLAUDE_CONFIG_DIR } = this.sessionEnv;
    if (!PATH || !HOME || !path.isAbsolute(HOME)) throw new Error("Claude managed launch context is unresolved: managed PATH and absolute HOME are required.");
    // Relative/empty PATH entries are interpreted at the intended seat cwd,
    // including for /usr/bin/env shebangs inside the selected executable.
    const search = PATH.split(path.delimiter).map(p => path.resolve(cwd, p));
    const env: Record<string, string> = { PATH: search.join(path.delimiter), HOME,
      CLAUDE_CONFIG_DIR: path.resolve(cwd, CLAUDE_CONFIG_DIR ?? path.join(HOME, ".claude")) };
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
    return Object.freeze({ env: Object.freeze(env), executable,
      fileIdentity: Object.freeze(identity(executable)), cwdIdentity: Object.freeze(identity(cwd).slice(0, 3)) });
  }

  async prepare(request: ClaudeLaunchTarget, mode: string): Promise<{
    assertCurrent: () => void; command: (args: readonly string[]) => string; configDir: string;
  }> {
    const target = Object.freeze({ ...request });
    const before = this.target(target.nodeId);
    const cwd = before.cwd!;
    if (target.session !== undefined && (!before.pane || !before.generation)) {
      throw new Error("Claude managed launch context is unresolved: a bound pane and current occupant are required.");
    }
    if ((target.cwd !== undefined && target.cwd !== cwd)
      || (target.session !== undefined && target.session !== before.session)
      || (target.pane != null && target.pane !== before.pane)) {
      throw new Error("Claude managed launch target disagrees with the current binding; no input or selection changed.");
    }
    const context = this.context(cwd);
    // This is the existing managed session channel, not arbitrary shell variables.
    // Filter out the explicit capability environment and overwrite launch identity.
    const inherited = Object.keys(this.sessionEnv).filter(key => this.sessionEnv[key] !== undefined
      && !["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"].includes(key));
    if (inherited.some(key => !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid managed environment key.");
    const assertCurrent = () => {
      if (JSON.stringify(this.target(target.nodeId)) !== JSON.stringify(before)
        || JSON.stringify(this.context(cwd)) !== JSON.stringify(context)
        || JSON.stringify(Object.keys(this.sessionEnv).filter(key => this.sessionEnv[key] !== undefined
          && !["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"].includes(key))) !== JSON.stringify(inherited)) {
        throw new Error("Claude managed launch context changed during capability discovery/input; retry explicitly.");
      }
    };
    const help = await new Promise<string>((resolve, reject) => {
      execFile(context.executable, ["--help"], { cwd, env: context.env, encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024 },
        (error, stdout) => error ? reject(new Error("Claude managed capability query failed; no fallback was selected.")) : resolve(stdout));
    });
    assertCurrent();
    validateNativePermissionSelection("claude-code", mode, parseClaudePermissionModes(help));
    const generation = target.generation ?? before.generation;
    const identity: Record<string, string> = { OPENRIG_NODE_ID: target.nodeId, OPENRIG_RUNTIME: "claude-code",
      ...(before.session ? { OPENRIG_SESSION_NAME: before.session } : {}),
      ...(generation ? { OPENRIG_OCCUPANT_GENERATION: generation } : {}) };
    const assignments = Object.entries({ ...context.env, ...identity }).map(([key, value]) => shellQuote(`${key}=${value}`));
    const forwarded = inherited.filter(key => !(key in identity)).map(key => `"${key}=\${${key}-}"`);
    return Object.freeze({ assertCurrent, configDir: context.env.CLAUDE_CONFIG_DIR!, command: (args: readonly string[]) => {
      assertCurrent();
      return `cd ${shellQuote(cwd)} && /usr/bin/env -i ${[...assignments, ...forwarded, shellQuote(context.executable), ...args.map(shellQuote)].join(" ")}`;
    } });
  }
}
