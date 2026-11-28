import type Database from "better-sqlite3";

/** Planned native tool rules, separate from the seat's permission mode. `ask` is Claude's native `permissions.ask`: it
 *  is kept only when it lists a rule, so a record without asks keeps its earlier bytes, which an older OpenRig reads. */
export interface ClaudePermissionRules {
  allow: string[];
  ask?: string[];
  deny: string[];
}

const RULE_LISTS = ["allow", "ask", "deny"] as const;

export function validateClaudePermissionRules(value: unknown, label = "claude_permissions"): ClaudePermissionRules {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an allow/ask/deny mapping`);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(RULE_LISTS as readonly string[]).includes(key)) throw new Error(`${label}.${key}: unsupported key; only allow, ask and deny are supported`);
  const lists: Record<(typeof RULE_LISTS)[number], string[]> = { allow: [], ask: [], deny: [] };
  for (const key of RULE_LISTS) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) throw new Error(`${label}.${key}: expected a list of tool rules`);
    lists[key] = (raw[key] as unknown[]).map((rule, index) => {
      if (typeof rule !== "string" || !rule.trim() || /[\r\n]/.test(rule)
        || !/^[A-Za-z_][A-Za-z0-9_*-]*(?:\(.+\))?$/.test(rule)) {
        throw new Error(`${label}.${key}[${index}]: expected Tool or Tool(specifier), without newlines`);
      }
      if (rule.startsWith("mcp__") && rule.includes("(")) throw new Error(`${label}.${key}[${index}]: MCP rules use tool names, not parenthesized specifiers`);
      return rule;
    });
  }
  return { allow: lists.allow, ...(lists.ask.length ? { ask: lists.ask } : {}), deny: lists.deny };
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
