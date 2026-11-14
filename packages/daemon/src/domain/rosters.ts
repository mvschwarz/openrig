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
  /** How often a hosted member is expected to check its queue, in minutes, as its person set it up (an hourly schedule
   *  is 60). Stated, not observed. Absent implies neither a schedule nor on request: without `check_in_on_request`
   *  either, the member's check-in status reads unknown. */
  check_in_minutes?: number;
  /** Its person set it to check in when asked, not on a schedule. */
  check_in_on_request?: true;
  /** Why an authored `check_in_minutes` can't be used. The roster still loads; the member's check-in status reads
   *  unknown with this reason. */
  check_in_problem?: string;
  /** How the person knows this member, for an assistant to say back ("claude (Sam's assistant, invited)"): plain text,
   *  at most 200 characters. */
  label?: string;
  /** Why an authored `label` isn't used. The roster still loads, and the member is named by its seat as before. */
  label_problem?: string;
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

/** The most a member's label, or a team's name as it's shown, may hold. */
export const MEMBER_LABEL_MAX = 200;

// What changes how the text around it shows: C0 and C1 controls, the line and paragraph separators, and the bidirectional
// embeddings, overrides and isolates. Joiners and the implicit direction marks are ordinary in names, and stay allowed.
// eslint-disable-next-line no-control-regex
const LAYOUT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Why text an assistant repeats to a person (a member's label, a team's name) can't be shown as authored, or null: plain
 *  text of at most 200 characters, with no markup and nothing that breaks or reorders what's shown. */
function shownTextProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} isn't non-empty text`;
  if ([...value].length > MEMBER_LABEL_MAX) return `${field} is longer than ${MEMBER_LABEL_MAX} characters`;
  if (LAYOUT_CONTROLS.test(value)) return `${field} holds a control character (a line break, a separator or a bidirectional control)`;
  if (/[<>]/.test(value)) return `${field} holds an angle bracket`;
  return null;
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
    // A cadence that can't be used never stops the roster loading: the member's check-in status reads unknown instead.
    const cadence = m.check_in_minutes, onRequest = m.check_in_on_request;
    const cadenceProblem = cadence === undefined && onRequest === undefined ? null
      : m.hosted !== true ? "check_in_minutes and check_in_on_request are for a connected assistant (a member marked hosted: true)"
        : onRequest !== undefined && onRequest !== true ? `check_in_on_request ${JSON.stringify(onRequest)} isn't true`
          : onRequest === true && cadence !== undefined ? "it states both check_in_minutes and check_in_on_request"
            : cadence !== undefined && (!Number.isInteger(cadence) || (cadence as number) <= 0) ? `check_in_minutes ${JSON.stringify(cadence)} isn't a positive whole number of minutes`
              : null;
    // A label that can't be used never stops the roster loading either: the member is named by its seat instead.
    const badLabel = m.label === undefined ? null : shownTextProblem("label", m.label);
    return { seat: m.seat, host: m.host, capabilities: m.capabilities, engagement: m.engagement,
      use_when: m.use_when as string, why: m.why as string, ...(m.caveat === undefined ? {} : { caveat: m.caveat as string }),
      ...(m.hosted === true ? { hosted: true } : {}), ...(m.wake === undefined ? {} : { wake: parseWake(m.wake) }),
      ...(cadenceProblem ? { check_in_problem: cadenceProblem }
        : { ...(cadence === undefined ? {} : { check_in_minutes: cadence as number }), ...(onRequest === true ? { check_in_on_request: true as const } : {}) }),
      ...(m.label === undefined ? {} : badLabel ? { label_problem: badLabel } : { label: (m.label as string).trim() }) };
  });
  return { version: 1, id: value.id as string, name: value.name as string, purpose: value.purpose as string,
    curator: { seat: value.curator.seat, host: value.curator.host }, updated_at: value.updated_at as string, members };
}

function readRosterFile(file: string): Roster {
  let fd: number | undefined;
  try {
    // Inspect the opened target before reading; NONBLOCK also handles a FIFO
    // without waiting for a writer. Regular-file symlinks remain readable.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error("Not a regular file; skipped");
    return parseRoster(JSON.parse(readFileSync(fd, "utf8")));
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readRosters(folder: string): { rosters: Roster[]; warnings: string[] } {
  const rosters: Roster[] = [], warnings: string[] = [];
  let names: string[];
  try { names = readdirSync(folder).filter(n => n.endsWith(".json")).sort(); }
  catch (error) { return { rosters, warnings: [`Cannot read roster folder ${folder}: ${(error as Error).message}`] }; }
  for (const name of names) {
    try { rosters.push(readRosterFile(join(folder, name))); }
    catch (error) { warnings.push(`${name}: ${(error as Error).message}`); }
  }
  return { rosters, warnings };
}

/** The name a person knows a rig's team by: its network roster's (`network-<rig>.json`) authored `name`, which is
 *  "Your OpenRig team" when its owner hasn't named it. Null when there's no such roster or it can't be read, and null with
 *  the reason when its name can't be shown as authored (the label rule): the roster itself still loads. */
export function rosterTeamName(folder: string, rig: string): { name: string | null; problem?: string } {
  if (!rig || /[\\/\0]|^\.\.?$/.test(rig)) return { name: null };
  let name: string;
  try { name = readRosterFile(join(folder, `network-${rig}.json`)).name; } catch { return { name: null }; }
  const problem = shownTextProblem("name", name);
  return problem ? { name: null, problem } : { name };
}

/** The team's name as a result line says it: quoted when its owner named it, else "your OpenRig team". */
export const UNNAMED_TEAM = "Your OpenRig team";
export function teamPhrase(name: string | null): string {
  return name && name !== UNNAMED_TEAM ? `the team "${name}"` : "your OpenRig team";
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

/** The hosted members the rosters list on this host, one per seat: where two rosters list the same seat, the first by
 *  file name wins. Empty when this host's id is unknown. */
export function hostedMembersAt(folder: string, selfHostId: string | null): RosterMember[] {
  if (!selfHostId) return [];
  const bySeat = new Map<string, RosterMember>();
  for (const roster of readRosters(folder).rosters) {
    for (const m of roster.members) if (m.hosted === true && m.host === selfHostId && !bySeat.has(m.seat)) bySeat.set(m.seat, m);
  }
  return [...bySeat.values()];
}

/** Whether a roster on this host lists this address as a hosted member, with or without a trigger. */
export function isHostedMemberAt(destination: string, folder: string, selfHostId: string | null): boolean {
  if (!selfHostId) return false;
  return readRosters(folder).rosters.some((roster) =>
    roster.members.some((m) => m.hosted === true && m.seat === destination && m.host === selfHostId));
}
