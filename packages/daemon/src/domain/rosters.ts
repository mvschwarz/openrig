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
    /** Secret name holding a Standard Webhooks signing secret (`whsec_…`), when the tool verifies signed rings. */
    signing_secret_ref?: string;
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
  /** Its owner says it takes no requests (only `false` is authored; a member takes them by default). Work sent to it is
   *  still written, and the sender is told so, with `takes_requests_note`, so it can send the work elsewhere. */
  takes_requests?: false;
  /** Why it takes no requests, as a sender's assistant can repeat it: the label rule (plain text, at most 200 characters). */
  takes_requests_note?: string;
  /** Why an authored `takes_requests` or `takes_requests_note` can't be used. The roster still loads; a note that can't be
   *  used leaves the flag in place. */
  takes_requests_problem?: string;
  /** Which client the participant uses and what kind of participant it is, as the service that issued its access recorded
   *  them (authored as `app` and `kind`): each a short lowercase token, passed through as recorded. That service owns the
   *  values; absent is unknown, never inferred from a name or label. Not a seat's node kind. */
  participant?: { app?: string; kind?: string };
  /** Why an authored `app` or `kind` isn't used. Each is dropped on its own, and the roster still loads. */
  participant_problem?: string;
  /** The team this member is the declared entry point for, as the roster's author recorded it: a plain team name. It's
   *  context only: no escalation, routing or ownership of other members' work follows from it. */
  lead_of?: string;
  /** Why an authored `lead_of` isn't used. It's dropped, and the roster still loads. */
  lead_of_problem?: string;
}
export interface Roster {
  version: 1;
  id: string;
  /** Empty when the roster's author hasn't named the team. */
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
      || (hook.signing_secret_ref !== undefined && text(hook.signing_secret_ref) === null)
      || (hook.secrets_env_file !== undefined && text(hook.secrets_env_file) === null)) {
    throw new Error("A member's wake needs webhook.url_ref (optional authorization_ref, signing_secret_ref and secrets_env_file): secret names, never values");
  }
  return { webhook: { url_ref: hook.url_ref as string,
    ...(hook.authorization_ref === undefined ? {} : { authorization_ref: hook.authorization_ref as string }),
    ...(hook.signing_secret_ref === undefined ? {} : { signing_secret_ref: hook.signing_secret_ref as string }),
    ...(hook.secrets_env_file === undefined ? {} : { secrets_env_file: hook.secrets_env_file as string }) } };
}

/** The most a member's label, or a team's name as it's shown, may hold. */
export const MEMBER_LABEL_MAX = 200;
/** The longest declared `lead_of` team name, in characters. */
export const LEAD_OF_MAX = 40;

// What changes how the text around it shows: C0 and C1 controls, the line and paragraph separators, and the bidirectional
// embeddings, overrides and isolates. Also the invisible characters that let two names that look the same differ: the word
// joiner and invisible operators (U+2060-2064) and the byte-order mark (U+FEFF). The zero-width space (it breaks words in
// Thai, Khmer and Burmese names), the joiners and the implicit direction marks are ordinary in names, and stay allowed.
// eslint-disable-next-line no-control-regex
const LAYOUT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** Why text an assistant repeats to a person (a member's label, a team's name) can't be shown as authored, or null: plain
 *  text of at most 200 characters, with no markup and nothing that breaks or reorders what's shown. */
function shownTextProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} isn't non-empty text`;
  if ([...value].length > MEMBER_LABEL_MAX) return `${field} is longer than ${MEMBER_LABEL_MAX} characters`;
  if (LAYOUT_CONTROLS.test(value)) return `${field} holds a control character (a line break, a separator, a bidirectional control or an invisible character)`;
  if (/[<>]/.test(value)) return `${field} holds an angle bracket`;
  return null;
}

/** A participant's `app` or `kind` as recorded: a letter, then up to 31 lowercase letters, digits or hyphens. */
const PARTICIPANT_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

/** An authored `app` or `kind`: the token, or why it isn't used. Absent or empty is unknown, with nothing to say. */
function participantField(field: "app" | "kind", value: unknown): { token?: string; problem?: string } {
  if (value === undefined || value === "") return {};
  if (typeof value === "string" && PARTICIPANT_TOKEN.test(value)) return { token: value };
  const shown = JSON.stringify(value) ?? String(value);
  return { problem: `${field} ${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown} isn't a short lowercase token (a letter, then up to 31 lowercase letters, digits or hyphens)` };
}

