import { describe, it, expect, vi } from "vitest";
import { formatBundleBehaviour, showBundleBehaviourBeforeAction } from "../src/bundle-behaviour.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describeBundleBehaviour } from "../../daemon/src/domain/bundle-behaviour.js";

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
});
