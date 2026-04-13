import type { CmuxTransport, CmuxTransportFactory } from "./cmux.js";
import type { ExecFn } from "./tmux.js";

/** Shell-quote a string using single quotes (POSIX-safe). */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Subclass of Error carrying a stable `code` discriminator and (optional)
 * `method` so the broader adapter / route layer can distinguish surface-level
 * unavailability from request execution failures while staying inside the
 * adapter-only patch boundary. The `code: "unavailable"` vocabulary mirrors
 * the existing CmuxAdapter result discriminator (see `adapters/cmux.ts`).
 */
class CmuxSurfaceError extends Error {
  readonly code: string;
  readonly method: string;

  constructor(method: string, message: string) {
    super(message);
    this.code = "unavailable";
    this.method = method;
    this.name = "CmuxSurfaceError";
  }
}

/**
 * Parse the subcommand block of `cmux --help` into a Set of available
 * top-level command names. cmux's help format puts each command on a
 * line indented with two spaces, e.g.:
 *
 *   Commands:
 *     list-panels [--workspace <id|ref>]
 *     focus-panel --panel <id|ref>
 *
 * Lenient: if the help output is unparseable for any reason, the Set is
 * empty and downstream version-adaptive dispatch will treat surfaces as
 * unsupported, which is the honest answer.
 */
function parseCmuxCommands(help: string): Set<string> {
  const commands = new Set<string>();
  for (const rawLine of help.split("\n")) {
    const match = rawLine.match(/^\s{2,}([a-z][a-z0-9-]+)/);
    if (match && match[1]) commands.add(match[1]);
  }
  return commands;
}

interface BuildContext {
  supported: Set<string>;
}

interface BuildResult {
  cmd: string;
  json: boolean;
}

function buildCommand(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: BuildContext
): BuildResult {
  // --- Stable commands (present on every supported cmux version) ---
  if (method === "capabilities") {
    return { cmd: "cmux capabilities --json", json: true };
  }
  if (method === "workspace.list") {
    return { cmd: "cmux list-workspaces --json", json: true };
  }
  if (method === "workspace.current") {
    return { cmd: "cmux current-workspace --json", json: true };
  }

  // --- Version-adaptive: surface listing ---
  // cmux ≥0.63 ships `list-panels`; older cmux exposed `list-surfaces`.
  // Architect direction: prefer the new surface, keep the legacy fallback,
  // never version-pin away newer cmux. Both shapes are normalized to the
  // `{surfaces: [...]}` payload that downstream `CmuxAdapter.listSurfaces`
  // expects (see `adapters/cmux.ts:110-123`).
  if (method === "surface.list") {
    const workspaceArg = params?.workspaceId
      ? ` --workspace ${shellQuote(String(params.workspaceId))}`
      : "";
    if (ctx.supported.has("list-panels")) {
      return { cmd: `cmux list-panels${workspaceArg} --json`, json: true };
    }
    if (ctx.supported.has("list-surfaces")) {
      return { cmd: `cmux list-surfaces${workspaceArg} --json`, json: true };
    }
    throw new CmuxSurfaceError(
      method,
      "cmux does not expose a surface-listing command (neither `list-panels` nor `list-surfaces`)"
    );
  }

  // --- Version-adaptive: agent PID enumeration ---
  // `cmux agent-pids` was removed in 0.63.x with no replacement. Honest
  // detection: refuse loudly if the legacy command is absent rather than
  // calling it and letting cmux emit "Unknown command".
  if (method === "workspace.agentPIDs") {
    if (ctx.supported.has("agent-pids")) {
      return { cmd: "cmux agent-pids --json", json: true };
    }
    throw new CmuxSurfaceError(
      method,
      "cmux does not expose `agent-pids` (removed in cmux 0.63.x; no equivalent surface)"
    );
  }

  // --- Stable parameterized commands ---
  if (method === "surface.create" && params?.workspaceId) {
    return {
      cmd: `cmux new-surface --type ${shellQuote(String(params.type ?? "terminal"))} --workspace ${shellQuote(String(params.workspaceId))} --json`,
      json: true,
    };
  }

  if (method === "surface.focus" && params?.surfaceId) {
    const workspaceArg = params.workspaceId
      ? ` --workspace ${shellQuote(String(params.workspaceId))}`
      : "";
    return {
      cmd: `cmux focus-panel --panel ${shellQuote(String(params.surfaceId))}${workspaceArg}`,
      json: false,
    };
  }

  if (method === "surface.sendText" && params?.surfaceId && params?.text != null) {
    const workspaceArg = params.workspaceId
      ? ` --workspace ${shellQuote(String(params.workspaceId))}`
      : "";
    return {
      cmd: `cmux send --surface ${shellQuote(String(params.surfaceId))}${workspaceArg} ${shellQuote(String(params.text))}`,
      json: false,
    };
  }

  throw new Error(`Unknown cmux method: ${method}`);
}

/**
 * Normalize JSON payloads from version-adaptive commands so downstream
 * consumers see one stable shape regardless of which cmux command actually
 * answered. Currently aliases `panels` (cmux ≥0.63 `list-panels`) onto
 * `surfaces` (legacy `list-surfaces`); leaves other shapes untouched.
 */
function normalizePayload(method: string, raw: unknown): unknown {
  if (method !== "surface.list") return raw;
  if (raw === null || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.surfaces)) return raw;
  if (Array.isArray(obj.panels)) {
    const { panels, ...rest } = obj;
    return { ...rest, surfaces: panels };
  }
  if (Array.isArray(obj.pane_surfaces)) {
    const { pane_surfaces, ...rest } = obj;
    return { ...rest, surfaces: pane_surfaces };
  }
  return raw;
}

/**
 * CLI-based CmuxTransportFactory.
 *
 * At factory time, probes `cmux --help` to discover the live cmux command
 * surface. The probe doubles as a binary-presence check (replaces the older
 * `cmux capabilities --json` verify): a missing cmux binary makes exec throw
 * ENOENT, which the factory propagates to the caller. The probe result is
 * cached on the returned transport instance and consulted on every request
 * to dispatch to the correct command for the installed cmux version.
 */
export function createCmuxCliTransport(exec: ExecFn): CmuxTransportFactory {
  return async (): Promise<CmuxTransport> => {
    const helpOutput = await exec("cmux --help");
    const supported = parseCmuxCommands(helpOutput);

    return {
      request: async (method: string, params?: unknown): Promise<unknown> => {
        const { cmd, json } = buildCommand(
          method,
          params as Record<string, unknown> | undefined,
          { supported }
        );
        const output = await exec(cmd);

        if (json) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch {
            const legacyFallback = legacyJsonFallback(method, output);
            if (legacyFallback !== null) {
              return legacyFallback;
            }
            throw new Error(
              `Failed to parse JSON from cmux command '${cmd}': ${output.slice(0, 200)}`
            );
          }
          return normalizePayload(method, parsed);
        }

        return {};
      },
      close: () => {
        // CLI-based transport has no persistent connection to close
      },
    };
  };
}

function legacyJsonFallback(method: string, output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  // cmux 0.61.x can still return a bare handle for some --json commands.
  if (method === "workspace.current") {
    return { workspace_id: trimmed };
  }

  if (method === "surface.create") {
    const summary = trimmed.replace(/^OK\s+/, "");
    const refMatch = summary.match(/(?:^|\s)(surface:[^\s]+)/);
    if (refMatch) {
      return { created_surface_ref: refMatch[1] };
    }
    const firstToken = summary.split(/\s+/)[0];
    if (firstToken) {
      return { created_surface_ref: firstToken };
    }
    return null;
  }

  return null;
}
