// The gateway's participant side file (0.7.3 participant foundation).
//
// Person fragments under gateway/humans/ keep their closed key set exactly as v0.7.0 reads it, so after a rollback an
// older daemon still loads every person. Everything newer lives here, in <home>/gateway/participants.yaml, which v0.7.0
// and v0.7.1 never read: the default person, organizations and their groups, each participant's organization, groups
// and readable policy, and shared-channel participants (one vetted channel is one participant, not a person per sender).
//
// Policy is text agents read and apply. Nothing here enforces it, and nothing derives it from names.
//
// A broken side file never disables the person registry: asks, answers and inbound admission keep working from the
// fragments, this file's own features report the error, and with several people no default is chosen. A reference to a
// person whose fragment is gone is a warning and is ignored, never a reason to refuse the whole file.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getOpenRigHome } from "../../openrig-compat.js";
import { ADDRESS_DOMAIN, ENTITY_ID_PATTERN, HANDLE_PATTERN, atomicWrite, participantsPath, projectHumans, type HumanFragment } from "./human-registry.js";

// The path lives beside the person registry, which reads it to keep a person off a shared channel's id.
export { participantsPath };

export const PARTICIPANTS_FILE_VERSION = 1;

export interface ParticipantOrganization { name: string; policy?: string }
export interface ParticipantGroup { organization: string; name: string; policy?: string }
export interface SharedChannelBinding { connector: "slack"; connectorRef: string; secretsRef: string; channelId: string }
interface Placement { organization?: string; groups?: string[]; policy?: string }
export type PersonEntry = Placement & { kind: "person" };
export type SharedChannelEntry = Placement & { kind: "shared-channel"; displayName: string; channel: SharedChannelBinding };
export type ParticipantEntry = PersonEntry | SharedChannelEntry;

export interface ParticipantsFile {
  version: typeof PARTICIPANTS_FILE_VERSION;
  /** The person for anything that needs one without naming one. Never a shared channel. */
  default?: string;
  organizations: Record<string, ParticipantOrganization>;
  groups: Record<string, ParticipantGroup>;
  participants: Record<string, ParticipantEntry>;
}

export const emptyParticipantsFile = (): ParticipantsFile => ({ version: PARTICIPANTS_FILE_VERSION, organizations: {}, groups: {}, participants: {} });

const FILE_KEYS = new Set(["version", "default", "organizations", "groups", "participants"]);
const ORGANIZATION_KEYS = new Set(["name", "policy"]);
const GROUP_KEYS = new Set(["organization", "name", "policy"]);
const PERSON_KEYS = new Set(["kind", "organization", "groups", "policy"]);
const CHANNEL_KEYS = new Set(["kind", "displayName", "channel", "organization", "groups", "policy"]);
const CHANNEL_BINDING_KEYS = new Set(["connector", "connectorRef", "secretsRef", "channelId"]);

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unknownKey = (obj: Record<string, unknown>, allowed: Set<string>) => Object.keys(obj).find((key) => !allowed.has(key));
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export type ValidateParticipantsResult =
  | { ok: true; file: ParticipantsFile; warnings: string[] }
  | { ok: false; error: string };

/** Structure is checked strictly: a typo must not silently change what agents read. References to people are checked
 *  against `personIds` (the registered fragments) when given: a person entry or default whose fragment is gone is
 *  dropped with a warning; a shared channel that takes a person's id is an error (one address space). */
