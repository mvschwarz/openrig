import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { parse as parseYaml, parseDocument, isMap, isSeq } from "yaml";
import { configurationId } from "@openrig/daemon/bundle-identity";

/**
 * Declared configurations (docs/reference/bundle-formats.md, bundle-configurations.v1): which runtime
 * each seat may use, the profile each runtime uses, and named presets. The generator applies a chosen
 * mapping to an owned copy of the rig folder, then the one bundler packs it. Nothing here invents a
 * resource: a runtime's differences live in the profile the author named for it.
 */

export const CONFIGURATIONS_FILE = "configurations.yaml";

export interface DeclaredConfigurations {
  recommended: string;
  seats: Record<string, { runtimes: Record<string, string> }>;
  presets: Record<string, Record<string, string>>;
}

export interface ChosenConfiguration {
  /** pod.member -> runtime, for every member. */
  mapping: Record<string, string>;
  configurationId: string;
  /** The preset whose mapping this is, when it matches one exactly. */
  preset?: string;
}

export class ConfigurationError extends Error {}

/** Read configurations.yaml beside rig.yaml. Returns null when the bundle declares none. */
export function readDeclaredConfigurations(rigDir: string): DeclaredConfigurations | null {
  const file = nodePath.join(rigDir, CONFIGURATIONS_FILE);
  if (!fs.existsSync(file)) return null;
  const raw = parseYaml(fs.readFileSync(file, "utf-8")) as unknown;
  if (!isObject(raw) || raw["schema"] !== "openrig.bundle-configurations/v1") {
    throw new ConfigurationError(`${file} is not an openrig.bundle-configurations/v1 file`);
  }
  const problem = shapeProblem(raw);
  if (problem) throw new ConfigurationError(`${file}: ${problem}`);
  return raw as unknown as DeclaredConfigurations;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNameMap = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => typeof x === "string" && x.length > 0);

/** The shape bundle-configurations.v1 requires, so a malformed file is named instead of failing later. */
function shapeProblem(raw: Record<string, unknown>): string | undefined {
  if (typeof raw["recommended"] !== "string" || !raw["recommended"]) return "recommended must name a preset";
  const seats = raw["seats"];
  if (!isObject(seats) || Object.keys(seats).length === 0) return "seats must give at least one pod.member its runtimes";
  for (const [member, seat] of Object.entries(seats)) {
    if (!isObject(seat) || !isNameMap(seat["runtimes"])) return `seats.${member}.runtimes must map each runtime to a profile`;
  }
  const presets = raw["presets"];
  if (!isObject(presets) || Object.keys(presets).length === 0) return "presets must declare at least one preset";
  for (const [name, mapping] of Object.entries(presets)) {
    if (!isNameMap(mapping)) return `presets.${name} must map each pod.member to a runtime`;
  }
  return undefined;
}

/** The runtime each member uses in rig.yaml as authored. */
export function authoredMapping(rigSpecPath: string): Record<string, string> {
  const spec = parseYaml(fs.readFileSync(rigSpecPath, "utf-8")) as { pods?: Array<{ id: string; members?: Array<{ id: string; runtime?: string }> }> };
  const mapping: Record<string, string> = {};
  for (const pod of spec.pods ?? []) for (const member of pod.members ?? []) {
    if (member.runtime) mapping[`${pod.id}.${member.id}`] = member.runtime;
  }
  return mapping;
}

