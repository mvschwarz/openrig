// OPR gateway M1 A3 — human specs: file-per-human FRAGMENTS + a GENERATED registry
// projection. Schema sealed in GATEWAY-M1-A3-ENTITY-SCHEMA (b2a2594b, supersedes
// e499dab6): prefs are PER-ENTITY (loudness once per human) and `role` is PER-BINDING
// (routing / default delivery channel) — two DISTINCT axes.
//
// TRUTH MODEL (design-record §7 / plan §1): each human is one YAML fragment at
// <home>/gateway/humans/<entityId>.yaml. The registry is a GENERATED PROJECTION of
// the fragments (humans.generated.yaml) — NEVER hand-edited; the fragment is truth.
// The projection carries a DO-NOT-EDIT header and a drift pin (mirrors the
// attestation-lineage.generated codegen convention). Admission/resolution is the
// A1/A4 gateway's job — this module only owns the fragment + projection contract.
//
// Validation is add-time == load-time (the hosts-registry entry pattern): the SAME
// validateHumanFragment runs on `add` and on load, so a present-but-invalid fragment
// is a loud error, never silently projected.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getOpenRigHome } from "../../openrig-compat.js";

// ── Schema (closed enums; extend only additively behind the contract) ──
export const HUMAN_ENTITY_CLASSES = new Set(["human"]);          // M1's only class
export const HUMAN_CONNECTOR_KINDS = new Set(["slack"]);          // M1's only kind
export const HUMAN_BINDING_ROLES = new Set(["primary", "secondary"]);
export const HUMAN_DELIVERY_CLASSES = new Set(["A", "B", "C", "D"]);
// entityId is the fragment key + filename: a stable slug that survives platform
// renames. Lowercase alnum + separators, no path chars (it is spliced into a path).
export const ENTITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
// The registered @external ref shape (the section2 registered mode). A registry
// fragment's address is <entityId>@external by convention; literal-scheme addresses
// (slack:U...@external) are one-off ADDRESSES, never registry entries.
export const ADDRESS_DOMAIN = "external";

// Closed key sets — a typo'd field must fail LOUD, never silently degrade behavior.
const ALLOWED_FRAGMENT_KEYS = new Set(["entityId", "class", "displayName", "address", "connectorBindings", "prefs"]);
const ALLOWED_BINDING_KEYS = new Set(["kind", "connectorRef", "secretsRef", "role", "handle"]);
// A connector handle (M1 A6 v3 schema 9e468b2f): the platform-native id of the human ON that
// connector (e.g. a Slack user id). Constrained so it can never forge a session ref (no ':' / '@'
// / whitespace) — it is compared to an inbound sender id and spliced into teaching text.
export const HANDLE_PATTERN = /^[A-Za-z0-9._-]+$/;
const ALLOWED_PREFS_KEYS = new Set(["deliveryClass", "away"]);
function unknownKey(obj: Record<string, unknown>, allowed: Set<string>): string | undefined {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return k;
  return undefined;
}

export interface HumanConnectorBinding {
  kind: "slack";
  connectorRef: string;
  /** POINTER at the connector's vault (secrets-on-connector) — NEVER the secret. */
  secretsRef: string;
  /** Per-BINDING routing: EXACTLY ONE primary per entity = the default channel. */
  role: "primary" | "secondary";
  /** A6 v3: the platform-native id of this human on the connector (e.g. Slack user id).
   *  OPTIONAL — a handle-less binding is OUTBOUND-ONLY (delivery works; it is NOT
   *  inbound-resolvable, so an inbound event on it fails admission LOUDLY). REQUIRED to be
   *  inbound-resolvable. UNIQUE per kind across ALL bindings of ALL humans (one platform id =
   *  exactly one human; a duplicate is a registration conflict, REFUSED). */
  handle?: string;
}