export function validateParticipantsFile(raw: unknown, personIds?: ReadonlySet<string>): ValidateParticipantsResult {
  if (!isObj(raw)) return { ok: false, error: "the participants file must be a mapping" };
  const top = unknownKey(raw, FILE_KEYS);
  if (top) return { ok: false, error: `unknown key "${top}" — allowed: ${[...FILE_KEYS].join(", ")}` };
  if (raw.version !== PARTICIPANTS_FILE_VERSION) return { ok: false, error: `version must be ${PARTICIPANTS_FILE_VERSION} (found ${String(raw.version)})` };
  const warnings: string[] = [];
  const mapping = (key: "organizations" | "groups" | "participants") => {
    const value = raw[key];
    if (value === undefined || value === null) return {};
    return isObj(value) ? value : null;
  };

  const organizations: Record<string, ParticipantOrganization> = {};
  const rawOrganizations = mapping("organizations");
  if (!rawOrganizations) return { ok: false, error: "organizations must be a mapping of <id>: { name, policy? }" };
  for (const [id, value] of Object.entries(rawOrganizations)) {
    const where = `organizations.${id}`;
    if (!ENTITY_ID_PATTERN.test(id)) return { ok: false, error: `${where}: the id must be a lowercase slug (a-z0-9._-)` };
    if (!isObj(value)) return { ok: false, error: `${where} must be a mapping { name, policy? }` };
    const extra = unknownKey(value, ORGANIZATION_KEYS);
    if (extra) return { ok: false, error: `${where} has unknown key "${extra}" — allowed: name, policy` };
    if (!nonEmpty(value.name)) return { ok: false, error: `${where}.name must be a non-empty string` };
    if (value.policy !== undefined && typeof value.policy !== "string") return { ok: false, error: `${where}.policy must be text` };
    organizations[id] = { name: value.name, ...(value.policy !== undefined ? { policy: value.policy as string } : {}) };
  }

  const groups: Record<string, ParticipantGroup> = {};
  const rawGroups = mapping("groups");
  if (!rawGroups) return { ok: false, error: "groups must be a mapping of <id>: { organization, name, policy? }" };
  for (const [id, value] of Object.entries(rawGroups)) {
    const where = `groups.${id}`;
    if (!ENTITY_ID_PATTERN.test(id)) return { ok: false, error: `${where}: the id must be a lowercase slug (a-z0-9._-)` };
    if (!isObj(value)) return { ok: false, error: `${where} must be a mapping { organization, name, policy? }` };
    const extra = unknownKey(value, GROUP_KEYS);
    if (extra) return { ok: false, error: `${where} has unknown key "${extra}" — allowed: organization, name, policy` };
    if (typeof value.organization !== "string" || !organizations[value.organization]) {
      return { ok: false, error: `${where}.organization "${String(value.organization)}" isn't a known organization` };
    }
    if (!nonEmpty(value.name)) return { ok: false, error: `${where}.name must be a non-empty string` };
    if (value.policy !== undefined && typeof value.policy !== "string") return { ok: false, error: `${where}.policy must be text` };
    groups[id] = { organization: value.organization, name: value.name, ...(value.policy !== undefined ? { policy: value.policy as string } : {}) };
  }

  const participants: Record<string, ParticipantEntry> = {};
  const rawParticipants = mapping("participants");
  if (!rawParticipants) return { ok: false, error: "participants must be a mapping of <id>: { kind, ... }" };
  const channelOwner = new Map<string, string>();
  for (const [id, value] of Object.entries(rawParticipants)) {
    const where = `participants.${id}`;
    if (!ENTITY_ID_PATTERN.test(id)) return { ok: false, error: `${where}: the id must be a lowercase slug (a-z0-9._-)` };
    if (!isObj(value)) return { ok: false, error: `${where} must be a mapping { kind, ... }` };
    if (value.kind !== "person" && value.kind !== "shared-channel") {
      return { ok: false, error: `${where}.kind "${String(value.kind)}" must be person or shared-channel` };
    }
    const extra = unknownKey(value, value.kind === "person" ? PERSON_KEYS : CHANNEL_KEYS);
    if (extra) return { ok: false, error: `${where} has unknown key "${extra}" for a ${value.kind}` };
    const placement: Placement = {};
    if (value.organization !== undefined) {
      if (typeof value.organization !== "string" || !organizations[value.organization]) {
        return { ok: false, error: `${where}.organization "${String(value.organization)}" isn't a known organization` };
      }
      placement.organization = value.organization;
    }
    if (value.groups !== undefined) {
      if (!Array.isArray(value.groups)) return { ok: false, error: `${where}.groups must be a list of group ids` };
      const seen = new Set<string>();
      for (const group of value.groups) {
        if (typeof group !== "string" || !groups[group]) return { ok: false, error: `${where}.groups: "${String(group)}" isn't a known group` };
        if (seen.has(group)) return { ok: false, error: `${where}.groups lists "${group}" twice` };
        seen.add(group);
      }
      placement.groups = [...seen];
    }
    if (value.policy !== undefined) {
      if (typeof value.policy !== "string") return { ok: false, error: `${where}.policy must be text` };
      placement.policy = value.policy;
    }
    if (value.kind === "person") {
      if (personIds && !personIds.has(id)) {
        warnings.push(`${where}: no person "${id}" is registered, so this entry is ignored`);
        continue;
      }
      participants[id] = { kind: "person", ...placement };
      continue;
    }
    if (personIds?.has(id)) return { ok: false, error: `${where}: "${id}" is already a person's id; a shared channel needs its own (they share ${id}@${ADDRESS_DOMAIN})` };
    if (!nonEmpty(value.displayName)) return { ok: false, error: `${where}.displayName must be a non-empty string` };
    const channel = value.channel;
    if (!isObj(channel)) return { ok: false, error: `${where}.channel must be { connector: slack, connectorRef, secretsRef, channelId }` };
    const channelExtra = unknownKey(channel, CHANNEL_BINDING_KEYS);
    if (channelExtra) return { ok: false, error: `${where}.channel has unknown key "${channelExtra}"` };
    if (channel.connector !== "slack") return { ok: false, error: `${where}.channel.connector must be slack` };
    if (!nonEmpty(channel.connectorRef)) return { ok: false, error: `${where}.channel.connectorRef must be a non-empty string` };
    if (!nonEmpty(channel.secretsRef)) return { ok: false, error: `${where}.channel.secretsRef must be a vault pointer, never the secret` };
    if (typeof channel.channelId !== "string" || !HANDLE_PATTERN.test(channel.channelId)) {
      return { ok: false, error: `${where}.channel.channelId "${String(channel.channelId)}" must be a Slack channel id (letters and digits)` };
    }
    const prior = channelOwner.get(channel.channelId);
    if (prior) return { ok: false, error: `${where}: channel ${channel.channelId} is already the participant "${prior}"` };
    channelOwner.set(channel.channelId, id);
    participants[id] = {
      kind: "shared-channel", displayName: value.displayName,
      channel: { connector: "slack", connectorRef: channel.connectorRef, secretsRef: channel.secretsRef, channelId: channel.channelId },
      ...placement,
    };
  }

  const file: ParticipantsFile = { version: PARTICIPANTS_FILE_VERSION, organizations, groups, participants };
  if (raw.default !== undefined && raw.default !== null) {
    if (typeof raw.default !== "string") return { ok: false, error: "default must be a person's id" };
    if (participants[raw.default]?.kind === "shared-channel") return { ok: false, error: `default "${raw.default}" is a shared channel; the default is a person` };
    if (personIds && !personIds.has(raw.default)) warnings.push(`default: no person "${raw.default}" is registered, so no default is chosen`);
    else file.default = raw.default;
  }
  return { ok: true, file, warnings };
}

