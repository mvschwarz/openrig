// The frozen bundle formats (docs/reference/schemas): every valid fixture passes its schema and
// every invalid fixture fails it. web-studio, the registry check and the status generator build
// against these files.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

const SCHEMAS = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../../docs/reference/schemas");
const FIXTURES = nodePath.join(SCHEMAS, "fixtures");
const SCHEMA_FOR: Record<string, string> = {
  configurations: "bundle-configurations.v1",
  behaviour: "bundle-behaviour.v1",
  "run-record": "run-record.v1",
  status: "bundle-status.v1",
  registry: "registry-entry.v1",
};

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const file of fs.readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(nodePath.join(SCHEMAS, file), "utf-8")));
  }
  return (schemaName: string, data: unknown) => {
    const validate = ajv.getSchema(`https://openrig.dev/schemas/${schemaName}.json`);
    if (!validate) throw new Error(`schema ${schemaName} not found`);
    return { ok: validate(data) as boolean, errors: validate.errors };
  };
}

function fixtures(kind: "valid" | "invalid"): Array<{ name: string; schema: string; data: unknown }> {
  const out: Array<{ name: string; schema: string; data: unknown }> = [];
  for (const dir of fs.readdirSync(nodePath.join(FIXTURES, kind))) {
    for (const file of fs.readdirSync(nodePath.join(FIXTURES, kind, dir))) {
      const text = fs.readFileSync(nodePath.join(FIXTURES, kind, dir, file), "utf-8");
      out.push({ name: `${kind}/${dir}/${file}`, schema: SCHEMA_FOR[dir]!, data: file.endsWith(".json") ? JSON.parse(text) : parseYaml(text) });
    }
  }
  return out;
}

describe("bundle formats v1", () => {
  const validate = validator();

  it("every format has at least one valid and one invalid fixture", () => {
    const covered = (kind: "valid" | "invalid") => new Set(fixtures(kind).map((f) => f.schema));
    for (const schema of Object.values(SCHEMA_FOR)) {
      expect(covered("valid").has(schema), `valid fixture for ${schema}`).toBe(true);
      expect(covered("invalid").has(schema), `invalid fixture for ${schema}`).toBe(true);
    }
  });

  for (const fixture of fixtures("valid")) {
    it(`accepts ${fixture.name}`, () => {
      const result = validate(fixture.schema, fixture.data);
      expect(result.errors ?? []).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  for (const fixture of fixtures("invalid")) {
    it(`rejects ${fixture.name}`, () => {
      expect(validate(fixture.schema, fixture.data).ok).toBe(false);
    });
  }
});