export interface HumanPrefs {
  /** Per-ENTITY loudness — a SELECTION from the notifications register (spec §6);
   *  A3 carries it, never redefines it. Forward-compatible if the register grows. */
  deliveryClass: "A" | "B" | "C" | "D";
  /** The AWAY preset (optional). */
  away?: boolean;
}

export interface HumanFragment {
  entityId: string;
  class: "human";
  displayName: string;
  /** The registered @external ref, = <entityId>@external by convention. */
  address: string;
  connectorBindings: HumanConnectorBinding[];
  prefs: HumanPrefs;
}

export type ValidateResult =
  | { ok: true; fragment: HumanFragment }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** add-time == load-time validation. Returns the typed fragment or a loud error.
 *  Structural + closed-enum + the two cross-field invariants (>=1 binding,
 *  exactly-one-primary-per-entity). Does NOT touch the filesystem. */
export function validateHumanFragment(raw: unknown): ValidateResult {
  if (!isObj(raw)) return { ok: false, error: "human fragment must be a mapping" };
  const uk = unknownKey(raw, ALLOWED_FRAGMENT_KEYS);
  if (uk) return { ok: false, error: `unknown fragment key "${uk}" — allowed: ${[...ALLOWED_FRAGMENT_KEYS].join(", ")} (a typo must not silently degrade)` };
  const { entityId, class: cls, displayName, address, connectorBindings, prefs } = raw;

  if (typeof entityId !== "string" || !ENTITY_ID_PATTERN.test(entityId)) {
    return { ok: false, error: `entityId "${String(entityId)}" must be a lowercase slug (a-z0-9._- , no leading/trailing separator)` };
  }
  if (cls !== "human") {
    return { ok: false, error: `class "${String(cls)}" is not a known entity class (M1: ${[...HUMAN_ENTITY_CLASSES].join(", ")})` };
  }
  if (typeof displayName !== "string" || displayName.length === 0) {
    return { ok: false, error: "displayName must be a non-empty string" };
  }
  if (typeof address !== "string" || address.length === 0) {
    return { ok: false, error: "address must be a non-empty string (the registered @external ref)" };
  }
  // Registered-mode pin: the address is <entityId>@external (collision-free, ties the
  // ref to the fragment key). Not a loose @external match — mike@externalx is NOT a ref.
  if (address !== `${entityId}@${ADDRESS_DOMAIN}`) {
    return { ok: false, error: `address "${address}" must be the registered ref "${entityId}@${ADDRESS_DOMAIN}" (the <entityId>@external convention)` };
  }
  if (!Array.isArray(connectorBindings) || connectorBindings.length < 1) {
    return { ok: false, error: "connectorBindings must be a non-empty list (>=1)" };
  }

  const bindings: HumanConnectorBinding[] = [];
  let primaryCount = 0;
  for (let i = 0; i < connectorBindings.length; i++) {
    const b = connectorBindings[i];
    if (!isObj(b)) return { ok: false, error: `connectorBindings[${i}] must be a mapping` };
    const ubk = unknownKey(b, ALLOWED_BINDING_KEYS);
    if (ubk) return { ok: false, error: `connectorBindings[${i}] has unknown key "${ubk}" — allowed: ${[...ALLOWED_BINDING_KEYS].join(", ")}` };
    if (!HUMAN_CONNECTOR_KINDS.has(String(b.kind))) {
      return { ok: false, error: `connectorBindings[${i}].kind "${String(b.kind)}" is not a known connector kind (M1: ${[...HUMAN_CONNECTOR_KINDS].join(", ")})` };
    }
    if (typeof b.connectorRef !== "string" || b.connectorRef.length === 0) {
      return { ok: false, error: `connectorBindings[${i}].connectorRef must be a non-empty string` };
    }
    if (typeof b.secretsRef !== "string" || b.secretsRef.length === 0) {
      return { ok: false, error: `connectorBindings[${i}].secretsRef must be a non-empty vault POINTER (never the secret)` };
    }
    if (!HUMAN_BINDING_ROLES.has(String(b.role))) {
      return { ok: false, error: `connectorBindings[${i}].role "${String(b.role)}" must be primary|secondary` };
    }
    if (b.role === "primary") primaryCount++;
    // A6 v3: handle is OPTIONAL; when present it must be a clean platform id (ref-forgery-safe).
    let handle: string | undefined;
    if (b.handle !== undefined) {
      if (typeof b.handle !== "string" || !HANDLE_PATTERN.test(b.handle)) {
        return { ok: false, error: `connectorBindings[${i}].handle "${String(b.handle)}" must match ${HANDLE_PATTERN} (a platform id — no ':' '@' or whitespace, which could forge a ref)` };
      }
    }
    const binding: HumanConnectorBinding = { kind: "slack", connectorRef: b.connectorRef, secretsRef: b.secretsRef, role: b.role as "primary" | "secondary" };
    if (b.handle !== undefined) { handle = b.handle as string; binding.handle = handle; }
    bindings.push(binding);
  }
  // EXACTLY ONE primary binding per entity = the default delivery channel.
  if (primaryCount !== 1) {
    return { ok: false, error: `exactly one connectorBinding must have role "primary" (found ${primaryCount}) — it is the default delivery channel` };
  }
  // A6 v3 pin-1 (within-fragment): a handle is UNIQUE per kind across this human's bindings —
  // one human must not claim the same platform id twice. (Cross-fragment uniqueness is enforced
  // in projectHumans, which sees every human at once.)
  const seenHandles = new Set<string>();
  for (const b of bindings) {
    if (b.handle === undefined) continue;
    const key = `${b.kind}:${b.handle}`;
    if (seenHandles.has(key)) {
      return { ok: false, error: `duplicate ${b.kind} handle "${b.handle}" across this human's bindings — a handle is unique per kind (one platform id = one human)` };
    }
    seenHandles.add(key);
  }

  if (!isObj(prefs)) return { ok: false, error: "prefs must be a mapping { deliveryClass, away? }" };
  const upk = unknownKey(prefs, ALLOWED_PREFS_KEYS);
  if (upk) return { ok: false, error: `prefs has unknown key "${upk}" — allowed: ${[...ALLOWED_PREFS_KEYS].join(", ")} (the notifications register selection)` };
  if (!HUMAN_DELIVERY_CLASSES.has(String(prefs.deliveryClass))) {
    return { ok: false, error: `prefs.deliveryClass "${String(prefs.deliveryClass)}" must be one of A|B|C|D (the notifications register)` };
  }
  if (prefs.away !== undefined && typeof prefs.away !== "boolean") {
    return { ok: false, error: "prefs.away must be a boolean when present" };
  }
  const validatedPrefs: HumanPrefs = { deliveryClass: prefs.deliveryClass as HumanPrefs["deliveryClass"] };
  if (prefs.away !== undefined) validatedPrefs.away = prefs.away;

  return {
    ok: true,
    fragment: { entityId, class: "human", displayName, address, connectorBindings: bindings, prefs: validatedPrefs },
  };
}

