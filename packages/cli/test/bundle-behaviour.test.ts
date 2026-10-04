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
    const generated = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml", preconditions: [{ name: "Prepare the source clone", commands: ["cd openrig", "npm ci", "npm run build"] }] }, generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
    expect(generated.state).toBe("generated");
    for (const record of [generated, view]) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    }
    if (generated.state !== "generated") throw new Error(generated.reason);
    expect(generated.needs).toContainEqual({ kind: "precondition", name: "Prepare the source clone", commands: ["cd openrig", "npm ci", "npm run build"], status: "not_checked", sourceRefs: [{ path: "bundle.yaml", field: "preconditions[0]" }] });
    const rendered = formatBundleBehaviour(generated).join("\n");
    expect(rendered).toContain("Prepare the source clone");
    expect(rendered).toContain("Author setup commands (not run; one shell, in order):\n      cd openrig\n      npm ci\n      npm run build");
    const oldGenerator = structuredClone(generated);
    delete oldGenerator.posture[0]!.permissionPrompts;
    expect(validate(oldGenerator), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...generated, posture: [{ ...generated.posture[0], permissionPrompts: "not-stated" }] })).toBe(false);
  });

  it("renders a large setup command list without losing the whole view to the argument limit", () => {
    const files = new Map([["rig.yaml", "name: demo\nversion: '1'\npods:\n- id: team\n  members:\n  - {id: shell, agent_ref: 'builtin:terminal', profile: none, runtime: terminal, cwd: .}\n"]]);
    const commands = Array.from({ length: 200_000 }, (_, index) => `echo ${index}`);
    const generated = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml", preconditions: [{ name: "Author setup", commands }] }, generator: { openrigVersion: "test" }, digestValid: true, filesVerified: true });
    expect(generated.state).toBe("generated");
    const lines = formatBundleBehaviour(generated);
    const start = lines.indexOf("    Author setup commands (not run; one shell, in order):") + 1;
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start, start + commands.length)).toEqual(commands.map(command => `      ${command}`));
    expect(lines[start + commands.length]).toBe("Unknown before launch:");
  });

  it("labels repeated per-seat facts in inspect and previews while preserving global and older entries", async () => {
    const seats = ["build.lead", "build.impl"];
    const files = new Map([
      ["rig.yaml", stringifyYaml({ name: "team", version: "1", pods: [{ id: "build", members: ["lead", "impl"].map(id => ({ id, runtime: "codex", agent_ref: "local:agent", profile: "default", cwd: ".", starter_ref: "previous" })) }], services: { kind: "compose", compose_file: "compose.yaml" } })],
      ["agent/agent.yaml", "name: worker\nversion: '1'\nprofiles: {default: {uses: {plugins: [core]}}}\nresources:\n  plugins:\n  - {id: core, source: {kind: local, path: 'openrig-home:plugins/core'}}\n"],
      ["compose.yaml", "services: {}\n"],
    ]);
    const generated = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml", preconditions: [{ name: "Prepare the source clone" }], compatibility: { min_cli_version: "0.6.6" } }, generator: { openrigVersion: "test" }, digestValid: true, filesVerified: true });
    expect(generated.state).toBe("generated");
    if (generated.state !== "generated") throw new Error(generated.reason);
    expect(generated.needs.filter(n => n.kind === "runtime" || n.kind === "login").map(n => n.seat)).toEqual([seats[0], seats[0], seats[1], seats[1]]);
    expect(generated.alsoRuns.filter(f => f.kind === "plugins").map(f => f.seat)).toEqual(seats);
    const hostUnknowns = generated.unknownBeforeLaunch.filter(u => u.subject === "openrig-home:plugins/core");
    expect(hostUnknowns.map(u => u.seat)).toEqual(seats);
    for (const need of generated.needs.filter(n => ["precondition", "tool", "version"].includes(n.kind))) expect(need).not.toHaveProperty("seat");
    const before = structuredClone(generated);
    const lines = formatBundleBehaviour(generated);
    for (const seat of seats) {
      expect(lines).toContain(`  ${seat}: codex`);
      expect(lines).toContain(`  ${seat}: codex: the user's own runtime account or provider configuration`);
      expect(lines.some(line => line.startsWith(`  ${seat}: plugins: openrig-home:plugins/core [`))).toBe(true);
      expect(lines.some(line => line.startsWith(`  ${seat}: openrig-home:plugins/core: Resolved on the installing host`))).toBe(true);
      expect(lines).toContain(`  ${seat}: Prior conversation, starter and rebuild inputs are resolved at launch.`);
      expect(lines.join("\n")).not.toContain(`${seat}: ${seat}:`);
    }
    expect(lines).toContain("  Prepare the source clone");
    expect(lines).toContain("  Docker Compose and the declared services");
    expect(lines).toContain("  OpenRig CLI >=0.6.6");
    const preview: string[] = [];
    expect(await showBundleBehaviourBeforeAction(async () => ({ status: 200, data: { behaviour: generated } }), line => preview.push(line))).toEqual(generated);
    expect(preview).toEqual(lines);
    expect(generated).toEqual(before);

    const schemas = new URL("../../../docs/reference/schemas/", import.meta.url);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const file of ["bundle-common.v1.schema.json", "bundle-behaviour.v1.schema.json"]) ajv.addSchema(JSON.parse(fs.readFileSync(new URL(file, schemas), "utf8")));
    const validate = ajv.getSchema("https://openrig.dev/schemas/bundle-behaviour.v1.json")!;
    expect(validate(generated), JSON.stringify(validate.errors)).toBe(true);
    const older = structuredClone(generated);
    for (const item of [...older.needs, ...older.unknownBeforeLaunch, ...older.alsoRuns]) delete item.seat;
    expect(validate(older), JSON.stringify(validate.errors)).toBe(true);
    const olderLines = formatBundleBehaviour(older);
    expect(olderLines).toContain("  codex");
    expect(olderLines.some(line => line.startsWith("  plugins: openrig-home:plugins/core ["))).toBe(true);
    expect(olderLines.some(line => line.startsWith("  openrig-home:plugins/core: Resolved on the installing host"))).toBe(true);
    expect(olderLines.join("\n")).not.toContain("undefined:");
  });

  it.each(["rig", "member"])("states declared %s-level yolo plainly for Claude, Codex and Pi", location => {
    const members = ["claude-code", "codex", "pi"].map(runtime => ({
      id: runtime, runtime, agent_ref: "local:agent", profile: "default", cwd: ".",
      ...(location === "member" ? { permission_policy: "builtin:yolo" } : {}),
    }));
    const files = new Map([
      ["rig.yaml", stringifyYaml({ name: "mixed", version: "1", ...(location === "rig" ? { permission_policy: "builtin:yolo" } : {}), pods: [{ id: "team", members }] })],
      ["agent/agent.yaml", "name: worker\nversion: '1'\nprofiles: {default: {uses: {}}}\n"],
    ]);
    const actual = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
    expect(actual.state).toBe("generated");
    if (actual.state !== "generated") throw new Error(actual.reason);
    const declarations = [
      "Permission prompts: off; Claude bypasses permissions",
      "Permission prompts: off; Codex runs with full access and never asks",
      "Permission prompts: off; Pi gets full resource trust",
    ];
    expect(actual.posture).toHaveLength(3);
    for (const [index, declaration] of declarations.entries()) {
      expect(actual.posture[index]).toMatchObject({ basis: "explicit", permissionPrompts: "off", nativeEffect: "unknown", selection: expect.stringContaining(declaration) });
    }
    const lines = formatBundleBehaviour(actual);
    const start = lines.indexOf("Permission posture:");
    expect(start).toBeGreaterThan(0);
    expect(lines[start + 1]).toBe("Permission prompts: off for all seats (archive declaration).");
    declarations.forEach((declaration, index) => expect(lines[start + index + 2]).toContain(declaration));
    expect(lines[start + 5]).toContain("subject to runtime and host policy");
    expect(actual.unknownBeforeLaunch.some(item => item.subject === "host and native settings")).toBe(true);
  });

  it("does not label a member override, a default or an unresolved policy as prompts off", () => {
    for (const [rigPolicy, memberPolicy, basis, permissionPrompts] of [
      ["builtin:yolo", "builtin:standard", "explicit", undefined],
      [undefined, undefined, "product_default", "default"],
      ["missing-policy.md", undefined, "unresolved", undefined],
    ] as const) {
      const files = new Map([
        ["rig.yaml", stringifyYaml({ name: "mixed", version: "1", ...(rigPolicy ? { permission_policy: rigPolicy } : {}), pods: [{ id: "team", members: [{ id: "worker", runtime: "codex", agent_ref: "local:agent", profile: "default", cwd: ".", ...(memberPolicy ? { permission_policy: memberPolicy } : {}) }] }] })],
        ["agent/agent.yaml", "name: worker\nversion: '1'\nprofiles: {default: {uses: {}}}\n"],
      ]);
      const actual = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
      expect(actual.state).toBe("generated");
      if (actual.state !== "generated") throw new Error(actual.reason);
      expect(actual.posture[0]).toMatchObject({ basis, nativeEffect: "unknown" });
      expect(actual.posture[0]?.permissionPrompts).toBe(permissionPrompts);
      if (!permissionPrompts) expect(actual.posture[0]).not.toHaveProperty("permissionPrompts");
      expect(formatBundleBehaviour(actual).join("\n")).not.toContain("Permission prompts: off");
    }
  });

  it.each(["full_bypass", "floor"] as const)("resolves an archived custom %s policy without observing native settings", launchPosture => {
    const files = new Map([
      ["rig.yaml", stringifyYaml({ name: "custom", version: "1", permission_policy: "policy.md", pods: [{ id: "team", members: [{ id: "worker", runtime: "codex", agent_ref: "local:agent", profile: "default", cwd: "." }] }] })],
      ["agent/agent.yaml", "name: worker\nversion: '1'\nprofiles: {default: {uses: {}}}\n"],
      ["policy.md", `---\npolicy_schema_version: 1\nname: custom\nsource: custom\ndescription: Declared launch posture.\nsurface: flag\nlaunch_posture: ${launchPosture}\n---\n`],
    ]);
    const actual = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
    expect(actual.state).toBe("generated");
    if (actual.state !== "generated") throw new Error(actual.reason);
    expect(actual.posture[0]).toMatchObject({ basis: "explicit", permissionPrompts: launchPosture === "full_bypass" ? "off" : "on", nativeEffect: "unknown" });
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
      expect(actual.posture.find(p => p.seat === member.seat)?.permissionPrompts).toBe(member.runtime === "pi" ? undefined : "default");
      if (member.runtime !== "pi") {
        expect(actual.writes).toEqual(expect.arrayContaining([expect.objectContaining({ seat: member.seat, path: member.runtime === "codex" ? "AGENTS.md" : "CLAUDE.local.md" })]));
      } else {
        expect(actual.posture.find(p => p.seat === member.seat)?.selection).toContain("resource trust");
      }
    }
  });
});