export type ReadParticipantsResult =
  | { ok: true; file: ParticipantsFile; exists: boolean; warnings: string[] }
  | { ok: false; error: string };

/** Read and validate the side file. Absent is an empty file (a one-person install needs none). */
export function readParticipantsFile(home: string = getOpenRigHome(), personIds?: ReadonlySet<string>): ReadParticipantsResult {
  const path = participantsPath(home);
  if (!existsSync(path)) return { ok: true, file: emptyParticipantsFile(), exists: false, warnings: [] };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `the participants file at ${path} doesn't parse: ${(err as Error).message}` };
  }
  const validated = validateParticipantsFile(raw, personIds);
  if (!validated.ok) return { ok: false, error: `the participants file at ${path} is invalid: ${validated.error}` };
  return { ok: true, file: validated.file, exists: true, warnings: validated.warnings };
}

const FILE_HEADER =
  "# OpenRig gateway participants: the default person, organizations, groups, readable policy and shared channels.\n" +
  "# Written by `rig gateway` verbs and read by OpenRig 0.7.3 and later. Older daemons don't read this file, and\n" +
  "# person records stay in gateway/humans/, so a rollback still loads every person.\n";

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]!]));

/** The canonical bytes: sections in a fixed order, ids sorted, so a write is stable and diffable. */
export function participantsFileBody(file: ParticipantsFile): string {
  const body: Record<string, unknown> = { version: file.version };
  if (file.default) body.default = file.default;
  body.organizations = sortedRecord(file.organizations);
  body.groups = sortedRecord(file.groups);
  body.participants = sortedRecord(file.participants);
  return FILE_HEADER + stringifyYaml(body);
}