// ── Paths (under getOpenRigHome(); `home` injectable for hermetic tests) ──
export function humansDir(home: string = getOpenRigHome()): string {
  return join(home, "gateway", "humans");
}
export function projectionPath(home: string = getOpenRigHome()): string {
  return join(home, "gateway", "humans.generated.yaml");
}

/** The default HUMAN operator identity — the fallback HUMAN when admission resolves no
 *  addressable entity. NOT a fragment (never an entities[] entry) and NOT the inbound
 *  routing destination (that is the operator-AGENT operator-agent@kernel, which has its
 *  own home in the slack connector config — a different seat). Named with the human-seat
 *  PREFIX convention so it classifies as human-CLASS (isHumanSeatSessionRef); the parity
 *  test pins that, killing the '-human'-suffix footgun class. Canonical home for this
 *  constant — external-admission.ts imports it (ONE source, no dup). */
export const OPERATOR_HUMAN_DEFAULT_SLOT = "human-operator@kernel";

const PROJECTION_HEADER =
  "# GENERATED FILE — DO NOT EDIT.\n" +
  "# Projection of the human fragments under gateway/humans/<entityId>.yaml.\n" +
  "# The fragment is truth: add/edit a human via its fragment (or `rig gateway human\n" +
  "# add`), then re-project. A hand-edit here is REFUSED at load.\n";

