import { describe, it, expect, vi } from "vitest";
import { formatBundleBehaviour, showBundleBehaviourBeforeAction } from "../src/bundle-behaviour.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describeBundleBehaviour } from "../../daemon/src/domain/bundle-behaviour.js";
import { configurationId } from "../../daemon/src/domain/bundle-identity.js";

const view = {
  schema: "openrig.bundle-behaviour/v1" as const,
  state: "not_generated" as const,
  identity: { source: null, configurationId: null, packageDigest: null, assembler: null, generator: { openrigVersion: "0.6.6" }, integrity: { digestValid: true, filesVerified: true } },
  reason: "Not generated for this combination.", localInspectCommand: "rig bundle inspect <archive> --json",
};

describe("before-action bundle view", () => {
  it("prints before the caller's action without writing stdout or a new exit code", async () => {
    const events: string[] = [];
    const before = process.exitCode;
    const inspect = vi.fn(async () => ({ status: 200, data: { behaviour: view } }));
    expect(await showBundleBehaviourBeforeAction(inspect, line => events.push(line))).toEqual(view);
    events.push("apply");
    expect(events.indexOf("apply")).toBe(events.length - 1);
    expect(events[0]).toContain("before installation");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(before);
  });
  it.each([async () => { throw new Error("unavailable"); }, async () => ({ status: 500, data: { error: "unavailable" } })])("keeps view failure diagnostic", async (inspect) => {
    const output = vi.fn();
    const before = process.exitCode;
    expect(await showBundleBehaviourBeforeAction(inspect, output)).toBeUndefined();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Existing installation checks still apply"));
    expect(process.exitCode).toBe(before);
  });
  it("keeps required honest negations and neutralizes terminal controls", () => {
    const lines = formatBundleBehaviour({ ...view, reason: "unknown\u001b[2J\nvalue" });
    expect(lines.join("\n")).toContain("Integrity means the archive is self-consistent, not who made it.");
    expect(lines.join("\n")).toContain("Provenance is stated by the bundle and not verified.");
    expect(lines.some(line => /[\x00-\x1f]/.test(line))).toBe(false);
    expect(lines.join(" ")).not.toMatch(/verified safe|trusted bundle|secure bundle/i);
  });

  it("emits the shared schema for generated and unavailable archive views", () => {
    const schemas = new URL("../../../docs/reference/schemas/", import.meta.url);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const file of ["bundle-common.v1.schema.json", "bundle-behaviour.v1.schema.json"]) {
      ajv.addSchema(JSON.parse(fs.readFileSync(fileURLToPath(new URL(file, schemas)), "utf8")));
    }
    const validate = ajv.getSchema("https://openrig.dev/schemas/bundle-behaviour.v1.json")!;
    const files = new Map([["rig.yaml", "name: demo\nversion: '1'\npods:\n- id: team\n  members:\n  - {id: shell, agent_ref: 'builtin:terminal', profile: none, runtime: terminal, cwd: .}\n"]]);
    const generated = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
    expect(generated.state).toBe("generated");
    for (const record of [generated, view]) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each(["recommended", "all-claude", "all-codex", "all-pi"])("describes the shared synthetic %s configuration, without borrowing another preset", preset => {
    const configurations = parseYaml(fs.readFileSync(new URL("../../../docs/reference/schemas/fixtures/valid/configurations/openrig-dev.configurations.yaml", import.meta.url), "utf8"));
    const mapping = configurations.presets[preset] as Record<string, string>;
    const files = new Map<string, string>();
    const pods = new Map<string, Array<Record<string, unknown>>>();
    for (const [seat, runtime] of Object.entries(mapping)) {
      const [pod, member] = seat.split(".") as [string, string];
      const profile = configurations.seats[seat].runtimes[runtime];
      const root = `agents/${member}`;
      files.set(`${root}/agent.yaml`, stringifyYaml({ name: member, version: "1", profiles: { [profile]: { uses: { guidance: ["role"], plugins: ["core"] } } }, resources: { guidance: [{ id: "role", path: "role.md", merge: "managed_block" }], plugins: [{ id: "core", source: { kind: "local", path: "openrig-home:plugins/core" } }] } }));
      files.set(`${root}/role.md`, `The ${profile} instructions.`);
      const members = pods.get(pod) ?? [];
      members.push({ id: member, agent_ref: `local:${root}`, profile, runtime, cwd: "." });
      pods.set(pod, members);
    }
    files.set("rig.yaml", stringifyYaml({ name: "synthetic-contributor", version: "1", managed_blocks: { "claude-code": "CLAUDE.local.md" }, pods: [...pods].map(([id, members]) => ({ id, members })) }));
    const actual = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml" }, configurationId: configurationId(mapping), generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
    expect(actual.state).toBe("generated");
    if (actual.state !== "generated") throw new Error(actual.reason);
    expect(Object.fromEntries(actual.team.map(member => [member.seat, member.runtime]))).toEqual(mapping);
    expect(actual.identity.configurationId).toBe(configurationId(mapping));
    for (const member of actual.team) {
      expect(member.profile).toBe(configurations.seats[member.seat].runtimes[member.runtime]);
      expect(actual.toldFiles).toEqual(expect.arrayContaining([expect.objectContaining({ seat: member.seat, pathOrRef: `agents/${member.member}/role.md`, resolution: "archive" })]));
      expect(actual.alsoRuns).toEqual(expect.arrayContaining([expect.objectContaining({ seat: member.seat, pathOrRef: "openrig-home:plugins/core", resolution: "host_at_launch" })]));
      expect(actual.posture.find(p => p.seat === member.seat)?.nativeEffect).toBe("unknown");
      if (member.runtime !== "pi") {
        expect(actual.writes).toEqual(expect.arrayContaining([expect.objectContaining({ seat: member.seat, path: member.runtime === "codex" ? "AGENTS.md" : "CLAUDE.local.md" })]));
      } else {
        expect(actual.posture.find(p => p.seat === member.seat)?.selection).toContain("resource trust");
      }
    }
  });
});
