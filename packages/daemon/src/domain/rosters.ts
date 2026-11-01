// Authored rosters (`<workspace.root>/rosters/*.json`): who is on which team, what each is good at, and its limits.
// One parser for the CLI (`rig roster`, `rig_team`) and the daemon (a hosted member's wake route).
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
type Reference = { seat: string; host: string };
/** How OpenRig rings a hosted member when work lands for it. Values live in env vars or an env file, never here. */
export interface RosterWake {
  webhook: {
    /** Secret name holding the webhook URL (an env var, or a key in `secrets_env_file`). */
    url_ref: string;
    /** Secret name holding the Authorization header value, when the tool requires one. */
    authorization_ref?: string;
    /** Absolute path of an env file (0600) holding those keys, when they aren't in the daemon's environment. */
    secrets_env_file?: string;
  };
}
export interface RosterMember extends Reference {
  capabilities: string[];
  engagement: string[];
  use_when: string;
  why: string;
  caveat?: string;
  /** A member outside any terminal (an assistant or bot reaching the team over MCP): it has no node or pane. */
  hosted?: boolean;
  /** A hosted member's trigger, rung when a row lands for it. */
  wake?: RosterWake;
}
export interface Roster {
  version: 1;
  id: string;
  name: string;
  purpose: string;
  curator: Reference;
  updated_at: string;
  members: RosterMember[];
}
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => text(x) !== null);
const reference = (v: unknown): v is Row & Reference => object(v) && text(v.seat) !== null && text(v.host) !== null;

function parseWake(value: unknown): RosterWake {
  const hook = object(value) ? value.webhook : undefined;
  if (!object(hook) || text(hook.url_ref) === null
      || (hook.authorization_ref !== undefined && text(hook.authorization_ref) === null)
      || (hook.secrets_env_file !== undefined && text(hook.secrets_env_file) === null)) {
    throw new Error("A member's wake needs webhook.url_ref (optional authorization_ref and secrets_env_file): secret names, never values");
  }
  return { webhook: { url_ref: hook.url_ref as string,
    ...(hook.authorization_ref === undefined ? {} : { authorization_ref: hook.authorization_ref as string }),
    ...(hook.secrets_env_file === undefined ? {} : { secrets_env_file: hook.secrets_env_file as string }) } };
}

/** Select authored fields only: a file cannot supply runtime or observed-model facts. */
export function parseRoster(value: unknown): Roster {
  if (!object(value) || value.version !== 1 || !reference(value.curator) ||
      ![value.id, value.name, value.purpose, value.updated_at].every(v => text(v) !== null) || !Array.isArray(value.members)) {
    throw new Error("Expected a version 1 roster with id, name, purpose, curator, updated_at and members");
  }
  const members = value.members.map((m): RosterMember => {
    if (!reference(m) || !object(m) || !strings(m.capabilities) || !strings(m.engagement) ||
        text(m.use_when) === null || text(m.why) === null || (m.caveat !== undefined && typeof m.caveat !== "string")
        || (m.hosted !== undefined && typeof m.hosted !== "boolean")) {
      throw new Error("Each member needs seat, host, capabilities, engagement, use_when and why (optional caveat, and hosted: true or false)");
    }
    return { seat: m.seat, host: m.host, capabilities: m.capabilities, engagement: m.engagement,
      use_when: m.use_when as string, why: m.why as string, ...(m.caveat === undefined ? {} : { caveat: m.caveat as string }),
      ...(m.hosted === true ? { hosted: true } : {}), ...(m.wake === undefined ? {} : { wake: parseWake(m.wake) }) };
  });
  return { version: 1, id: value.id as string, name: value.name as string, purpose: value.purpose as string,
    curator: { seat: value.curator.seat, host: value.curator.host }, updated_at: value.updated_at as string, members };
}

export function readRosters(folder: string): { rosters: Roster[]; warnings: string[] } {
  const rosters: Roster[] = [], warnings: string[] = [];
  let names: string[];
  try { names = readdirSync(folder).filter(n => n.endsWith(".json")).sort(); }
  catch (error) { return { rosters, warnings: [`Cannot read roster folder ${folder}: ${(error as Error).message}`] }; }
  for (const name of names) {
    let fd: number | undefined;
    try {
      // Inspect the opened target before reading; NONBLOCK also handles a FIFO
      // without waiting for a writer. Regular-file symlinks remain readable.
      fd = openSync(join(folder, name), constants.O_RDONLY | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) throw new Error("Not a regular file; skipped");
      rosters.push(parseRoster(JSON.parse(readFileSync(fd, "utf8"))));
    } catch (error) { warnings.push(`${name}: ${(error as Error).message}`); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return { rosters, warnings };
}

/** The wake declared for a hosted member at this address on this host, or null (not hosted, no trigger, or
 *  an unreadable roster: the member then stays unroutable, and the person is told). */
export function hostedWakeFor(destination: string, folder: string, selfHostId: string | null): RosterWake | null {
  if (!selfHostId) return null;
  for (const roster of readRosters(folder).rosters) {
    const member = roster.members.find((m) => m.hosted === true && m.seat === destination && m.host === selfHostId && m.wake);
    if (member) return member.wake!;
  }
  return null;
}

/** Whether a roster on this host lists this address as a hosted member, with or without a trigger. */
export function isHostedMemberAt(destination: string, folder: string, selfHostId: string | null): boolean {
  if (!selfHostId) return false;
  return readRosters(folder).rosters.some((roster) =>
    roster.members.some((m) => m.hosted === true && m.seat === destination && m.host === selfHostId));
}