export type UpdateParticipantsResult =
  | { ok: true; path: string; file: ParticipantsFile; warnings: string[] }
  | { ok: false; error: string };

/** The one writer: read the current file against the registered people, apply `change`, validate the result the same
 *  way a read does, then write it atomically. `change` returns an error string to refuse. */
export function updateParticipantsFile(
  change: (file: ParticipantsFile, people: readonly HumanFragment[]) => ParticipantsFile | string,
  home: string = getOpenRigHome(),
): UpdateParticipantsResult {
  const people = projectHumans(home);
  if (!people.ok) return { ok: false, error: `can't check participants against the person registry, which is invalid: ${people.error}` };
  const personIds = new Set(people.entities.map((entity) => entity.entityId));
  const current = readParticipantsFile(home, personIds);
  if (!current.ok) return current;
  const next = change(structuredClone(current.file), people.entities);
  if (typeof next === "string") return { ok: false, error: next };
  const validated = validateParticipantsFile(JSON.parse(JSON.stringify(next)), personIds);
  if (!validated.ok) return { ok: false, error: validated.error };
  // The read already dropped entries for people removed by hand, so a reference to an unregistered person here is this
  // change's own mistake: refuse it rather than write an entry nobody can use.
  if (validated.warnings.length > 0) return { ok: false, error: validated.warnings.join("; ") };
  const path = participantsPath(home);
  const written = atomicWrite(path, participantsFileBody(validated.file));
  // The warnings name the stale entries this write left out.
  return written.ok ? { ok: true, path, file: validated.file, warnings: current.warnings } : written;
}

export type DefaultPerson<T extends Pick<HumanFragment, "entityId"> = HumanFragment> =
  | { person: T; source: "chosen" | "only-person" }
  | { person: null; source: "none"; reason: string };

/** The person for anything that needs one without naming one (an escalation, the notice digest, Mission Control's
 *  my-queue, a workflow's human step, a pairing approval): the side file's default, else the only registered person,
 *  else none, with the reason. Never the first of several, and never workspace.operator_seat_name. */
export function resolveDefaultPerson<T extends Pick<HumanFragment, "entityId">>(entities: readonly T[], home: string = getOpenRigHome()): DefaultPerson<T> {
  const side = readParticipantsFile(home, new Set(entities.map((entity) => entity.entityId)));
  const chosen = side.ok && side.file.default ? entities.find((entity) => entity.entityId === side.file.default) : undefined;
  if (chosen) return { person: chosen, source: "chosen" };
  if (entities.length === 1) return { person: entities[0]!, source: "only-person" };
  if (entities.length === 0) return { person: null, source: "none", reason: "no person is registered" };
  return {
    person: null, source: "none",
    reason: side.ok
      ? "several people are registered and none is the default; choose one with `rig gateway default <id>`"
      : `several people are registered and the default can't be read (${side.error})`,
  };
}

export interface PolicyPart { source: string; text: string }

/** A participant's readable policy, outermost first: its organization's, each of its groups', then its own. Each part
 *  says where it came from, so an agent can weigh and quote it. */
export function effectivePolicy(id: string, file: ParticipantsFile): PolicyPart[] {
  const entry = file.participants[id];
  if (!entry) return [];
  const parts: PolicyPart[] = [];
  const organization = entry.organization ? file.organizations[entry.organization] : undefined;
  if (organization?.policy) parts.push({ source: `organization ${entry.organization} (${organization.name})`, text: organization.policy });
  for (const groupId of entry.groups ?? []) {
    const group = file.groups[groupId];
    if (group?.policy) parts.push({ source: `group ${groupId} (${group.name})`, text: group.policy });
  }
  if (entry.policy) parts.push({ source: "participant", text: entry.policy });
  return parts;
}