/** Select authored fields only: a file cannot supply runtime or observed-model facts. */
export function parseRoster(value: unknown): Roster {
  if (!object(value) || value.version !== 1 || !reference(value.curator) ||
      ![value.id, value.purpose, value.updated_at].every(v => text(v) !== null) ||
      (value.name !== undefined && value.name !== "" && text(value.name) === null) || !Array.isArray(value.members)) {
    throw new Error("Expected a version 1 roster with id, purpose, curator, updated_at and members (optional name)");
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
    // So does a takes-requests flag or note that can't be used: a bad flag reads as taking requests, a bad note leaves the
    // flag without it, and either says why.
    const takes = m.takes_requests, takesNote = m.takes_requests_note;
    const takesProblem = takes !== undefined && typeof takes !== "boolean" ? `takes_requests ${JSON.stringify(takes)} isn't true or false`
      : takesNote !== undefined && takes !== false ? "takes_requests_note is for a member with takes_requests: false"
        : takesNote !== undefined ? shownTextProblem("takes_requests_note", takesNote) : null;
    // So does an app or kind that isn't a token: that one is dropped, and the problem says why.
    const app = participantField("app", m.app), kind = participantField("kind", m.kind);
    const participant = { ...(app.token ? { app: app.token } : {}), ...(kind.token ? { kind: kind.token } : {}) };
    const participantProblem = [app.problem, kind.problem].filter(Boolean).join("; ");
    // So does a lead_of that isn't a plain team name: absent or empty declares nothing.
    const leadOf = m.lead_of === undefined || m.lead_of === "" ? undefined : m.lead_of;
    const leadOfProblem = leadOf === undefined ? null : shownTextProblem("lead_of", leadOf)
      ?? ([...(leadOf as string).trim()].length > LEAD_OF_MAX ? `lead_of is longer than ${LEAD_OF_MAX} characters` : null);
    return { seat: m.seat, host: m.host, capabilities: m.capabilities, engagement: m.engagement,
      use_when: m.use_when as string, why: m.why as string, ...(m.caveat === undefined ? {} : { caveat: m.caveat as string }),
      ...(m.hosted === true ? { hosted: true } : {}), ...(m.wake === undefined ? {} : { wake: parseWake(m.wake) }),
      ...(cadenceProblem ? { check_in_problem: cadenceProblem }
        : { ...(cadence === undefined ? {} : { check_in_minutes: cadence as number }), ...(onRequest === true ? { check_in_on_request: true as const } : {}) }),
      ...(m.label === undefined ? {} : badLabel ? { label_problem: badLabel } : { label: (m.label as string).trim() }),
      ...(takes === false ? { takes_requests: false as const } : {}),
      ...(takes === false && takesNote !== undefined && !takesProblem ? { takes_requests_note: (takesNote as string).trim() } : {}),
      ...(takesProblem ? { takes_requests_problem: takesProblem } : {}),
      ...(Object.keys(participant).length ? { participant } : {}),
      ...(participantProblem ? { participant_problem: participantProblem } : {}),
      ...(leadOf === undefined ? {} : leadOfProblem ? { lead_of_problem: leadOfProblem } : { lead_of: (leadOf as string).trim() }) };
  });
  return { version: 1, id: value.id as string, name: (value.name as string | undefined) ?? "", purpose: value.purpose as string,
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

/** The rosters in file-name order, each with its file (`files[i]` is `rosters[i]`'s), and the files that couldn't be read,
 *  so a caller that takes the first roster's entry can tell when an unread file came first. */
export function readRosters(folder: string): { rosters: Roster[]; warnings: string[]; files: string[]; unreadable: string[] } {
  const rosters: Roster[] = [], warnings: string[] = [], files: string[] = [], unreadable: string[] = [];
  let names: string[];
  try { names = readdirSync(folder).filter(n => n.endsWith(".json")).sort(); }
  catch (error) { return { rosters, warnings: [`Cannot read roster folder ${folder}: ${(error as Error).message}`], files, unreadable }; }
  for (const name of names) {
    try { rosters.push(readRosterFile(join(folder, name))); files.push(name); }
    catch (error) { warnings.push(`${name}: ${(error as Error).message}`); unreadable.push(name); }
  }
  return { rosters, warnings, files, unreadable };
}

/** The name a person knows a rig's team by: its network roster's (`network-<rig>.json`) authored `name`, or, when there's
 *  no network roster, the name of the roster that declares the rig as its `id` (the `<rig>.json` the starter and factory
 *  leads write; the first by file name if several do). It's "Your OpenRig team" when its owner hasn't named it. Null when
 *  there's no such roster or it can't be read, and null with the reason when its name can't be shown as authored (the
 *  label rule): the roster itself still loads. */
export function rosterTeamName(folder: string, rig: string): { name: string | null; problem?: string } {
  if (!rig || /[\\/\0]|^\.\.?$/.test(rig)) return { name: null };
  let name: string | undefined;
  try { name = readRosterFile(join(folder, `network-${rig}.json`)).name; } catch (error) {
    // Only a missing network roster falls back; one that's there but can't be read leaves the team unnamed, as before.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { name: null };
    name = readRosters(folder).rosters.find((roster) => roster.id === rig)?.name;
  }
  if (name === undefined || name === "") return { name: null };
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
