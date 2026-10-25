import type Database from "better-sqlite3";

/** Planned native tool rules, separate from the seat's permission mode. */
export interface ClaudePermissionRules {
  allow: string[];
  deny: string[];
}

export function validateClaudePermissionRules(value: unknown, label = "claude_permissions"): ClaudePermissionRules {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an allow/deny mapping`);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== "allow" && key !== "deny") throw new Error(`${label}.${key}: unsupported key; only allow and deny are supported`);
  const result: ClaudePermissionRules = { allow: [], deny: [] };
  for (const key of ["allow", "deny"] as const) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) throw new Error(`${label}.${key}: expected a list of tool rules`);
    result[key] = (raw[key] as unknown[]).map((rule, index) => {
      if (typeof rule !== "string" || !rule.trim() || /[\r\n]/.test(rule)
        || !/^[A-Za-z_][A-Za-z0-9_*-]*(?:\(.+\))?$/.test(rule)) {
        throw new Error(`${label}.${key}[${index}]: expected Tool or Tool(specifier), without newlines`);
      }
      if (rule.startsWith("mcp__") && rule.includes("(")) throw new Error(`${label}.${key}[${index}]: MCP rules use tool names, not parenthesized specifiers`);
      return rule;
    });
  }
  return result;
}

/** Read the current seat, not its original spec or a launch-time cache. Minimal old fixtures have no column. */
export function readClaudePermissionRules(db: Database.Database, nodeId: string): ClaudePermissionRules | undefined {
  let seat = nodeId;
  try {
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as { logical_id?: string; claude_permissions_json?: string | null } | undefined;
    if (row?.claude_permissions_json == null) return undefined;
    if (row.logical_id) seat += ` (${row.logical_id})`;
    return validateClaudePermissionRules(JSON.parse(row.claude_permissions_json));
  } catch (error) {
    throw new Error(`Seat ${seat}: cannot read claude_permissions (${(error as Error).message}). Repair the rules with rig seat set-permissions <seat> --rules <file> --reason <reason> before launching.`);
  }
}
