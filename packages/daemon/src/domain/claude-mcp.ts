import type Database from "better-sqlite3";

/** Omitted means Claude's normal MCP loading; `none` is an explicit per-seat opt-out. */
export type ClaudeMcp = "none";
export const EMPTY_CLAUDE_MCP_CONFIG = '{"mcpServers":{}}';

export function validateClaudeMcp(value: unknown, label = "claude_mcp"): ClaudeMcp {
  if (value !== "none") throw new Error(`${label}: must be "none" (omit it for normal MCP loading)`);
  return value;
}

export function claudeMcpArgs(value: ClaudeMcp | null | undefined): string[] {
  if (value == null) return [];
  validateClaudeMcp(value);
  return ["--strict-mcp-config", "--mcp-config", EMPTY_CLAUDE_MCP_CONFIG];
}

/** Read the seat record on every launch, including saved-context restore and successors.
 * Older schemas have no column; a present but invalid value must never become default loading. */
export function readSeatClaudeMcp(db: Database.Database, nodeId: string): ClaudeMcp | undefined {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as { claude_mcp?: unknown } | undefined;
  return row?.claude_mcp == null ? undefined : validateClaudeMcp(row.claude_mcp, `Seat ${nodeId} claude_mcp`);
}
