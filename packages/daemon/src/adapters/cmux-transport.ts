import type { CmuxTransport, CmuxTransportFactory } from "./cmux.js";
import type { ExecFn } from "./tmux.js";

/** Shell-quote a string using single quotes (POSIX-safe). */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Maps CmuxTransport method names to cmux CLI commands.
 * Grounded in documented CLI from prd.md:675-682 and capability-probe.sh.
 */
const METHOD_MAP: Record<string, { cmd: string; json: boolean }> = {
  capabilities: { cmd: "cmux capabilities --json", json: true },
  "workspace.list": { cmd: "cmux list-workspaces --json", json: true },
  "surface.list": { cmd: "cmux list-surfaces --json", json: true },
  "workspace.agentPIDs": { cmd: "cmux agent-pids --json", json: true },
};

function buildCommand(
  method: string,
  params?: Record<string, unknown>
): { cmd: string; json: boolean } {
  // Static commands (no params)
  const mapped = METHOD_MAP[method];
  if (mapped) return mapped;

  // Parameterized commands — modern cmux CLI shape
  if (method === "workspace.current") {
    return { cmd: "cmux current-workspace --json", json: true };
  }

  if (method === "surface.create" && params?.workspaceId) {
    return {
      cmd: `cmux new-surface --type ${shellQuote(String(params.type ?? "terminal"))} --workspace ${shellQuote(String(params.workspaceId))} --json`,
      json: true,
    };
  }

  if (method === "surface.focus" && params?.surfaceId) {
    return {
      cmd: `cmux focus-panel --panel ${shellQuote(String(params.surfaceId))}`,
      json: false,
    };
  }

  if (method === "surface.sendText" && params?.surfaceId && params?.text != null) {
    return {
      cmd: `cmux send --surface ${shellQuote(String(params.surfaceId))} ${shellQuote(String(params.text))}`,
      json: false,
    };
  }

  throw new Error(`Unknown cmux method: ${method}`);
}

/**
 * CLI-based CmuxTransportFactory.
 * Maps CmuxTransport.request(method, params) to cmux CLI commands.
 * Uses ExecFn injection for testability (same pattern as TmuxAdapter).
 */
export function createCmuxCliTransport(exec: ExecFn): CmuxTransportFactory {
  return async (): Promise<CmuxTransport> => {
    // Verify cmux is available by running capabilities
    await exec("cmux capabilities --json");

    return {
      request: async (method: string, params?: unknown): Promise<unknown> => {
        const { cmd, json } = buildCommand(
          method,
          params as Record<string, unknown> | undefined
        );
        const output = await exec(cmd);

        if (json) {
          try {
            return JSON.parse(output);
          } catch {
            throw new Error(
              `Failed to parse JSON from cmux command '${cmd}': ${output.slice(0, 200)}`
            );
          }
        }

        return {};
      },
      close: () => {
        // CLI-based transport has no persistent connection to close
      },
    };
  };
}
