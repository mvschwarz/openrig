import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalV0, parseReconstructionJson, readReconstruction, readStoreMappings, reconstructionOutput } from "../src/lib/reconstruction-reader.js";

type Doc = Record<string, unknown> & { id: string };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/reconstruction-v0.json", import.meta.url), "utf8")) as {
  sourceStore: string; base: Doc; delta: Doc; other: Doc; composition: Doc;
  canonicalVector: { value: unknown; canonical: string; sha256: string };
};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Dynamic malformed/limit examples use native hashing; compatibility assertions
// below use frozen Python-computed IDs, not an expected value from this reader.
function seal(value: Record<string, unknown>): Doc {
  const { id: ignored, ...body } = value; void ignored;
  return { ...body, id: sha(canonicalV0(parseReconstructionJson(JSON.stringify(body)))) };
}

describe("local v0 reconstruction reader", () => {
  let root: string, store: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reconstruction-reader-")); store = join(root, "import"); mkdirSync(store);
    for (const doc of [fixture.base, fixture.delta, fixture.other, fixture.composition]) save(doc);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function save(doc: Doc) { writeFileSync(join(store, `${doc.id}.json`), JSON.stringify(doc)); return doc.id; }
  const mappings = () => [{ sourceStore: fixture.sourceStore, localStore: store, sourceHost: "example-source" }];
  const read = (id = fixture.composition.id, extra: Partial<Parameters<typeof readReconstruction>[0]> = {}) =>
    readReconstruction({ store, revision: id, mappings: mappings(), ...extra });

  it("reproduces Python's canonical Unicode/key/integer preimage and four frozen record IDs", () => {
    const vector = fixture.canonicalVector;
    expect(canonicalV0(parseReconstructionJson(JSON.stringify(vector.value)))).toBe(vector.canonical);
    expect(sha(vector.canonical)).toBe(vector.sha256);
    for (const doc of [fixture.base, fixture.delta, fixture.other, fixture.composition]) {
      const { id, ...body } = doc;
      expect(sha(canonicalV0(parseReconstructionJson(JSON.stringify(body))))).toBe(id);
    }
  });

  it("reads a relocated base/delta/composition without rewriting IDs, bytes or observation dates", () => {
    const before = readFileSync(join(store, `${fixture.base.id}.json`));
    const result = read();
    expect(result.complete).toBe(true);
    expect(result.nodes.map(n => n.subject)).toEqual(["group:example", "work:example", "seat:helper"]);
    const work = result.nodes[1]!;
    expect(work.lineage.map(v => v.revision)).toEqual([fixture.base.id, fixture.delta.id]);
    expect(work.lineage[0]!.store).toBe(fixture.sourceStore);
    expect(work.items.find(i => i.id === "decision")!.observed_at).toBe("2026-10-27T23:00:00+00:00");
    expect(work.items.find(i => i.id === "dependency")!.observed_at).toBe("2026-10-01T10:00:00+00:00");
    expect(work.items.some(i => i.id === "remove")).toBe(false);
    expect(result.atomicGroupCapture).toBe(false);
    expect(readFileSync(join(store, `${fixture.base.id}.json`))).toEqual(before);
    expect(result.caveat).toContain("not authority");
  });

  it("uses selector union, includes dependencies/constraints/gaps/authority and names omissions", () => {
    const result = read(undefined, { items: ["decision"], tags: ["next"] });
    const work = result.nodes[1]!;
    expect(work.items.map(i => i.id)).toEqual(["decision", "dependency", "constraint", "gap", "authority", "tagged"]);
    expect(work.viewCoverage.omittedIds).toEqual(["omitted"]);
    expect(work.viewCoverage.omittedRouteIds).toEqual(["uncited"]);
    expect(work.sourceManifest.map(s => s.id)).toEqual(["route", "uncited"]);
    expect(work.viewSources.map(s => s.id)).toEqual(["route"]);
    expect(result.nodes[2]!.items.map(i => i.id)).toEqual(["activity"]);
    const inspect = JSON.parse(reconstructionOutput(result, "inspect", true));
    expect(inspect.nodes[1].items).toBeUndefined();
    expect(inspect.nodes[1].sourceManifest).toHaveLength(2);
    expect(JSON.parse(reconstructionOutput(result, "view", true)).nodes[1].sourceManifest).toBeUndefined();
    expect(reconstructionOutput(read(), "view", false)).toContain("https://example.invalid/context");
    expect(reconstructionOutput(result, "view", false)).toContain("inspect this exact revision");
  });

  it("does not infer missing selections, citations, dependencies or a newer revision", () => {
    expect(read(undefined, { items: ["absent"] }).issues.map(i => i.code)).toContain("missing_item");
    const doc = seal({ ...fixture.base, items: [{ id: "x", category: "decision", text: "Needs evidence", observed_at: null, sources: ["missing"], depends_on: ["missing"] }] });
    const result = read(save(doc));
    expect(result.complete).toBe(false);
    expect(result.issues.map(i => i.code)).toEqual(["missing_dependency", "missing_citation"]);
    expect(result.nodes[0]!.itemObservations[0]!.observedAt).toBeNull();
    expect(() => readReconstruction({ store, revision: "latest" })).toThrow(/full lowercase SHA256/);
  });

  it("retains available composition members but reports an unmapped/missing member as incomplete", () => {
    const unmapped = read(undefined, { mappings: [] });
    expect(unmapped.complete).toBe(false);
    expect(unmapped.issues.every(i => i.code === "unmapped_external_store")).toBe(true);
    rmSync(join(store, `${fixture.base.id}.json`));
    const missing = read();
    expect(missing.complete).toBe(false);
    expect(missing.nodes.map(n => n.subject)).toEqual(["group:example", "seat:helper"]);
    expect(missing.issues[0]!.revision).toBe(fixture.base.id);
  });

  it("requires unambiguous explicit local mapping and preserves its provenance", () => {
    const file = join(root, "map.json"); writeFileSync(file, JSON.stringify(mappings()));
    expect(readStoreMappings(file)).toEqual(mappings());
    expect(read(undefined, { mappings: readStoreMappings(file) }).mappings[0]!.sourceHost).toBe("example-source");
    expect(() => read(undefined, { mappings: [...mappings(), { ...mappings()[0]!, sourceHost: "other-host" }] })).toThrow(/ambiguous/);
    writeFileSync(file, '[{"sourceStore":"relative","localStore":"/tmp"}]');
    expect(() => readStoreMappings(file)).toThrow(/absolute/);
  });

  it("rejects tampering, unsupported schemas, duplicate subjects and semantic invalidity", () => {
    writeFileSync(join(store, `${fixture.base.id}.json`), JSON.stringify({ ...fixture.base, purpose: "Changed bytes" }));
    expect(read(fixture.base.id).issues[0]!.message).toContain("hash mismatch");
    expect(read(save(seal({ ...fixture.base, schema: "openrig.reconstruction/v999" }))).issues[0]!.code).toBe("unsupported_schema");
    const duplicate = seal({ ...fixture.composition, members: [{ store, revision: fixture.other.id }, { store, revision: fixture.other.id }] });
    expect(read(save(duplicate)).issues[0]!.code).toBe("duplicate_subject");
    for (const invalid of [
      { ...fixture.delta, remove_items: ["not-present"] },
      { ...fixture.delta, subject: "different" },
      { ...fixture.delta, items: [] },
      { ...fixture.other, remove_items: [] },
      { ...fixture.other, discovery: [{ id: "d", path: "/tmp", observed_at: null, known_paths: ["../outside"] }] },
    ]) expect(read(save(seal(invalid))).complete).toBe(false);
  });

  it.each(['1.0', '1e2', '9007199254740992', '{"a":1,"a":2}', '"\\ud800"', '[1,]', '{"a":1}garbage'])
  ("explicitly rejects incompatible/invalid JSON %s", input => expect(() => parseReconstructionJson(input)).toThrow());

  it("bounds closure reads, individual files, nesting and output without silently truncating", () => {
    let id = fixture.other.id;
    for (let n = 0; n < 65; n++) id = save(seal({ ...fixture.other, kind: "delta", items: undefined, sources: undefined, parent: { store, revision: id } }));
    const result = read(id);
    expect(result.complete).toBe(false);
    expect(result.records.length).toBeLessThanOrEqual(64);
    expect(result.issues.some(i => i.code === "closure_limit")).toBe(true);
    const fake = "a".repeat(64); writeFileSync(join(store, `${fake}.json`), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    expect(read(fake).issues[0]!.message).toContain("byte bound");
    expect(() => parseReconstructionJson("[".repeat(130) + "0" + "]".repeat(130))).toThrow(/nesting/);
    expect(() => reconstructionOutput(read(), "view", true, 1024)).toThrow(/no complete output/);
  });

  it("checks local source bytes without refreshing facts, fetching opaque routes or following symlinks", () => {
    const source = join(root, "evidence.txt"); writeFileSync(source, "before");
    const link = join(root, "link"); symlinkSync(source, link);
    const doc = seal({ ...fixture.other, sources: [
      { id: "local", path: source, sha256: sha("before"), observed_at: "2026-10-01T10:00:00Z" },
      { id: "link", path: link, observed_at: null },
      { id: "opaque", address: "transcript:example", observed_at: null },
    ] });
    save(doc);
    expect(read(doc.id).sourceChecks).toBeUndefined();
    expect(read(doc.id, { checkSources: true }).sourceChecks![0]!.status).toBe("unchanged");
    writeFileSync(source, "after");
    const checked = read(doc.id, { checkSources: true });
    expect(checked.sourceChecks!.map(s => s.status)).toEqual(["changed", "unavailable", "unchecked"]);
    expect(checked.sourceChecks![0]!.observedAt).toBe("2026-10-01T10:00:00Z");
    expect(checked.nodes[0]!.sourceManifest[0]!.sha256).toBe(sha("before"));
    const destination = join(store, `${doc.id}.json`); rmSync(destination); symlinkSync(source, destination);
    expect(read(doc.id).complete).toBe(false);
  });
});