export interface ParticipantView {
  id: string;
  address: string;
  kind: "person" | "shared-channel";
  displayName: string;
  organization: { id: string; name: string } | null;
  groups: Array<{ id: string; name: string }>;
  default: boolean;
  policy: PolicyPart[];
  channel?: { connector: "slack"; channelId: string };
}

export type ParticipantsViewResult =
  | { ok: true; participants: ParticipantView[]; default: DefaultPerson; warnings: string[]; sideFile: { path: string; exists: boolean; error?: string } }
  | { ok: false; error: string };

/** Every person and shared channel, with organization, groups, the default and effective policy. An unreadable side
 *  file still lists the people (from their fragments), and says why the rest is missing. */
export function participantsView(home: string = getOpenRigHome()): ParticipantsViewResult {
  const people = projectHumans(home);
  if (!people.ok) return { ok: false, error: people.error };
  const personIds = new Set(people.entities.map((entity) => entity.entityId));
  const side = readParticipantsFile(home, personIds);
  const file = side.ok ? side.file : emptyParticipantsFile();
  const chosen = resolveDefaultPerson(people.entities, home);
  const placementOf = (id: string) => {
    const entry = file.participants[id];
    const organization = entry?.organization ? { id: entry.organization, name: file.organizations[entry.organization]!.name } : null;
    const groups = (entry?.groups ?? []).map((groupId) => ({ id: groupId, name: file.groups[groupId]!.name }));
    return { organization, groups, policy: effectivePolicy(id, file) };
  };
  const views: ParticipantView[] = people.entities.map((entity) => ({
    id: entity.entityId, address: entity.address, kind: "person", displayName: entity.displayName,
    ...placementOf(entity.entityId), default: chosen.person?.entityId === entity.entityId,
  }));
  for (const [id, entry] of Object.entries(file.participants)) {
    if (entry.kind !== "shared-channel") continue;
    views.push({
      id, address: `${id}@${ADDRESS_DOMAIN}`, kind: "shared-channel", displayName: entry.displayName,
      ...placementOf(id), default: false, channel: { connector: entry.channel.connector, channelId: entry.channel.channelId },
    });
  }
  views.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true, participants: views, default: chosen, warnings: side.ok ? side.warnings : [],
    sideFile: { path: participantsPath(home), exists: side.ok ? side.exists : true, ...(side.ok ? {} : { error: side.error }) },
  };
}

// ── The writes behind the `rig gateway` verbs. Each goes through updateParticipantsFile, so each is validated the same
// way a read is and written atomically.

export interface PlacementInput { organization?: string | null; groups?: string[] | null; policy?: string | null }

const applyPlacement = (entry: Placement, input: PlacementInput): void => {
  if (input.organization !== undefined) { if (input.organization === null) delete entry.organization; else entry.organization = input.organization; }
  if (input.groups !== undefined) { if (input.groups === null || input.groups.length === 0) delete entry.groups; else entry.groups = input.groups; }
  if (input.policy !== undefined) { if (input.policy === null || input.policy === "") delete entry.policy; else entry.policy = input.policy; }
};

/** A person's organization, groups and policy (null clears one). The person must already be registered. */
export function setPersonPlacement(entityId: string, input: PlacementInput, home: string = getOpenRigHome()): UpdateParticipantsResult {
  return updateParticipantsFile((file, people) => {
    if (!people.some((person) => person.entityId === entityId)) return `no person "${entityId}" is registered`;
    const entry: PersonEntry = file.participants[entityId]?.kind === "person" ? file.participants[entityId] as PersonEntry : { kind: "person" };
    applyPlacement(entry, input);
    // A person with nothing placed needs no entry: the fragment already makes them a participant.
    if (entry.organization || entry.groups || entry.policy) file.participants[entityId] = entry;
    else delete file.participants[entityId];
    return file;
  }, home);
}

/** Choose the default person, or clear it (null). */
export function setDefaultPerson(entityId: string | null, home: string = getOpenRigHome()): UpdateParticipantsResult {
  return updateParticipantsFile((file, people) => {
    if (entityId === null) { delete file.default; return file; }
    if (!people.some((person) => person.entityId === entityId)) return `no person "${entityId}" is registered; the default is a registered person`;
    file.default = entityId;
    return file;
  }, home);
}