function sameMapping(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** A seat the file lists may use only its declared runtimes; any other seat keeps rig.yaml's runtime. */
function allowedRuntimes(declared: DeclaredConfigurations, authored: Record<string, string>, member: string): string[] {
  const seat = declared.seats[member];
  return seat ? Object.keys(seat.runtimes) : [authored[member]!];
}

/** Every member gets a runtime it may use, and nothing that isn't a member is named. */
function checkMapping(declared: DeclaredConfigurations, authored: Record<string, string>, mapping: Record<string, string>, what: string): void {
  for (const member of Object.keys(authored)) {
    if (!(member in mapping)) throw new ConfigurationError(`${what} doesn't give member '${member}' a runtime`);
  }
  for (const [member, runtime] of Object.entries(mapping)) {
    if (!(member in authored)) throw new ConfigurationError(`${what} names '${member}', which isn't a member of this rig`);
    const allowed = allowedRuntimes(declared, authored, member);
    if (!allowed.includes(runtime)) throw new ConfigurationError(`${what}: seat '${member}' can't use '${runtime}'; it can use: ${allowed.join(", ")}`);
  }
}

/**
 * Check a declaration against rig.yaml as written: every seat it lists is a member, every preset
 * stays within the declared runtimes, and the recommended preset is rig.yaml's own mapping, so
 * building it gives the authored package. Create, `rig bundle configurations` and `rig bundle check`
 * share this check. Throws ConfigurationError naming the first problem.
 */
export function checkDeclaredConfigurations(declared: DeclaredConfigurations, authored: Record<string, string>): void {
  for (const member of Object.keys(declared.seats)) {
    if (!(member in authored)) throw new ConfigurationError(`seats names '${member}', which isn't a member of this rig`);
  }
  const recommended = declared.presets[declared.recommended];
  if (!recommended) throw new ConfigurationError(`recommended names '${declared.recommended}', which isn't a declared preset; declared presets: ${Object.keys(declared.presets).join(", ")}`);
  for (const [name, mapping] of Object.entries(declared.presets)) checkMapping(declared, authored, mapping, `preset '${name}'`);
  if (!sameMapping(recommended, authored)) {
    throw new ConfigurationError(`the recommended preset '${declared.recommended}' must be rig.yaml as written (${configurationId(authored)}), but it is ${configurationId(recommended)}`);
  }
}

/**
 * Resolve a preset plus per-seat choices into a full mapping, checked against what the bundle
 * declares. Throws ConfigurationError naming the allowed set when a choice isn't declared.
 */
export function resolveConfiguration(
  declared: DeclaredConfigurations,
  authored: Record<string, string>,
  choice: { preset?: string; seats?: string[] },
): ChosenConfiguration {
  checkDeclaredConfigurations(declared, authored);
  let mapping: Record<string, string>;
  if (choice.preset !== undefined) {
    const preset = declared.presets[choice.preset];
    if (!preset) throw new ConfigurationError(`preset '${choice.preset}' isn't declared; declared presets: ${Object.keys(declared.presets).join(", ")}`);
    mapping = { ...preset };
  } else {
    mapping = { ...authored };
  }
  for (const seatChoice of choice.seats ?? []) {
    const match = /^([^=]+)=([^=]+)$/.exec(seatChoice);
    if (!match) throw new ConfigurationError(`--seat expects pod.member=runtime, got '${seatChoice}'`);
    const [, member, runtime] = match as unknown as [string, string, string];
    if (!(member in authored)) throw new ConfigurationError(`'${member}' isn't a member of this rig`);
    // The same rule a preset meets: a listed seat uses its declared runtimes, any other keeps rig.yaml's
    if (!allowedRuntimes(declared, authored, member).includes(runtime)) {
      throw new ConfigurationError(declared.seats[member]
        ? `seat '${member}' can't use '${runtime}'; it can use: ${Object.keys(declared.seats[member].runtimes).join(", ")}`
        : `seat '${member}' can't be changed; seats that can: ${Object.keys(declared.seats).join(", ")}`);
    }
    mapping[member] = runtime;
  }
  checkMapping(declared, authored, mapping, "the configuration");
  const preset = Object.entries(declared.presets).find(([, m]) => sameMapping(m, mapping))?.[0];
  return { mapping, configurationId: configurationId(mapping), ...(preset ? { preset } : {}) };
}

/** Every declared preset with its configuration ID, and which preset is rig.yaml as authored. */
export function listConfigurations(declared: DeclaredConfigurations, authored: Record<string, string>) {
  return Object.entries(declared.presets).map(([name, mapping]) => ({
    preset: name,
    configurationId: configurationId(mapping),
    recommended: name === declared.recommended,
    authored: sameMapping(mapping, authored),
  }));
}

/**
 * Copy the rig folder to a new owned directory and apply the chosen runtime and profile to every
 * member whose runtime changes, so the author's folder is never modified. Returns the copy's rig.yaml.
 * Links are copied as the files they point to, so nothing in the copy leads back to the author's
 * files. If staging fails, the copy is removed and a ConfigurationError says why.
 */
export function stageConfiguration(rigDir: string, rigSpecFile: string, declared: DeclaredConfigurations, chosen: ChosenConfiguration): { stagingDir: string; rigSpecPath: string } {
  const specInRig = nodePath.relative(rigDir, rigSpecFile);
  if (!specInRig || specInRig === ".." || specInRig.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(specInRig)) {
    throw new ConfigurationError(`${rigSpecFile} isn't inside the rig folder ${rigDir}, so a configuration can't be staged from it`);
  }
  const stagingDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rig-configuration-"));
  try {
    fs.cpSync(rigDir, stagingDir, { recursive: true, dereference: true, filter: (src) => !/(^|[\\/])(\.git|node_modules)$/.test(src) });
    const rigSpecPath = nodePath.join(stagingDir, specInRig);
    const doc = parseDocument(fs.readFileSync(rigSpecPath, "utf-8"));
    const pods = doc.get("pods");
    if (isSeq(pods)) for (const pod of pods.items) {
      if (!isMap(pod)) continue;
      const members = pod.get("members");
      if (!isSeq(members)) continue;
      for (const member of members.items) {
        if (!isMap(member)) continue;
        const key = `${pod.get("id")}.${member.get("id")}`;
        const runtime = chosen.mapping[key];
        if (!runtime || runtime === member.get("runtime")) continue;
        member.set("runtime", runtime);
        const profile = declared.seats[key]?.runtimes[runtime];
        if (profile) member.set("profile", profile);
      }
    }
    // Replace rather than write in place, so the write can only ever land in the copy
    fs.rmSync(rigSpecPath, { force: true });
    fs.writeFileSync(rigSpecPath, doc.toString());
    return { stagingDir, rigSpecPath };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (err instanceof ConfigurationError) throw err;
    throw new ConfigurationError(`couldn't stage a copy of ${rigDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
