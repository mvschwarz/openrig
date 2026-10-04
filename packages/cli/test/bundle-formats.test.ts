// The frozen bundle formats (docs/reference/schemas): every valid fixture passes its schema and
// every invalid fixture fails it. web-studio, the registry check and the status generator build
// against these files.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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

  it("v1 grows: open formats accept an unknown property; the status file, a package digest and a harness check's subject don't", () => {
    const valid = (dir: string) => fixtures("valid").find((f) => f.name.startsWith(`valid/${dir}/`))!;
    const withExtra = (data: unknown, at: (copy: Record<string, any>) => Record<string, unknown>) => {
      const copy = structuredClone(data) as Record<string, any>;
      at(copy)["futureOptional"] = "x";
      return copy;
    };
    for (const dir of ["configurations", "behaviour", "run-record", "registry"]) {
      const f = valid(dir);
      expect(validate(f.schema, withExtra(f.data, (c) => c)).ok, `${f.name} top level`).toBe(true);
    }
    const registry = valid("registry");
    expect(validate(registry.schema, withExtra(registry.data, (c) => c["source"])).ok, "registry source").toBe(true);

    const status = valid("status");
    expect(validate(status.schema, withExtra(status.data, (c) => c)).ok, "status top level").toBe(false);
    const team = fixtures("valid").find((f) => f.name === "valid/run-record/team-pass.json")!;
    expect(validate(team.schema, withExtra(team.data, (c) => c["subject"]["packageDigest"])).ok, "package digest").toBe(false);
    const harness = fixtures("valid").find((f) => f.name === "valid/run-record/pi-harness-check-blocked.json")!;
    expect(validate(harness.schema, withExtra(harness.data, (c) => c["subject"])).ok, "harness-check subject").toBe(false);
  });

  it("the status fixture agrees with the run-record fixtures it cites, and its bodyDigest matches its body", () => {
    const records = new Map(fixtures("valid").filter((f) => f.schema === "run-record.v1")
      .map((f) => [(f.data as { id: string }).id, f.data as Record<string, any>]));
    const withdrawn = new Set([...records.values()].flatMap((r) => r["relations"]["withdraws"] as string[]));
    const passed = (r: Record<string, any>) => (r["outcome"]["steps"] as Array<{ result: string }>).every((s) => s.result === "PASS");
    const status = fixtures("valid").find((f) => f.schema === "bundle-status.v1")!.data as Record<string, any>;

    for (const listing of Object.values(status["listings"]) as Array<Record<string, any>>) {
      for (const [configurationId, config] of Object.entries(listing["configurations"]) as Array<[string, Record<string, any>]>) {
        for (const [platform, result] of Object.entries(config["platforms"]) as Array<[string, Record<string, any>]>) {
          for (const id of result["recordIds"] as string[]) {
            const record = records.get(id);
            expect(record, id).toBeDefined();
            expect(withdrawn.has(id), `${id} is withdrawn`).toBe(false);
            expect(record!["subject"]["kind"]).toBe("team");
            expect(record!["subject"]["configurationId"]).toBe(configurationId);
            expect(`${record!["environment"]["platform"]}-${record!["environment"]["arch"]}`).toBe(platform);
            expect(result["packageDigests"]).toContainEqual(record!["subject"]["packageDigest"]);
            if (result["label"] === "tested") {
              expect(passed(record!), `${id} passed`).toBe(true);
              expect(record!["outcome"]["assistance"]["count"], `${id} needed no help`).toBe(0);
            }
          }
        }
      }
    }
    for (const [harness, platforms] of Object.entries(status["harnessChecks"]["harnesses"]) as Array<[string, Record<string, any>]>) {
      for (const [platform, result] of Object.entries(platforms) as Array<[string, Record<string, any>]>) {
        for (const id of result["recordIds"] as string[]) {
          const record = records.get(id)!;
          expect(record["subject"]).toEqual({ kind: "harness_check", harness });
          expect(`${record["environment"]["platform"]}-${record["environment"]["arch"]}`).toBe(platform);
          expect((record["outcome"]["steps"] as Array<{ result: string }>).map((s) => s.result)).toContain(result["result"]);
        }
      }
    }

    // RFC 8785 for this fixture's value types (ASCII strings, integers): keys sorted, no whitespace
    const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
      : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);
    const { bodyDigest, ...body } = status;
    expect(createHash("sha256").update(canonical(body), "utf8").digest("hex")).toBe(bodyDigest);
  });
});