export type ProjectResult =
  | { ok: true; body: string; entities: HumanFragment[] }
  | { ok: false; error: string };

/** Generate the canonical registry projection from the fragments (the ONE generator
 *  used by both the write path and the drift/load check). Load-time validation is the
 *  SAME validateHumanFragment as add-time; the filename must equal <entityId>.yaml
 *  (collision-free key). Entities are sorted by entityId for a stable, diffable body. */
export function projectHumans(home: string = getOpenRigHome()): ProjectResult {
  const dir = humansDir(home);
  const entities: HumanFragment[] = [];
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith(".")).sort();
    for (const f of files) {
      let raw: unknown;
      try {
        raw = parseYaml(readFileSync(join(dir, f), "utf8"));
      } catch (err) {
        return { ok: false, error: `failed to parse human fragment ${f}: ${(err as Error).message}` };
      }
      const v = validateHumanFragment(raw);
      if (!v.ok) return { ok: false, error: `invalid human fragment ${f}: ${v.error}` };
      if (`${v.fragment.entityId}.yaml` !== f) {
        return { ok: false, error: `human fragment ${f} declares entityId "${v.fragment.entityId}" — the filename must be <entityId>.yaml` };
      }
      entities.push(v.fragment);
    }
  }
  entities.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  // A6 v3 pin-1 (cross-fragment): a handle is UNIQUE per kind across ALL humans — one platform
  // id maps to exactly one human, so the inbound resolver is unambiguous. A collision between two
  // fragments is a registration conflict, REFUSED at projection (so add/load/drift all catch it).
  const handleOwner = new Map<string, string>();
  for (const e of entities) {
    for (const b of e.connectorBindings) {
      if (b.handle === undefined) continue;
      const key = `${b.kind}:${b.handle}`;
      const prior = handleOwner.get(key);
      if (prior !== undefined && prior !== e.entityId) {
        return { ok: false, error: `${b.kind} handle "${b.handle}" is claimed by both "${prior}" and "${e.entityId}" — a handle maps to exactly one human (registration conflict)` };
      }
      handleOwner.set(key, e.entityId);
    }
  }
  return { ok: true, body: PROJECTION_HEADER + stringifyYaml({ entities }), entities };
}

export type SlackHandleResolution =
  | { kind: "registered"; entityId: string; address: string }
  | { kind: "unregistered"; handle: string; error: string };

/** A6 v3 pins 2+3 — resolve an INBOUND connector handle to its registered human. Walks every
 *  human's bindings of `connectorKind` for one whose `handle` equals `handle`:
 *   - a match          -> registered (admit as that entity; its address is the human-class source)
 *   - no match         -> unregistered LOUD teaching (admit-iff-registered — never fabricate a
 *                         human seat from a raw platform id; a handle-LESS binding is outbound-only
 *                         and simply never matches, so it fails inbound here, loudly).
 *  Cross-fragment uniqueness (projectHumans) guarantees at most one match. */