/** Register or replace a shared-channel participant. `replace` is explicit: an existing channel is never overwritten
 *  silently. */
export function setSharedChannel(
  id: string,
  input: PlacementInput & { displayName: string; channel: SharedChannelBinding },
  opts: { replace?: boolean } = {},
  home: string = getOpenRigHome(),
): UpdateParticipantsResult {
  return updateParticipantsFile((file) => {
    const existing = file.participants[id];
    if (existing && existing.kind !== "shared-channel") return `"${id}" is a person`;
    if (existing && !opts.replace) return `shared channel "${id}" already exists — pass an explicit replace to update it (no silent overwrite)`;
    const entry: SharedChannelEntry = { kind: "shared-channel", displayName: input.displayName, channel: input.channel };
    applyPlacement(entry, input);
    file.participants[id] = entry;
    return file;
  }, home);
}

/** Remove a participant's side-file entry (a shared channel, or a person's placement), and the default if it named
 *  them. With `kind`, only an entry of that kind is removed: `human remove` passes "person", so it never deletes a
 *  shared channel that happens to share the id. */
export function removeParticipantEntry(
  id: string,
  home: string = getOpenRigHome(),
  opts: { kind?: ParticipantEntry["kind"] } = {},
): UpdateParticipantsResult {
  return updateParticipantsFile((file) => {
    if (!opts.kind || file.participants[id]?.kind === opts.kind) delete file.participants[id];
    if (file.default === id && opts.kind !== "shared-channel") delete file.default;
    return file;
  }, home);
}

/** Create or update an organization. Its policy is text agents read. */
export function setOrganization(id: string, input: { name?: string; policy?: string | null }, home: string = getOpenRigHome()): UpdateParticipantsResult {
  return updateParticipantsFile((file) => {
    const current = file.organizations[id];
    const name = input.name ?? current?.name;
    if (!name) return `organization "${id}" is new, so it needs a name`;
    const next: ParticipantOrganization = { name };
    const policy = input.policy === undefined ? current?.policy : input.policy;
    if (policy) next.policy = policy;
    file.organizations[id] = next;
    return file;
  }, home);
}

/** Create or update a group inside an organization. */
export function setGroup(id: string, input: { organization?: string; name?: string; policy?: string | null }, home: string = getOpenRigHome()): UpdateParticipantsResult {
  return updateParticipantsFile((file) => {
    const current = file.groups[id];
    const organization = input.organization ?? current?.organization;
    const name = input.name ?? current?.name;
    if (!organization || !name) return `group "${id}" is new, so it needs an organization and a name`;
    const next: ParticipantGroup = { organization, name };
    const policy = input.policy === undefined ? current?.policy : input.policy;
    if (policy) next.policy = policy;
    file.groups[id] = next;
    return file;
  }, home);
}

// ── Shared channels as addresses (0.7.3 channel conversations): a registered shared channel is a valid `<id>@external`
// destination, and outbound posts to its Slack channel. People keep their own paths.

export interface SharedChannelAddress { entityId: string; address: string; channelId: string; connectorRef: string }

/** Every registered shared channel, as an address. An unreadable participant file lists none (outbound to a channel
 *  then waits, and the queue refuses a new row to it, as for any unknown address). */
export function sharedChannelAddresses(home: string = getOpenRigHome()): SharedChannelAddress[] {
  const side = readParticipantsFile(home);
  if (!side.ok) return [];
  return Object.entries(side.file.participants).flatMap(([id, entry]) => entry.kind === "shared-channel"
    ? [{ entityId: id, address: `${id}@${ADDRESS_DOMAIN}`, channelId: entry.channel.channelId, connectorRef: entry.channel.connectorRef }]
    : []);
}

/** The registered shared channel a session ref names (`<id>@external`), or null. */
export function sharedChannelFor(sessionRef: string | null | undefined, home: string = getOpenRigHome()): SharedChannelAddress | null {
  if (!sessionRef) return null;
  const local = sessionRef.endsWith(`@${ADDRESS_DOMAIN}`) ? sessionRef.slice(0, -(ADDRESS_DOMAIN.length + 1)) : null;
  if (!local) return null;
  return sharedChannelAddresses(home).find((channel) => channel.entityId === local) ?? null;
}
