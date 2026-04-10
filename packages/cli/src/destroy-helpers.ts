import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

export const DESTROY_CONFIRM_TOKEN = "destroy-openrig-state";

export type DestroyScope = "state" | "all";

export interface DestroyRuntimeConfig {
  stateRoot: string;
  dbPath: string;
  transcriptsPath: string;
  daemonHost: string;
  daemonPort: number;
}

export interface DestroyTarget {
  path: string;
  kind: "state_root" | "db_file" | "db_shm" | "db_wal" | "transcripts_dir";
  backupPath?: string;
}

export interface DestroyPlan {
  scope: DestroyScope;
  backup: boolean;
  stateRoot: string;
  daemonHost: string;
  daemonPort: number;
  managedTmuxSessions: string[];
  targets: DestroyTarget[];
  warnings: string[];
}

export interface DestroyResult {
  scope: DestroyScope;
  backup: boolean;
  stateRoot: string;
  backupPaths: string[];
  daemonStopped: boolean;
  portCleared: boolean;
  tmuxKilled: number;
  tmuxMissing: number;
  warnings: string[];
}

export interface DestroyDeps {
  stopDaemon: () => Promise<void>;
  probeDaemon: (host: string, port: number) => Promise<boolean>;
  findListeningPid: (port: number) => number | null;
  killProcess: (pid: number) => void;
  exists: (path: string) => boolean;
  renamePath: (from: string, to: string) => void;
  removePath: (path: string) => void;
  mkdirp: (path: string) => void;
  listManagedTmuxSessions: (dbPath: string) => string[];
  killTmuxSession: (sessionName: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function normalizePathForPrefix(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function isWithinPath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(normalizePathForPrefix(root));
}

function formatTimestamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function buildBackupPath(targetPath: string, exists: (path: string) => boolean, now = new Date()): string {
  const stamp = formatTimestamp(now);
  const base = `${targetPath}.backup-${stamp}`;
  if (!exists(base)) return base;
  let suffix = 2;
  while (exists(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function listManagedTmuxSessionsFromDb(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT DISTINCT COALESCE(b.tmux_session, s.session_name) AS session_name
      FROM nodes n
      LEFT JOIN bindings b ON b.node_id = n.id
      LEFT JOIN sessions s ON s.node_id = n.id
      WHERE COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).all() as Array<{ session_name: string | null }>;

    return rows
      .map((row) => row.session_name?.trim() ?? "")
      .filter((name): name is string => Boolean(name))
      .sort();
  } finally {
    db.close();
  }
}

export function buildDestroyPlan(
  scope: DestroyScope,
  backup: boolean,
  config: DestroyRuntimeConfig,
  deps: Pick<DestroyDeps, "exists" | "listManagedTmuxSessions" | "now">
): DestroyPlan {
  const warnings: string[] = [];
  const targets: DestroyTarget[] = [];

  const stateRootExists = deps.exists(config.stateRoot);
  targets.push({
    path: config.stateRoot,
    kind: "state_root",
    ...(backup && stateRootExists ? { backupPath: buildBackupPath(config.stateRoot, deps.exists, deps.now()) } : {}),
  });

  const addExternalTarget = (path: string, kind: DestroyTarget["kind"]) => {
    if (!deps.exists(path)) return;
    if (isWithinPath(path, config.stateRoot)) return;
    targets.push({
      path,
      kind,
      ...(backup ? { backupPath: buildBackupPath(path, deps.exists, deps.now()) } : {}),
    });
    warnings.push(`${kind} is outside state root and will be ${backup ? "backed up separately" : "deleted separately"}: ${path}`);
  };

  addExternalTarget(config.dbPath, "db_file");
  addExternalTarget(`${config.dbPath}-shm`, "db_shm");
  addExternalTarget(`${config.dbPath}-wal`, "db_wal");
  addExternalTarget(config.transcriptsPath, "transcripts_dir");

  let managedTmuxSessions: string[] = [];
  if (scope === "all" && deps.exists(config.dbPath)) {
    try {
      managedTmuxSessions = deps.listManagedTmuxSessions(config.dbPath);
    } catch (err) {
      warnings.push(`Failed to enumerate managed tmux sessions from ${config.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    scope,
    backup,
    stateRoot: config.stateRoot,
    daemonHost: config.daemonHost,
    daemonPort: config.daemonPort,
    managedTmuxSessions,
    targets,
    warnings,
  };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0";
}

export async function executeDestroy(plan: DestroyPlan, deps: DestroyDeps): Promise<DestroyResult> {
  const warnings = [...plan.warnings];
  const backupPaths: string[] = [];

  try {
    await deps.stopDaemon();
  } catch (err) {
    warnings.push(`stopDaemon failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let daemonStopped = true;
  let portCleared = true;

  if (isLocalHost(plan.daemonHost)) {
    const probeBefore = await deps.probeDaemon(plan.daemonHost, plan.daemonPort);
    if (probeBefore) {
      daemonStopped = false;
      const listenerPid = deps.findListeningPid(plan.daemonPort);
      if (listenerPid !== null) {
        try {
          deps.killProcess(listenerPid);
        } catch (err) {
          warnings.push(`Failed to terminate listener pid ${listenerPid}: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!(await deps.probeDaemon(plan.daemonHost, plan.daemonPort))) break;
          await deps.sleep(100);
        }
      } else {
        warnings.push(`OpenRig responded on port ${plan.daemonPort}, but no listener pid was found.`);
      }
    }
    portCleared = !(await deps.probeDaemon(plan.daemonHost, plan.daemonPort));
    daemonStopped = portCleared;
  } else {
    warnings.push(`Daemon host ${plan.daemonHost} is not local; port termination was skipped.`);
  }

  let tmuxKilled = 0;
  let tmuxMissing = 0;
  if (plan.scope === "all") {
    for (const sessionName of plan.managedTmuxSessions) {
      if (deps.killTmuxSession(sessionName)) tmuxKilled += 1;
      else tmuxMissing += 1;
    }
  }

  for (const target of plan.targets) {
    if (!deps.exists(target.path)) continue;
    if (plan.backup && target.backupPath) {
      deps.renamePath(target.path, target.backupPath);
      backupPaths.push(target.backupPath);
    } else {
      deps.removePath(target.path);
    }
  }

  deps.mkdirp(plan.stateRoot);

  return {
    scope: plan.scope,
    backup: plan.backup,
    stateRoot: plan.stateRoot,
    backupPaths,
    daemonStopped,
    portCleared,
    tmuxKilled,
    tmuxMissing,
    warnings,
  };
}

export function findListeningPidWithLsof(port: number): number | null {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
    if (!output) return null;
    const first = output.split(/\s+/)[0]?.trim();
    if (!first) return null;
    const pid = parseInt(first, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function killTmuxSessionWithCli(sessionName: string): boolean {
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
