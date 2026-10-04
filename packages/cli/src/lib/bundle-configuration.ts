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
  const raw = parseYaml(fs.readFileSync(file, "utf-8")) as Record<string, unknown> | null;
  if (!raw || raw["schema"] !== "openrig.bundle-configurations/v1") {
    throw new ConfigurationError(`${file} is not an openrig.bundle-configurations/v1 file`);
  }
  return raw as unknown as DeclaredConfigurations;
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

/**
 * Resolve a preset plus per-seat choices into a full mapping, checked against what the bundle
 * declares. Throws ConfigurationError naming the allowed set when a choice isn't declared.
 */
export function resolveConfiguration(
  declared: DeclaredConfigurations,
  authored: Record<string, string>,
  choice: { preset?: string; seats?: string[] },
): ChosenConfiguration {
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
    const seat = declared.seats[member];
    if (!seat) throw new ConfigurationError(`seat '${member}' can't be changed; seats that can: ${Object.keys(declared.seats).join(", ")}`);
    if (!seat.runtimes[runtime]) throw new ConfigurationError(`seat '${member}' can't use '${runtime}'; it can use: ${Object.keys(seat.runtimes).join(", ")}`);
    mapping[member] = runtime;
  }
  for (const member of Object.keys(authored)) {
    if (!(member in mapping)) throw new ConfigurationError(`the configuration doesn't give member '${member}' a runtime`);
  }
  for (const [member, runtime] of Object.entries(mapping)) {
    if (!(member in authored)) throw new ConfigurationError(`'${member}' isn't a member of this rig`);
    if (runtime !== authored[member] && !declared.seats[member]?.runtimes[runtime]) {
      throw new ConfigurationError(`seat '${member}' can't use '${runtime}'; it can use: ${Object.keys(declared.seats[member]?.runtimes ?? {}).join(", ") || authored[member]}`);
    }
  }
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
 */
export function stageConfiguration(rigDir: string, rigSpecFile: string, declared: DeclaredConfigurations, chosen: ChosenConfiguration): { stagingDir: string; rigSpecPath: string } {
  const stagingDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rig-configuration-"));
  fs.cpSync(rigDir, stagingDir, { recursive: true, filter: (src) => !/(^|[\\/])(\.git|node_modules)$/.test(src) });
  const rigSpecPath = nodePath.join(stagingDir, nodePath.relative(rigDir, rigSpecFile));
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
  fs.writeFileSync(rigSpecPath, doc.toString());
  return { stagingDir, rigSpecPath };
}