export function resolveSlackHandle(
  handle: string,
  entities: readonly HumanFragment[],
  connectorKind: "slack" = "slack",
): SlackHandleResolution {
  for (const e of entities) {
    for (const b of e.connectorBindings) {
      if (b.kind === connectorKind && b.handle !== undefined && b.handle === handle) {
        return { kind: "registered", entityId: e.entityId, address: e.address };
      }
    }
  }
  return {
    kind: "unregistered",
    handle,
    error:
      `inbound ${connectorKind} sender "${handle}" is not a registered human (no binding with handle "${handle}"). ` +
      `Register the human + their handle first: rig gateway human add <entityId> --display-name … ` +
      `--binding ${connectorKind}:<connectorRef>:<secretsRef>:primary:handle=${handle} --delivery-class …; ` +
      `until then this message is REFUSED (it was NOT landed as a fabricated human seat).`,
  };
}

function atomicWrite(path: string, body: string): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to write ${path}: ${(err as Error).message}` };
  }
}

/** (Re)write the generated projection from the current fragments. Atomic. */
export function writeProjection(home: string = getOpenRigHome()): { ok: true; path: string } | { ok: false; error: string } {
  const proj = projectHumans(home);
  if (!proj.ok) return { ok: false, error: proj.error };
  const path = projectionPath(home);
  const w = atomicWrite(path, proj.body);
  return w.ok ? { ok: true, path } : w;
}

export type AddHumanResult =
  | { ok: true; path: string; fragment: HumanFragment }
  | { ok: false; error: string };

/** The verb-add writer: validate (add-time) -> atomic write the ONE fragment file ->
 *  re-project. Operators never hand-create the fragment YAML; the verb owns it.
 *  NO SILENT CLOBBER (mirrors hosts-registry addHostEntry): an existing entityId is
 *  REFUSED unless `replace` is passed explicitly — a re-run must not silently replace
 *  a human's data (managed-config data-safety class). */
export function addHumanFragment(
  raw: unknown,
  home: string = getOpenRigHome(),
  opts: { replace?: boolean } = {},
): AddHumanResult {
  const v = validateHumanFragment(raw);
  if (!v.ok) return { ok: false, error: v.error };
  const file = join(humansDir(home), `${v.fragment.entityId}.yaml`);
  if (!opts.replace && existsSync(file)) {
    return { ok: false, error: `human "${v.fragment.entityId}" already exists at ${file} — pass an explicit replace to update it (no silent overwrite)` };
  }
  // A6 v3 pin-1: reject a handle already claimed by a DIFFERENT human BEFORE writing (never leave a
  // conflicting fragment on disk with a failed re-projection). projectHumans is the load-time backstop.
  const existing = projectHumans(home);
  if (!existing.ok) return { ok: false, error: `cannot validate handle uniqueness — existing registry is invalid: ${existing.error}` };
  const claimed = new Map<string, string>();
  for (const e of existing.entities) {
    if (e.entityId === v.fragment.entityId) continue; // a replace of the same human is fine
    for (const b of e.connectorBindings) if (b.handle !== undefined) claimed.set(`${b.kind}:${b.handle}`, e.entityId);
  }
  for (const b of v.fragment.connectorBindings) {
    if (b.handle === undefined) continue;
    const owner = claimed.get(`${b.kind}:${b.handle}`);
    if (owner !== undefined) {
      return { ok: false, error: `${b.kind} handle "${b.handle}" is already registered to human "${owner}" — a handle maps to exactly one human (registration conflict)` };
    }
  }
  const w = atomicWrite(file, stringifyYaml(v.fragment));
  if (!w.ok) return { ok: false, error: w.error };
  const proj = writeProjection(home);
  if (!proj.ok) return { ok: false, error: `fragment written but re-projection failed: ${proj.error}` };
  return { ok: true, path: file, fragment: v.fragment };
}

// ── S12 lifecycle beyond add: list / show / set / remove (OPR.0.5.5.12) ──
// RED commit: surfaces declared UNWIRED so the pins run and fail at the behavior
// layer (never module-not-found). GREEN implements them through the same
// fragment->validate->atomic-write->re-project spine as add.

/** One in-flight item standing between a human and a clean remove. The registry does not
 *  own the sources (queue rows live behind the daemon; conversations in the dispatch
 *  buffer) — callers assemble the list; `pendingConversationsFor` covers the buffer half. */
export interface InflightItem {
  kind: "open-conversation" | "queue-row";
  id: string;
  detail: string;
}

export interface HumanBindingsSummary {
  count: number;
  primary: { kind: string; connectorRef: string };
  /** true iff any binding carries a handle (outbound-only otherwise). */
  inboundResolvable: boolean;
}

export interface HumanSummary {
  entityId: string;
  displayName: string;
  address: string;
  deliveryClass: HumanPrefs["deliveryClass"];
  /** EFFECTIVE availability preset (default false when unauthored). */
  away: boolean;
  bindings: HumanBindingsSummary;
  fragmentPath: string;
}

export type ListHumansResult =
  | { ok: true; humans: HumanSummary[] }
  | { ok: false; error: string };

/** A field value with its provenance: authored in the fragment, or filled by a default. */
export interface ProvenancedValue<T> {
  value: T;
  source: "authored" | "default";
}

export interface EffectiveHumanRecord {
  entityId: string;
  address: string;
  displayName: string;
  fragmentPath: string;
  prefs: {
    deliveryClass: ProvenancedValue<HumanPrefs["deliveryClass"]>;
    away: ProvenancedValue<boolean>;
  };
  connectorBindings: Array<HumanConnectorBinding & { inboundResolvable: boolean }>;
}

export type ShowHumanResult =
  | { ok: true; record: EffectiveHumanRecord }
  | { ok: false; error: string };

export type SetHumanFieldResult =
  | { ok: true; path: string; fragment: HumanFragment }
  | { ok: false; error: string };

export type RemoveHumanResult =
  | { ok: true; removed: string; archivedPath: string; orphanRecordPath?: string }
  | { ok: false; error: string; inflight?: InflightItem[] };

export function listHumans(home: string = getOpenRigHome()): ListHumansResult {
  void home;
  return { ok: false, error: "not implemented (S12 RED)" };
}

export function showHuman(entityId: string, home: string = getOpenRigHome()): ShowHumanResult {
  void entityId; void home;
  return { ok: false, error: "not implemented (S12 RED)" };
}

export function setHumanField(
  entityId: string,
  field: string,
  value: string,
  home: string = getOpenRigHome(),
): SetHumanFieldResult {
  void entityId; void field; void value; void home;
  return { ok: false, error: "not implemented (S12 RED)" };
}

export function removeHumanFragment(
  entityId: string,
  opts: { force?: boolean; inflight: InflightItem[] },
  home: string = getOpenRigHome(),
): RemoveHumanResult {
  void entityId; void opts; void home;
  return { ok: false, error: "not implemented (S12 RED)" };
}

export function pendingConversationsFor(entityId: string, home: string = getOpenRigHome()): InflightItem[] {
  void entityId; void home;
  return [];
}

export type LoadResult =
  | { ok: true; entities: HumanFragment[] }
  | { ok: false; error: string };

/** Load the registry via the projection, but REFUSE a hand-edited/drifted projection:
 *  the fragments are truth, so the on-disk projection must byte-match a fresh one.
 *  This is the drift pin's runtime half (the vitest parity pin is the CI half). */
export function loadHumanRegistry(home: string = getOpenRigHome()): LoadResult {
  const proj = projectHumans(home);
  if (!proj.ok) return { ok: false, error: proj.error };
  const path = projectionPath(home);
  if (!existsSync(path)) {
    return { ok: false, error: `registry projection missing at ${path} — re-project from the fragments` };
  }
  if (readFileSync(path, "utf8") !== proj.body) {
    return { ok: false, error: `registry projection at ${path} is HAND-EDITED or DRIFTED from the fragments — the fragment is truth; re-project, never hand-edit` };
  }
  return { ok: true, entities: proj.entities };
}
