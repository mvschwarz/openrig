import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";

describe("seat model catalog", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  let home: string;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    home = mkdtempSync(join(tmpdir(), "openrig-model-catalog-"));
    vi.stubEnv("OPENRIG_HOME", home);
    mkdirSync(join(home, "community-harnesses"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seed(runtime = "fixture-harness") {
    const rig = setup.rigRepo.createRig("catalog-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.worker", {
      runtime, model: "custom/unlisted", effort: "medium",
    });
    setup.rigRepo.setNodeEffortChoice(node.id, "future-level");
    return { rig, node, url: `/api/seat/model-catalog/node/${node.id}` };
  }

  function preset(metadata: string) {
    writeFileSync(join(home, "community-harnesses", "fixture-harness.yaml"),
      `format: 1\nname: fixture-harness\ncommand: /does-not-exist\nmaintainer: Fixture\n${metadata}\n`);
  }

  it("shows declared models with provenance and only explicitly declared per-model efforts", async () => {
    const { node, url } = seed();
    preset(`model_catalog:
  runtime_version: "1.2.3"
  models:
    - {id: provider/one, effort_levels: [low, high]}
    - {id: provider/two, apiKey: test-not-a-key}
    - {id: provider/three, effort_levels: []}`);
    const changes = () => db.prepare("SELECT total_changes() AS count").get();
    const changesBefore = changes();
    const before = Date.now();
    const response = await setup.app.request(url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      seat: { nodeId: node.id },
      runtime: "fixture-harness",
      saved: { model: "custom/unlisted", effort: { choice: "future-level", effective: "future-level" } },
      catalog: {
        status: "available",
        models: [
          { id: "provider/one", effortLevels: ["low", "high"], source: "community-harness-preset", runtimeVersion: "1.2.3" },
          { id: "provider/two", source: "community-harness-preset", runtimeVersion: "1.2.3" },
          { id: "provider/three", effortLevels: [], source: "community-harness-preset", runtimeVersion: "1.2.3" },
        ],
      },
    });
    expect(body.catalog.models[1]).not.toHaveProperty("effortLevels");
    expect(JSON.stringify(body)).not.toContain("test-not-a-key");
    expect(changes()).toEqual(changesBefore);
    for (const model of body.catalog.models) {
      expect(Date.parse(model.observedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(model.observedAt)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("distinguishes an explicitly empty list from absent and malformed metadata", async () => {
    const { url } = seed();
    for (const [metadata, catalog] of [
      ["model_catalog: {models: []}", { status: "available", models: [] }],
      ["", { status: "unavailable" }],
      ["model_catalog: {models: [{id: 7}]}", { status: "unavailable" }],
      ["model_catalog: {models: [{id: one, effort_levels: [low, 7]}]}", { status: "unavailable" }],
    ] as const) {
      preset(metadata);
      const response = await setup.app.request(url);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.catalog).toMatchObject(catalog);
      expect(body.saved).toMatchObject({ model: "custom/unlisted", effort: { choice: "future-level" } });
      expect(loadCommunityHarnessPreset("fixture-harness").ok).toBe(true);
    }
  });

  it("omits an unknown version and keeps the authored effort when there is no override", async () => {
    const { node, url } = seed();
    setup.rigRepo.setNodeEffortChoice(node.id, null);
    preset("model_catalog: {models: [{id: model-a}]}");
    const response = await setup.app.request(url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.saved.effort).toMatchObject({ choice: null, authored: "medium", effective: "medium" });
    expect(body.catalog.models[0]).not.toHaveProperty("runtimeVersion");
  });

  it("uses the same trimmed model and effort spelling as the setting writes", async () => {
    const { url } = seed();
    preset('model_catalog: {models: [{id: " custom/unlisted ", effort_levels: [" future-level "]}]}');
    const response = await setup.app.request(url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.catalog.models).toMatchObject([
      { id: body.saved.model, effortLevels: [body.saved.effort.choice] },
    ]);
  });

  it("exposes saved choices for Codex without a supported source and preserves save-with-warning", async () => {
    const { node, url } = seed("codex");
    const save = await setup.app.request(`/api/seat/set-effort/node/${node.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: "custom-effort", reason: "manual entry", operator: "operator@external" }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ warning: expect.any(String) });
    const response = await setup.app.request(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: "codex",
      saved: { model: "custom/unlisted", effort: { choice: "custom-effort" } },
      catalog: { status: "unavailable" },
    });
  });

  it("uses the same durable selector as setting writes and excludes archived seats", async () => {
    const { rig, url } = seed();
    const other = setup.rigRepo.createRig("another-rig");
    setup.rigRepo.addNode(other.id, "dev.worker", { runtime: "codex", model: "other-seat" });
    const exact = await setup.app.request(url);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ saved: { model: "custom/unlisted" } });
    const qualified = await setup.app.request("/api/seat/model-catalog/dev.worker%40catalog-rig");
    expect(qualified.status).toBe(200);
    expect(await qualified.json()).toMatchObject({ saved: { model: "custom/unlisted" } });
    const ambiguous = await setup.app.request("/api/seat/model-catalog/dev.worker");
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "seat_ambiguous" });
    expect((await setup.app.request("/api/seat/model-catalog/node/missing")).status).toBe(404);
    setup.rigRepo.archiveRig(rig.id);
    const response = await setup.app.request(url);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "seat_not_found" });
  });
});
