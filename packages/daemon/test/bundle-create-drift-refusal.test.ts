// Bundle create REFUSES to export a spec that disagrees with the rig it names.
//
// Build B already DETECTS spec-vs-live drift and returns a `warning` on the 201 (see
// bundle-export-drift-warning.test.ts, which pins the detection wiring). Detection was not enough:
// a .rigbundle is a disaster-recovery artifact, and a warning attached to a success is discovered
// at the one moment it is least affordable. These tests pin the ENFORCEMENT — refuse by default,
// proceed only when the operator says they mean it, and make the artifact carry its own caveat when
// they do.
//
// Four cases, and the three that must stay SILENT matter as much as the one that must be loud: the
// cheapest way to pass a refusal test is to refuse everything, which would pass the first assertion
// here and break every legitimate authoring export.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";

const RIG_NAME = "drift-export-rig";

describe("bundle create — refuses a spec that disagrees with the live rig", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-drift-refusal-"));
    app = createTestApp(db).app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A rig running in the DB with the given fully-qualified seat ids. */
  function seedLiveRig(name: string, logicalIds: string[]): void {
    const rigId = `rig-${name}`;
    db.prepare("INSERT INTO rigs (id, name, created_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))").run(rigId, name);
    for (const [i, lid] of logicalIds.entries()) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?,?,?)").run(`${rigId}-n${i}`, rigId, lid);
    }
  }

  /** A pod-aware spec on disk declaring exactly the pods/members given, plus the agent it references. */
  function writeSpec(name: string, pods: Array<{ id: string; members: string[] }>): string {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      "name: impl-agent",
      'version: "1.0.0"',
      "resources:",
      "  skills: []",
      "profiles:",
      "  default:",
      "    uses:",
      "      skills: []",
    ].join("\n"));

    const lines = ['version: "0.2"', `name: ${name}`, "pods:"];
    for (const pod of pods) {
      lines.push(`  - id: ${pod.id}`, `    label: ${pod.id}`, "    members:");
      for (const member of pod.members) {
        lines.push(
          `      - id: ${member}`,
          '        agent_ref: "local:agents/impl"',
          "        profile: default",
          "        runtime: claude-code",
          "        cwd: .",
        );
      }
      lines.push("    edges: []");
    }
    lines.push("edges: []");

    const specPath = path.join(tmpDir, `${name}.yaml`);
    fs.writeFileSync(specPath, lines.join("\n"));
    return specPath;
  }

  function create(specPath: string, outputName: string, extra: Record<string, unknown> = {}) {
    return app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath,
        bundleName: outputName,
        bundleVersion: "0.1.0",
        outputPath: path.join(tmpDir, `${outputName}.rigbundle`),
        ...extra,
      }),
    });
  }

  // THE RED: this is the shipped defect. The spec declares one pod/one seat; the rig is running two
  // pods and three seats. Today that exports 201 with a warning nobody is required to read, and the
  // resulting DR artifact rebuilds the smaller rig.
  it("refuses with 409 and names BOTH topologies when the spec is smaller than the live rig", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "dev.qa", "orch.lead"]);
    const specPath = writeSpec(RIG_NAME, [{ id: "dev", members: ["impl"] }]);

    const res = await create(specPath, "stale");

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    // The diff must be specific enough to act on — a generic "topology differs" is the caution a
    // reader learns to skip. Both counts, and the seats that would be dropped, appear by name.
    expect(body.error).toContain("1 pods/1 seats");
    expect(body.error).toContain("2/3");
    expect(body.error).toContain("dev.qa");
    expect(body.error).toContain("orch.lead");
    // Refusal means refusal: no artifact on disk.
    expect(fs.existsSync(path.join(tmpDir, "stale.rigbundle"))).toBe(false);
  });

  // The escape hatch, and the price of using it: the artifact carries its own caveat.
  it("proceeds with allowDrift and stamps the divergence into bundle provenance", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "dev.qa", "orch.lead"]);
    const specPath = writeSpec(RIG_NAME, [{ id: "dev", members: ["impl"] }]);

    const res = await create(specPath, "allowed", { allowDrift: true });

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toContain("2/3");

    // Provenance is where the caveat has to live — the warning in an HTTP response dies with the
    // terminal that printed it; whoever installs this bundle six weeks from now reads the manifest.
    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: path.join(tmpDir, "allowed.rigbundle") }),
    });
    expect(inspectRes.status).toBe(200);
    const inspected = await inspectRes.json() as { manifest?: { provenance?: { notes?: string } } };
    expect(inspected.manifest?.provenance?.notes ?? "").toContain("2/3");
  });

  // PRESERVE 1 — authoring a spec for a rig that is not running is legitimate and must stay silent.
  // This is the case a refuse-everything implementation breaks.
  it("stays silent when the named rig is not running", async () => {
    const specPath = writeSpec("not-a-running-rig", [{ id: "dev", members: ["impl"] }]);

    const res = await create(specPath, "authoring");

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "authoring.rigbundle"))).toBe(true);
  });

  // PRESERVE 2 — spec and live agree: no refusal, no warning, no new ceremony on a correct path.
  it("stays silent when the spec matches the live rig exactly", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "orch.lead"]);
    const specPath = writeSpec(RIG_NAME, [
      { id: "dev", members: ["impl"] },
      { id: "orch", members: ["lead"] },
    ]);

    const res = await create(specPath, "conforming");

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "conforming.rigbundle"))).toBe(true);
  });

  // LEGACY (v1) specs export through this same endpoint and produce the same confidently-wrong
  // artifact. They need the same guard, not a second detector: a v1 rig is a topology with no pod
  // level, and a node's `logical_id` IS the spec's `node.id`, so the only thing the format changes
  // is how ids are read.
  function writeLegacySpec(name: string, nodeIds: string[]): string {
    const lines = ["schema_version: 1", `name: ${name}`, 'version: "1.0"', "nodes:"];
    for (const id of nodeIds) lines.push(`  - id: ${id}`, "    runtime: claude-code");
    lines.push("edges: []");
    const specPath = path.join(tmpDir, `${name}-legacy.yaml`);
    fs.writeFileSync(specPath, lines.join("\n"));
    return specPath;
  }

  it("refuses a LEGACY spec that is smaller than the live rig, naming the dropped seats", async () => {
    seedLiveRig(RIG_NAME, ["dev", "qa", "lead"]);
    const specPath = writeLegacySpec(RIG_NAME, ["dev"]);

    const res = await create(specPath, "legacy-stale");

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("qa");
    expect(body.error).toContain("lead");
    expect(fs.existsSync(path.join(tmpDir, "legacy-stale.rigbundle"))).toBe(false);
  });

  // The flat reader is the load-bearing half of legacy support. Read a flat rig through the
  // pod-aware reader and every id parses as malformed, the live rig reads as EMPTY, and the guard
  // reports "nothing is running" — a false absence, on the one path that exists to notice what
  // would be dropped. This case fails loudly if that reader is ever swapped back.
  it("stays silent when a LEGACY spec matches the live rig exactly", async () => {
    seedLiveRig(RIG_NAME, ["dev", "qa"]);
    const specPath = writeLegacySpec(RIG_NAME, ["dev", "qa"]);

    const res = await create(specPath, "legacy-conforming");

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "legacy-conforming.rigbundle"))).toBe(true);
  });

  // PRESERVE 3 — the drift that runs the OTHER way (spec declares more than is running) is a
  // legitimate export: a bundle whose job is to bring the missing pods up. Refusing it would make
  // the guard fire on exactly the recovery case it exists to protect.
  it("does not refuse when the spec declares MORE than is currently running", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl"]);
    const specPath = writeSpec(RIG_NAME, [
      { id: "dev", members: ["impl"] },
      { id: "orch", members: ["lead"] },
    ]);

    const res = await create(specPath, "recovery");

    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(tmpDir, "recovery.rigbundle"))).toBe(true);
  });
});
