import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { Hono } from "hono";
import YAML from "yaml";
import { scopeCommand } from "../src/commands/scope.js";
import { readFrontmatter } from "../src/lib/scope/scope-fs.js";
import {
  readMissionReadiness,
  readSliceReadiness,
  recordJudgment,
} from "../../daemon/src/domain/proof/judgments.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { coreSchema } from "../../daemon/src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../../daemon/src/db/migrations/003_events.js";
import { streamItemsSchema } from "../../daemon/src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../../daemon/src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../../daemon/src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../../daemon/src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../../daemon/src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../../daemon/src/domain/slices/slice-detail-projector.js";
import { slicesRoutes } from "../../daemon/src/routes/slices.js";

interface CaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-close-inplace-"));
}

function writeFile(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}

function initGitRepo(root: string): void {
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "t@e.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "T"], { stdio: "ignore" });
}

function commitAll(root: string, msg = "fixture"): void {
  execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", msg, "-q"], { stdio: "ignore" });
}

function mountSlicesApi(slicesRoot: string, workspaceRoot: string) {
  const db = createDb();
  migrate(db, [
    coreSchema,
    eventsSchema,
    streamItemsSchema,
    queueItemsSchema,
    queueTransitionsSchema,
    missionControlActionsSchema,
  ]);
  db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
  const projector = new SliceDetailProjector({ db, indexer });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, {
      resolveOne: (key: string) => ({
        value: key === "workspace.root" ? workspaceRoot : path.join(workspaceRoot, "workspace.yaml"),
      }),
    });
    c.set("sliceIndexer" as never, indexer);
    c.set("sliceDetailProjector" as never, projector);
    await next();
  });
  app.route("/api/slices", slicesRoutes());
  return { db, indexer, app };
}

async function runScope(args: string[], workspaceOrMissionsRoot: string): Promise<CaptureResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__EXIT__${exitCode}`);
  }) as typeof process.exit;
  const root = new Command();
  root.addCommand(scopeCommand());
  root.exitOverride();
  const workspaceDir = path.basename(workspaceOrMissionsRoot) === "missions"
    ? path.dirname(workspaceOrMissionsRoot)
    : workspaceOrMissionsRoot;
  try {
    await root.parseAsync(["node", "rig", "scope", ...args, "--workspace", workspaceDir]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) {
      stderrChunks.push(`${msg}\n`);
      if (exitCode === 0) exitCode = 1;
    }
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

describe("#2727 rig scope slice close --in-place", () => {
  let projectRoot: string;
  let missionsRoot: string;

  beforeEach(() => {
    projectRoot = mktemp();
    missionsRoot = path.join(projectRoot, "missions");
    initGitRepo(projectRoot);
    writeFile(path.join(projectRoot, "project.yaml"), YAML.stringify({
      kind: "project",
      metadata: { id: "trial-2727" },
      proofPolicy: { judges: ["judge@trial"] },
      missions: { root: "missions" },
    }));
    fs.mkdirSync(missionsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seedAcceptedSlice(missionName: string, slug = "feature") {
    expect((await runScope(["mission", "create", missionName, "--json"], missionsRoot)).exitCode).toBe(0);
    const created = await runScope(["slice", "create", missionName, slug, "--json"], missionsRoot);
    expect(created.exitCode).toBe(0);
    const sliceDir = JSON.parse(created.stdout).slice.path as string;
    const sliceName = path.basename(sliceDir);
    const sliceId = String(readFrontmatter(path.join(sliceDir, "SPEC.md")).id ?? "OPR.1.0.1.1");

    writeFile(
      path.join(sliceDir, "SPEC.md"),
      [
        "---",
        `id: ${sliceId}`,
        "status: active",
        "---",
        `# ${slug}`,
        "",
        "## Intent",
        "Ship verified slice outcome without moving slice directory.",
        "",
        "## Mini-requirements",
        "1. Preserve slice path and evidence on in-place close.",
        "",
        "## Proof contract",
        "- [x] Verified widget outcome <!-- proof-item: widget-outcome -->",
        "",
      ].join("\n"),
    );
    writeFile(path.join(sliceDir, "PROGRESS.md"), "# Progress\n\n- [x] Implemented and verified.\n");
    writeFile(path.join(sliceDir, "proof", "evidence.md"), "Observed deterministic output.\n");
    writeFile(
      path.join(sliceDir, "proof", "qa.md"),
      [
        "---",
        `slice: ${sliceId}`,
        "candidate_sha: abc1234",
        "artifact_type: qa",
        "verdict: PASS",
        "money_evidence: Observed deterministic output",
        "---",
        "",
        "QA pass details.",
        "",
      ].join("\n"),
    );

    const preReadiness = readSliceReadiness(sliceDir);
    expect(preReadiness.items).toHaveLength(1);
    const item = preReadiness.items[0]!;
    recordJudgment(
      missionsRoot,
      {
        scope: `${missionName}/slices/${sliceName}`,
        item: item.id,
        verdict: "accept",
        reason: "Independent verification passed",
        evidence: ["proof/evidence.md"],
        expectedRevision: item.revision,
        expectedPrevious: null,
      },
      "judge@trial",
      "transport:v1",
    );
    commitAll(projectRoot, `seed ${missionName}/${sliceName}`);

    const acceptedReadiness = readSliceReadiness(sliceDir);
    expect(acceptedReadiness.state).toBe("ready");
    expect(acceptedReadiness.items[0]!.state).toBe("accepted");
    return {
      missionDir: path.join(missionsRoot, missionName),
      sliceDir,
      sliceName,
      sliceId,
    };
  }

  it("closes a delivered slice in place, preserves accepted proof and evidence, leaves active view for shipped, and never marks parent mission delivered", async () => {
    const { missionDir, sliceDir, sliceName } = await seedAcceptedSlice("m-delivery");
    const missionManifestPath = path.join(missionDir, "mission.yaml");
    const missionSpecPath = path.join(missionDir, "SPEC.md");
    const judgmentPath = path.join(sliceDir, "proof", "judgments", "00000001.md");
    const evidencePath = path.join(sliceDir, "proof", "evidence.md");

    const beforeMissionManifest = fs.readFileSync(missionManifestPath, "utf8");
    const beforeMissionSpec = fs.readFileSync(missionSpecPath, "utf8");
    const beforeJudgmentBytes = fs.readFileSync(judgmentPath, "utf8");
    const beforeEvidenceBytes = fs.readFileSync(evidencePath, "utf8");

    const res = await runScope(
      ["slice", "close", sliceName, "--mission", "m-delivery", "--in-place", "--reason", "delivered", "--note", "shipped in place", "--json"],
      missionsRoot,
    );
    expect(res.exitCode, res.stderr || res.stdout).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.closed).toMatchObject({
      mission: "m-delivery",
      name: sliceName,
      reason: "delivered",
      status: "done",
      inPlace: true,
      note: "shipped in place",
      path: sliceDir,
      proofApplicability: {
        evaluated: false,
        changed: null,
        pathPreserved: true,
        receiptFilesPreserved: true,
        judgmentCount: 1,
      },
    });

    // Directory and evidence stay in place untouched; closed/ is never created.
    expect(fs.existsSync(sliceDir)).toBe(true);
    expect(fs.existsSync(path.join(missionDir, "closed", sliceName))).toBe(false);
    expect(fs.readFileSync(judgmentPath, "utf8")).toBe(beforeJudgmentBytes);
    expect(fs.readFileSync(evidencePath, "utf8")).toBe(beforeEvidenceBytes);

    const fm = readFrontmatter(path.join(sliceDir, "SPEC.md"));
    expect(fm.status).toBe("done");
    expect(fm["closure-note"]).toBe("shipped in place");
    expect(typeof fm["closed-on"]).toBe("string");

    // Accepted proof stays inspectable while applicable inputs are unchanged.
    const postSliceReadiness = readSliceReadiness(sliceDir);
    expect(postSliceReadiness.state).toBe("ready");
    expect(postSliceReadiness.items[0]!.state).toBe("accepted");
    expect(postSliceReadiness.items[0]!.judgment?.verdict).toBe("accept");

    const postMissionReadiness = readMissionReadiness(missionDir);
    expect(postMissionReadiness.state).toBe("ready");
    expect(postMissionReadiness.historicalStatus).toBe("planned");

    // Parent mission status/files are never automatically mutated or marked delivered.
    expect(fs.readFileSync(missionManifestPath, "utf8")).toBe(beforeMissionManifest);
    expect(fs.readFileSync(missionSpecPath, "utf8")).toBe(beforeMissionSpec);

    // Scope views: leaves active view, appears in shipped view, excluded from closed/abandoned view.
    const activeLs = JSON.parse((await runScope(["slice", "ls", "--mission", "m-delivery", "--json"], missionsRoot)).stdout);
    expect(activeLs.slices).toEqual([]);

    const shippedLs = JSON.parse((await runScope(["slice", "ls", "--mission", "m-delivery", "--state", "shipped", "--json"], missionsRoot)).stdout);
    expect(shippedLs.slices).toEqual([expect.objectContaining({ name: sliceName, status: "done" })]);

    const closedLs = JSON.parse((await runScope(["slice", "ls", "--mission", "m-delivery", "--state", "closed", "--json"], missionsRoot)).stdout);
    expect(closedLs.slices).toEqual([]);

    const missionLs = JSON.parse((await runScope(["mission", "ls", "--json"], missionsRoot)).stdout);
    expect(missionLs.missions).toEqual([
      expect.objectContaining({
        name: "m-delivery",
        activeSliceCount: 0,
        shippedSliceCount: 1,
        closedSliceCount: 0,
      }),
    ]);
  });

  it("flips accepted readiness to unknown after in-place close when item text, proof policy, or cited evidence bytes change", async () => {
    // 1. Item text change invalidates acceptance -> unknown
    const itemCase = await seedAcceptedSlice("m-mut-item");
    expect((await runScope(["slice", "close", itemCase.sliceName, "--mission", "m-mut-item", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode).toBe(0);
    expect(readSliceReadiness(itemCase.sliceDir).items[0]!.state).toBe("accepted");

    const specPath = path.join(itemCase.sliceDir, "SPEC.md");
    fs.writeFileSync(
      specPath,
      fs.readFileSync(specPath, "utf8").replace("Verified widget outcome", "Changed widget requirement"),
      "utf8",
    );
    const afterItemMut = readSliceReadiness(itemCase.sliceDir);
    expect(afterItemMut.state).toBe("unknown");
    expect(afterItemMut.items[0]!.state).toBe("unknown");

    // 2. Policy change invalidates acceptance -> unknown
    const policyCase = await seedAcceptedSlice("m-mut-policy");
    expect((await runScope(["slice", "close", policyCase.sliceName, "--mission", "m-mut-policy", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode).toBe(0);
    expect(readSliceReadiness(policyCase.sliceDir).items[0]!.state).toBe("accepted");

    writeFile(path.join(policyCase.sliceDir, "slice.yaml"), YAML.stringify({
      kind: "slice",
      metadata: { id: policyCase.sliceId },
      proofPolicy: { judges: ["other-judge@trial"] },
    }));
    const afterPolicyMut = readSliceReadiness(policyCase.sliceDir);
    expect(afterPolicyMut.state).toBe("unknown");
    expect(afterPolicyMut.items[0]!.state).toBe("unknown");

    // 3. Cited evidence byte change invalidates acceptance -> unknown
    const evidenceCase = await seedAcceptedSlice("m-mut-evidence");
    expect((await runScope(["slice", "close", evidenceCase.sliceName, "--mission", "m-mut-evidence", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode).toBe(0);
    expect(readSliceReadiness(evidenceCase.sliceDir).items[0]!.state).toBe("accepted");

    writeFile(path.join(evidenceCase.sliceDir, "proof", "evidence.md"), "Tampered evidence bytes.\n");
    const afterEvidenceMut = readSliceReadiness(evidenceCase.sliceDir);
    expect(afterEvidenceMut.state).toBe("unknown");
    expect(afterEvidenceMut.items[0]!.state).toBe("unknown");
  });

  it("keeps moving close as default, explains proof applicability change when judgments exist, and stays quiet when none exist", async () => {
    const judged = await seedAcceptedSlice("m-move-judged");
    const humanMove = await runScope(
      ["slice", "close", judged.sliceName, "--mission", "m-move-judged", "--reason", "deferred"],
      missionsRoot,
    );
    expect(humanMove.exitCode, humanMove.stderr || humanMove.stdout).toBe(0);
    const movedJudgedDir = path.join(judged.missionDir, "closed", judged.sliceName);
    expect(fs.existsSync(judged.sliceDir)).toBe(false);
    expect(fs.existsSync(movedJudgedDir)).toBe(true);
    expect(readSliceReadiness(movedJudgedDir).items[0]!.state).toBe("unknown");
    expect(humanMove.stdout).toContain("proof:");
    expect(humanMove.stdout).toContain("unknown");
    expect(humanMove.stdout).toContain("--in-place");

    const judgedJsonCase = await seedAcceptedSlice("m-move-judged-json");
    const jsonMove = await runScope(
      ["slice", "close", judgedJsonCase.sliceName, "--mission", "m-move-judged-json", "--reason", "superseded", "--json"],
      missionsRoot,
    );
    expect(jsonMove.exitCode).toBe(0);
    const jsonMovedPayload = JSON.parse(jsonMove.stdout);
    expect(jsonMovedPayload.closed).toMatchObject({
      mission: "m-move-judged-json",
      name: judgedJsonCase.sliceName,
      reason: "superseded",
      status: "closed-superseded",
      inPlace: false,
      proofApplicability: {
        evaluated: false,
        changed: true,
        pathPreserved: false,
        receiptFilesPreserved: true,
        judgmentCount: 1,
      },
    });

    // Unjudged slice: moving close does NOT falsely claim recorded judgments became unknown.
    expect((await runScope(["mission", "create", "m-move-plain", "--json"], missionsRoot)).exitCode).toBe(0);
    const plainCreated = await runScope(["slice", "create", "m-move-plain", "plain", "--json"], missionsRoot);
    const plainName = JSON.parse(plainCreated.stdout).slice.name as string;
    commitAll(projectRoot, "seed plain");

    const plainHuman = await runScope(
      ["slice", "close", plainName, "--mission", "m-move-plain", "--reason", "wontfix"],
      missionsRoot,
    );
    expect(plainHuman.exitCode).toBe(0);
    expect(plainHuman.stdout).not.toContain("unknown");
    expect(plainHuman.stdout).not.toContain("proof:");
  });

  it("classifies in-place non-delivery closures (deferred, superseded) as closed rather than shipped, deactivates mission.yaml membership without marking parent delivered, and avoids missing_proof audit findings", async () => {
    const delivered = await seedAcceptedSlice("m-mixed", "delivered-one");
    const createdDeferred = await runScope(["slice", "create", "m-mixed", "deferred-two", "--json"], missionsRoot);
    expect(createdDeferred.exitCode).toBe(0);
    const deferredDir = JSON.parse(createdDeferred.stdout).slice.path as string;
    const deferredName = path.basename(deferredDir);
    writeFile(
      path.join(deferredDir, "SPEC.md"),
      "---\nid: OPR.1.0.1.2\nstatus: active\n---\n# deferred-two\n\n## Intent\nDeferred follow-up.\n\n## Mini-requirements\n1. Later.\n\n## Proof contract\n- [ ] Unstarted deliverable\n",
    );

    const createdSuperseded = await runScope(["slice", "create", "m-mixed", "superseded-three", "--json"], missionsRoot);
    expect(createdSuperseded.exitCode).toBe(0);
    const supersededDir = JSON.parse(createdSuperseded.stdout).slice.path as string;
    const supersededName = path.basename(supersededDir);
    writeFile(
      path.join(supersededDir, "SPEC.md"),
      "---\nid: OPR.1.0.1.3\nstatus: active\n---\n# superseded-three\n\n## Intent\nReplaced slice.\n\n## Mini-requirements\n1. Replaced.\n\n## Proof contract\n- [ ] Replaced deliverable\n",
    );
    commitAll(projectRoot, "seed mixed");

    expect((await runScope(["slice", "close", delivered.sliceName, "--mission", "m-mixed", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode).toBe(0);
    expect((await runScope(["slice", "close", deferredName, "--mission", "m-mixed", "--in-place", "--reason", "deferred", "--json"], missionsRoot)).exitCode).toBe(0);
    expect((await runScope(["slice", "close", supersededName, "--mission", "m-mixed", "--in-place", "--reason", "superseded", "--json"], missionsRoot)).exitCode).toBe(0);

    expect(fs.existsSync(deferredDir)).toBe(true);
    expect(fs.existsSync(supersededDir)).toBe(true);
    expect(readFrontmatter(path.join(deferredDir, "SPEC.md")).status).toBe("closed-deferred");
    expect(readFrontmatter(path.join(supersededDir, "SPEC.md")).status).toBe("closed-superseded");

    // mission.yaml keeps delivered active=true, marks non-delivery closures active=false, and keeps metadata.status untouched ("planned").
    const manifest = YAML.parse(fs.readFileSync(path.join(delivered.missionDir, "mission.yaml"), "utf8")) as {
      metadata: { status: string };
      composition: { slices: Array<{ ref: string; active?: boolean }> };
    };
    expect(manifest.metadata.status).toBe("planned");
    expect(manifest.composition.slices).toEqual([
      expect.objectContaining({ ref: `slices/${delivered.sliceName}/slice.yaml`, active: true }),
      expect.objectContaining({ ref: `slices/${deferredName}/slice.yaml`, active: false }),
      expect.objectContaining({ ref: `slices/${supersededName}/slice.yaml`, active: false }),
    ]);

    // Active mission proof readiness remains ready because active=true slice is accepted and deactivated non-delivery slices are excluded.
    expect(readMissionReadiness(delivered.missionDir).state).toBe("ready");

    // Standing separation:
    const activeSlices = JSON.parse((await runScope(["slice", "ls", "--mission", "m-mixed", "--json"], missionsRoot)).stdout).slices;
    expect(activeSlices).toEqual([]);

    const shippedSlices = JSON.parse((await runScope(["slice", "ls", "--mission", "m-mixed", "--state", "shipped", "--json"], missionsRoot)).stdout).slices;
    expect(shippedSlices.map((s: { name: string }) => s.name)).toEqual([delivered.sliceName]);

    const closedSlices = JSON.parse((await runScope(["slice", "ls", "--mission", "m-mixed", "--state", "closed", "--json"], missionsRoot)).stdout).slices;
    expect(closedSlices.map((s: { name: string }) => s.name)).toEqual([deferredName, supersededName]);

    // Audit: inspect real mission.findings and slices[].findings shape (no buckets field),
    // with a positive unproved-delivered control alongside non-delivery closures so both
    // missing filtering and wrong-field reads fail.
    const createdUnprovedDelivered = await runScope(["slice", "create", "m-mixed", "delivered-unproved", "--json"], missionsRoot);
    expect(createdUnprovedDelivered.exitCode).toBe(0);
    const unprovedDeliveredDir = JSON.parse(createdUnprovedDelivered.stdout).slice.path as string;
    const unprovedDeliveredName = path.basename(unprovedDeliveredDir);
    writeFile(
      path.join(unprovedDeliveredDir, "SPEC.md"),
      "---\nid: OPR.1.0.1.4\nstatus: active\n---\n# delivered-unproved\n\n## Intent\nDelivered without proof artifacts.\n\n## Mini-requirements\n1. Positive audit control.\n\n## Proof contract\n- [x] Unproved deliverable\n",
    );
    expect(
      (await runScope(["slice", "close", unprovedDeliveredName, "--mission", "m-mixed", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode,
    ).toBe(0);

    const auditRes = await runScope(["audit", "--mission", "m-mixed", "--json"], missionsRoot);
    expect(auditRes.exitCode).toBe(0);
    const auditPayload = JSON.parse(auditRes.stdout);
    expect(auditPayload.ok).toBe(true);
    expect(auditPayload.buckets).toBeUndefined();
    expect(Array.isArray(auditPayload.mission?.findings)).toBe(true);
    expect(Array.isArray(auditPayload.slices)).toBe(true);
    expect(auditPayload.slices.map((s: { name: string }) => s.name)).toEqual([
      delivered.sliceName,
      deferredName,
      supersededName,
      unprovedDeliveredName,
    ]);
    for (const entry of auditPayload.slices) {
      expect(Array.isArray(entry.findings)).toBe(true);
    }
    const slicesWithMissingProof = auditPayload.slices
      .filter((s: { findings: Array<{ kind: string }> }) => s.findings.some((f) => f.kind === "missing_proof"))
      .map((s: { name: string }) => s.name);
    expect(slicesWithMissingProof).toEqual([unprovedDeliveredName]);
  });

  it("enforces zero-change controls on invalid combinations (--reason delivered without --in-place, unknown reason, already in closed/, missing slice)", async () => {
    const { missionDir, sliceDir, sliceName } = await seedAcceptedSlice("m-controls");
    const specPath = path.join(sliceDir, "SPEC.md");
    const manifestPath = path.join(missionDir, "mission.yaml");
    const origSpec = fs.readFileSync(specPath, "utf8");
    const origManifest = fs.readFileSync(manifestPath, "utf8");

    // 1. --reason delivered without --in-place refuses with zero changes
    const noInPlace = await runScope(
      ["slice", "close", sliceName, "--mission", "m-controls", "--reason", "delivered", "--json"],
      missionsRoot,
    );
    expect(noInPlace.exitCode).toBe(1);
    expect(JSON.parse(noInPlace.stdout).ok).toBe(false);
    expect(fs.existsSync(sliceDir)).toBe(true);
    expect(fs.existsSync(path.join(missionDir, "closed", sliceName))).toBe(false);
    expect(fs.readFileSync(specPath, "utf8")).toBe(origSpec);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(origManifest);

    // 2. Unknown --reason with --in-place refuses with zero changes
    const badReason = await runScope(
      ["slice", "close", sliceName, "--mission", "m-controls", "--in-place", "--reason", "bogus", "--json"],
      missionsRoot,
    );
    expect(badReason.exitCode).toBe(1);
    expect(JSON.parse(badReason.stdout).ok).toBe(false);
    expect(fs.readFileSync(specPath, "utf8")).toBe(origSpec);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(origManifest);

    // 3. Missing slice refuses with zero changes
    const missing = await runScope(
      ["slice", "close", "99-missing", "--mission", "m-controls", "--in-place", "--reason", "delivered", "--json"],
      missionsRoot,
    );
    expect(missing.exitCode).toBe(1);
    expect(fs.readFileSync(specPath, "utf8")).toBe(origSpec);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(origManifest);

    // 4. Already moved into closed/ refuses --in-place with zero changes
    expect((await runScope(["slice", "close", sliceName, "--mission", "m-controls", "--reason", "wontfix", "--json"], missionsRoot)).exitCode).toBe(0);
    const closedSpecPath = path.join(missionDir, "closed", sliceName, "SPEC.md");
    const afterMoveSpec = fs.readFileSync(closedSpecPath, "utf8");
    const afterMoveManifest = fs.readFileSync(manifestPath, "utf8");

    const alreadyClosed = await runScope(
      ["slice", "close", sliceName, "--mission", "m-controls", "--in-place", "--reason", "delivered", "--json"],
      missionsRoot,
    );
    expect(alreadyClosed.exitCode).toBe(1);
    expect(JSON.parse(alreadyClosed.stdout).ok).toBe(false);
    expect(fs.readFileSync(closedSpecPath, "utf8")).toBe(afterMoveSpec);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(afterMoveManifest);
  });

  it("refuses --in-place close when an existing slice lacks SPEC.md and README.md without mutating mission, parent, slice, or evidence files", async () => {
    const intact = await seedAcceptedSlice("m-missing-node", "intact");
    const createdNodeless = await runScope(["slice", "create", "m-missing-node", "nodeless", "--json"], missionsRoot);
    expect(createdNodeless.exitCode).toBe(0);
    const nodelessDir = JSON.parse(createdNodeless.stdout).slice.path as string;
    const nodelessName = path.basename(nodelessDir);
    expect(nodelessName).toBe("02-nodeless");

    const evidencePath = path.join(nodelessDir, "proof", "evidence.md");
    writeFile(evidencePath, "Preserved slice evidence bytes.\n");
    fs.unlinkSync(path.join(nodelessDir, "SPEC.md"));
    expect(fs.existsSync(nodelessDir)).toBe(true);
    expect(fs.existsSync(path.join(nodelessDir, "SPEC.md"))).toBe(false);
    expect(fs.existsSync(path.join(nodelessDir, "README.md"))).toBe(false);
    commitAll(projectRoot, "seed existing slice without node file");

    const missionManifestPath = path.join(intact.missionDir, "mission.yaml");
    const missionSpecPath = path.join(intact.missionDir, "SPEC.md");
    const sliceManifestPath = path.join(nodelessDir, "slice.yaml");
    const progressPath = path.join(nodelessDir, "PROGRESS.md");
    const proofDocPath = path.join(nodelessDir, "PROOF.md");
    const intactSpecPath = path.join(intact.sliceDir, "SPEC.md");
    const intactJudgmentPath = path.join(intact.sliceDir, "proof", "judgments", "00000001.md");

    const beforeMissionManifest = fs.readFileSync(missionManifestPath, "utf8");
    const beforeMissionSpec = fs.readFileSync(missionSpecPath, "utf8");
    const beforeSliceManifest = fs.readFileSync(sliceManifestPath, "utf8");
    const beforeProgress = fs.readFileSync(progressPath, "utf8");
    const beforeProofDoc = fs.readFileSync(proofDocPath, "utf8");
    const beforeEvidence = fs.readFileSync(evidencePath, "utf8");
    const beforeIntactSpec = fs.readFileSync(intactSpecPath, "utf8");
    const beforeIntactJudgment = fs.readFileSync(intactJudgmentPath, "utf8");

    // 1. Delivered --in-place --json refuses on missing node file with zero changes.
    const deliveredRes = await runScope(
      ["slice", "close", "02-nodeless", "--mission", "m-missing-node", "--in-place", "--reason", "delivered", "--json"],
      missionsRoot,
    );
    expect(deliveredRes.exitCode).toBe(1);
    expect(JSON.parse(deliveredRes.stdout)).toEqual({
      ok: false,
      error: {
        fact: `Slice "02-nodeless" at ${nodelessDir} has no SPEC.md or README.md.`,
        consequence: "Cannot record in-place closure status without a slice node file.",
        action: "Repair or add SPEC.md before closing --in-place.",
      },
    });

    // 2. Non-delivery --in-place (which otherwise deactivates mission.yaml membership) also refuses before any write.
    const deferredRes = await runScope(
      ["slice", "close", "02-nodeless", "--mission", "m-missing-node", "--in-place", "--reason", "deferred"],
      missionsRoot,
    );
    expect(deferredRes.exitCode).toBe(1);
    expect(deferredRes.stdout).toBe("");
    expect(deferredRes.stderr).toContain(`Slice "02-nodeless" at ${nodelessDir} has no SPEC.md or README.md.`);
    expect(deferredRes.stderr).toContain("Cannot record in-place closure status without a slice node file.");
    expect(deferredRes.stderr).toContain("Repair or add SPEC.md before closing --in-place.");

    // Directory, missing-node state, mission membership, parent mission, slice files, and evidence stay untouched.
    expect(fs.existsSync(nodelessDir)).toBe(true);
    expect(fs.existsSync(path.join(intact.missionDir, "closed", "02-nodeless"))).toBe(false);
    expect(fs.existsSync(path.join(nodelessDir, "SPEC.md"))).toBe(false);
    expect(fs.existsSync(path.join(nodelessDir, "README.md"))).toBe(false);
    expect(fs.readFileSync(missionManifestPath, "utf8")).toBe(beforeMissionManifest);
    expect(YAML.parse(fs.readFileSync(missionManifestPath, "utf8"))).toMatchObject({
      metadata: { status: "planned" },
      composition: {
        slices: [
          { ref: "slices/01-intact/slice.yaml", active: true },
          { ref: "slices/02-nodeless/slice.yaml", active: true },
        ],
      },
    });
    expect(fs.readFileSync(missionSpecPath, "utf8")).toBe(beforeMissionSpec);
    expect(fs.readFileSync(sliceManifestPath, "utf8")).toBe(beforeSliceManifest);
    expect(fs.readFileSync(progressPath, "utf8")).toBe(beforeProgress);
    expect(fs.readFileSync(proofDocPath, "utf8")).toBe(beforeProofDoc);
    expect(fs.readFileSync(evidencePath, "utf8")).toBe(beforeEvidence);
    expect(fs.readFileSync(intactSpecPath, "utf8")).toBe(beforeIntactSpec);
    expect(fs.readFileSync(intactJudgmentPath, "utf8")).toBe(beforeIntactJudgment);
  });

  it("rolls back mission.yaml membership and prior slice writes on persistent node or PROGRESS.md write failure without excluding unfinished work from readiness", async () => {
    const accepted = await seedAcceptedSlice("m-rollback", "accepted-one");
    const createdUnfinished = await runScope(["slice", "create", "m-rollback", "unfinished-two", "--json"], missionsRoot);
    expect(createdUnfinished.exitCode).toBe(0);
    const unfinishedDir = JSON.parse(createdUnfinished.stdout).slice.path as string;
    const unfinishedName = path.basename(unfinishedDir);
    const unfinishedSpecPath = path.join(unfinishedDir, "SPEC.md");
    const unfinishedProgressPath = path.join(unfinishedDir, "PROGRESS.md");
    const unfinishedEvidencePath = path.join(unfinishedDir, "proof", "evidence.md");
    const missionManifestPath = path.join(accepted.missionDir, "mission.yaml");
    const acceptedJudgmentPath = path.join(accepted.sliceDir, "proof", "judgments", "00000001.md");

    writeFile(
      unfinishedSpecPath,
      [
        "---",
        "id: OPR.1.0.1.2",
        "status: active",
        "---",
        "# unfinished-two",
        "",
        "## Intent",
        "Unfinished work that must stay counted in readiness if close fails.",
        "",
        "## Mini-requirements",
        "1. Complete work.",
        "",
        "## Proof contract",
        "- [ ] Unjudged deliverable <!-- proof-item: unjudged-item -->",
        "",
      ].join("\n"),
    );
    writeFile(
      unfinishedProgressPath,
      [
        "---",
        "doc: slice-progress",
        "status: active",
        "---",
        "# Progress",
        "",
        "- [ ] Still in flight.",
        "",
      ].join("\n"),
    );
    writeFile(unfinishedEvidencePath, "Unfinished evidence note.\n");
    commitAll(projectRoot, "seed rollback mission");

    expect(readMissionReadiness(accepted.missionDir).state).toBe("not-ready");

    const beforeMissionManifest = fs.readFileSync(missionManifestPath, "utf8");
    const beforeSpec = fs.readFileSync(unfinishedSpecPath, "utf8");
    const beforeProgress = fs.readFileSync(unfinishedProgressPath, "utf8");
    const beforeEvidence = fs.readFileSync(unfinishedEvidencePath, "utf8");
    const beforeAcceptedJudgment = fs.readFileSync(acceptedJudgmentPath, "utf8");

    // 0. Unreadable existing PROGRESS.md aborts pre-mutation before applyMissionCompositionEdits touches any file.
    const origReadFileSync = fs.readFileSync.bind(fs);
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    let progressReadAttempts = 0;
    let preMutationWrites = 0;
    const unreadableProgressReadSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
      if (path.resolve(String(file)) === path.resolve(unfinishedProgressPath)) {
        progressReadAttempts++;
        throw Object.assign(new Error("EACCES: persistent simulated progress read refusal"), { code: "EACCES" });
      }
      return origReadFileSync(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    const preMutationWriteSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      preMutationWrites++;
      return origWriteFileSync(file, data, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);

    let abortedUnreadableClose: CaptureResult;
    try {
      abortedUnreadableClose = await runScope(
        ["slice", "close", unfinishedName, "--mission", "m-rollback", "--in-place", "--reason", "deferred", "--json"],
        missionsRoot,
      );
    } finally {
      unreadableProgressReadSpy.mockRestore();
      preMutationWriteSpy.mockRestore();
    }

    expect(abortedUnreadableClose.exitCode).toBe(1);
    expect(progressReadAttempts).toBe(1);
    expect(preMutationWrites).toBe(0);
    expect(abortedUnreadableClose.stderr).toContain("EACCES: persistent simulated progress read refusal");
    expect(abortedUnreadableClose.stderr).not.toContain("rollback failure");
    expect(fs.readFileSync(missionManifestPath, "utf8")).toBe(beforeMissionManifest);
    expect(fs.readFileSync(unfinishedSpecPath, "utf8")).toBe(beforeSpec);
    expect(fs.readFileSync(unfinishedProgressPath, "utf8")).toBe(beforeProgress);
    expect(fs.readFileSync(unfinishedEvidencePath, "utf8")).toBe(beforeEvidence);
    expect(fs.readFileSync(acceptedJudgmentPath, "utf8")).toBe(beforeAcceptedJudgment);
    expect(readMissionReadiness(accepted.missionDir).state).toBe("not-ready");

    // 1. Persistent node write failure with distinct forward vs restore errors:
    //    proves original error survives alongside rollback diagnostics, PROGRESS.md is not spuriously rewritten,
    //    and mission.yaml membership rolls back.
    let specWriteAttempts = 0;
    let progressWritesDuringNodeFail = 0;
    const specWriteSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      const resolved = path.resolve(String(file));
      if (resolved === path.resolve(unfinishedSpecPath)) {
        specWriteAttempts++;
        const msg =
          specWriteAttempts === 1
            ? "EIO: forward simulated node write failure"
            : "EROFS: persistent simulated node restore failure";
        throw Object.assign(new Error(msg), { code: specWriteAttempts === 1 ? "EIO" : "EROFS" });
      }
      if (resolved === path.resolve(unfinishedProgressPath)) {
        progressWritesDuringNodeFail++;
      }
      return origWriteFileSync(file, data, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);

    let failedNodeClose: CaptureResult;
    try {
      failedNodeClose = await runScope(
        ["slice", "close", unfinishedName, "--mission", "m-rollback", "--in-place", "--reason", "deferred", "--json"],
        missionsRoot,
      );
    } finally {
      specWriteSpy.mockRestore();
    }

    expect(failedNodeClose.exitCode).toBe(1);
    expect(specWriteAttempts).toBe(2);
    expect(progressWritesDuringNodeFail).toBe(0);
    expect(failedNodeClose.stderr).toContain("EIO: forward simulated node write failure");
    expect(failedNodeClose.stderr).toContain("EROFS: persistent simulated node restore failure");
    expect(failedNodeClose.stderr).toContain("rollback failure");
    expect(readMissionReadiness(accepted.missionDir).state).toBe("not-ready");
    expect(fs.readFileSync(missionManifestPath, "utf8")).toBe(beforeMissionManifest);
    expect(fs.readFileSync(unfinishedSpecPath, "utf8")).toBe(beforeSpec);
    expect(fs.readFileSync(unfinishedProgressPath, "utf8")).toBe(beforeProgress);
    expect(fs.readFileSync(unfinishedEvidencePath, "utf8")).toBe(beforeEvidence);
    expect(fs.readFileSync(acceptedJudgmentPath, "utf8")).toBe(beforeAcceptedJudgment);

    // 2. Persistent PROGRESS.md write failure (distinct forward vs restore errors) after SPEC.md write succeeded:
    //    both SPEC.md and mission.yaml roll back while original + rollback errors are retained.
    let progressWriteAttempts = 0;
    let specWritesObserved = 0;
    const progressWriteSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      const resolved = path.resolve(String(file));
      if (resolved === path.resolve(unfinishedSpecPath)) {
        specWritesObserved++;
      }
      if (resolved === path.resolve(unfinishedProgressPath)) {
        progressWriteAttempts++;
        const msg =
          progressWriteAttempts === 1
            ? "ENOSPC: forward simulated progress write failure"
            : "EACCES: persistent simulated progress restore failure";
        throw Object.assign(new Error(msg), { code: progressWriteAttempts === 1 ? "ENOSPC" : "EACCES" });
      }
      return origWriteFileSync(file, data, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);

    let failedProgressClose: CaptureResult;
    try {
      failedProgressClose = await runScope(
        ["slice", "close", unfinishedName, "--mission", "m-rollback", "--in-place", "--reason", "deferred", "--json"],
        missionsRoot,
      );
    } finally {
      progressWriteSpy.mockRestore();
    }

    expect(failedProgressClose.exitCode).toBe(1);
    expect(specWritesObserved).toBe(2);
    expect(progressWriteAttempts).toBe(2);
    expect(failedProgressClose.stderr).toContain("ENOSPC: forward simulated progress write failure");
    expect(failedProgressClose.stderr).toContain("EACCES: persistent simulated progress restore failure");
    expect(failedProgressClose.stderr).toContain("rollback failure");
    expect(fs.readFileSync(missionManifestPath, "utf8")).toBe(beforeMissionManifest);
    expect(fs.readFileSync(unfinishedSpecPath, "utf8")).toBe(beforeSpec);
    expect(fs.readFileSync(unfinishedProgressPath, "utf8")).toBe(beforeProgress);
    expect(readMissionReadiness(accepted.missionDir).state).toBe("not-ready");

    // 3. Persistent node write/restore failure PLUS persistent mission.yaml rollbackComposition failure:
    //    all independent rollback attempts execute and report their distinct errors without falsely claiming recovery.
    let compoundSpecWrites = 0;
    let missionTmpWriteAttempts = 0;
    const resolvedManifestTmpPrefix = `${path.resolve(missionManifestPath)}.openrig-`;
    const compoundFailSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      const resolved = path.resolve(String(file));
      if (resolved.startsWith(resolvedManifestTmpPrefix)) {
        missionTmpWriteAttempts++;
        if (missionTmpWriteAttempts >= 2) {
          throw Object.assign(new Error("EPERM: persistent simulated mission manifest rollback failure"), {
            code: "EPERM",
          });
        }
      }
      if (resolved === path.resolve(unfinishedSpecPath)) {
        compoundSpecWrites++;
        const msg =
          compoundSpecWrites === 1
            ? "EIO: forward node write failure before composition rollback"
            : "EROFS: persistent node restore failure";
        throw Object.assign(new Error(msg), { code: compoundSpecWrites === 1 ? "EIO" : "EROFS" });
      }
      return origWriteFileSync(file, data, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);

    let failedCompoundClose: CaptureResult;
    try {
      failedCompoundClose = await runScope(
        ["slice", "close", unfinishedName, "--mission", "m-rollback", "--in-place", "--reason", "deferred", "--json"],
        missionsRoot,
      );
    } finally {
      compoundFailSpy.mockRestore();
    }

    expect(failedCompoundClose.exitCode).toBe(1);
    expect(compoundSpecWrites).toBe(2);
    expect(missionTmpWriteAttempts).toBe(2);
    expect(failedCompoundClose.stderr).toContain("EIO: forward node write failure before composition rollback");
    expect(failedCompoundClose.stderr).toContain("EROFS: persistent node restore failure");
    expect(failedCompoundClose.stderr).toContain(
      "rollback mission composition: EPERM: persistent simulated mission manifest rollback failure",
    );
    expect(fs.readFileSync(unfinishedSpecPath, "utf8")).toBe(beforeSpec);
    expect(fs.readFileSync(unfinishedProgressPath, "utf8")).toBe(beforeProgress);
    expect(fs.readFileSync(unfinishedEvidencePath, "utf8")).toBe(beforeEvidence);
    expect(fs.readFileSync(acceptedJudgmentPath, "utf8")).toBe(beforeAcceptedJudgment);
    // Because forward mission.yaml staging succeeded and rollbackComposition's write was persistently refused,
    // mission.yaml honestly retains the un-rolled-back active=false edit rather than pretending atomic recovery.
    const postCompoundManifest = YAML.parse(fs.readFileSync(missionManifestPath, "utf8")) as {
      composition: { slices: Array<{ ref: string; active: boolean }> };
    };
    expect(
      postCompoundManifest.composition.slices.find((entry) => entry.ref === `slices/${unfinishedName}/slice.yaml`)?.active,
    ).toBe(false);
  });

  it("reconciles preexisting PROGRESS.md frontmatter status across CLI, SliceIndexer, and GET /api/slices for delivered and non-delivery in-place closures while preserving unrelated PROGRESS content and default moving close", async () => {
    const delivered = await seedAcceptedSlice("m-progress-sync", "active-to-delivered");
    const deliveredProgressPath = path.join(delivered.sliceDir, "PROGRESS.md");
      writeFile(
      deliveredProgressPath,
      [
        "---",
        "doc: slice-progress",
        "# current cursor comment",
        "status: active",
        "rail-item: PL-2727",
        "checks:",
        "  verdict: pass",
        "---",
        "# Progress — active-to-delivered",
        "",
        "## Outcomes",
        "- Kept author progress note.",
        "",
      ].join("\n"),
    );

    const createdDeferred = await runScope(["slice", "create", "m-progress-sync", "active-to-deferred", "--json"], missionsRoot);
    const deferredDir = JSON.parse(createdDeferred.stdout).slice.path as string;
    const deferredName = path.basename(deferredDir);
    writeFile(path.join(deferredDir, "SPEC.md"), "---\nid: OPR.1.0.1.2\nstatus: active\n---\n# active-to-deferred\n");
    writeFile(
      path.join(deferredDir, "PROGRESS.md"),
      "---\ndoc: slice-progress\nstatus: active\nowner: team-alpha\n---\n# Progress — deferred\n\n- Deferred body.\n",
    );

    const createdSuperseded = await runScope(["slice", "create", "m-progress-sync", "done-to-superseded", "--json"], missionsRoot);
    const supersededDir = JSON.parse(createdSuperseded.stdout).slice.path as string;
    const supersededName = path.basename(supersededDir);
    writeFile(path.join(supersededDir, "SPEC.md"), "---\nid: OPR.1.0.1.3\nstatus: done\n---\n# done-to-superseded\n");
    writeFile(
      path.join(supersededDir, "PROGRESS.md"),
      "---\ndoc: slice-progress\nstatus: shipped\nphase: a\n---\n# Progress — superseded\n\n- Previously shipped body.\n",
    );

    const createdPlainProgress = await runScope(["slice", "create", "m-progress-sync", "frontmatterless-progress", "--json"], missionsRoot);
    const plainProgressDir = JSON.parse(createdPlainProgress.stdout).slice.path as string;
    const plainProgressName = path.basename(plainProgressDir);
    writeFile(path.join(plainProgressDir, "SPEC.md"), "---\nid: OPR.1.0.1.4\nstatus: active\n---\n# frontmatterless-progress\n");
    const plainProgressPath = path.join(plainProgressDir, "PROGRESS.md");
    const beforePlainProgress = "# Progress — plain\n\nstatus: active in body text only\n";
    writeFile(plainProgressPath, beforePlainProgress);

    const createdNoStatusFm = await runScope(["slice", "create", "m-progress-sync", "statusless-frontmatter", "--json"], missionsRoot);
    const noStatusFmDir = JSON.parse(createdNoStatusFm.stdout).slice.path as string;
    const noStatusFmName = path.basename(noStatusFmDir);
    writeFile(path.join(noStatusFmDir, "SPEC.md"), "---\nid: OPR.1.0.1.5\nstatus: active\n---\n# statusless-frontmatter\n");
    const noStatusFmProgressPath = path.join(noStatusFmDir, "PROGRESS.md");
    const beforeNoStatusFmProgress = "---\ndoc: slice-progress\nrail-item: PL-NOSTATUS\n---\n# Progress — no status key\n";
    writeFile(noStatusFmProgressPath, beforeNoStatusFmProgress);

    const createdMoving = await runScope(["slice", "create", "m-progress-sync", "moving-default", "--json"], missionsRoot);
    const movingDir = JSON.parse(createdMoving.stdout).slice.path as string;
    const movingName = path.basename(movingDir);
    writeFile(path.join(movingDir, "SPEC.md"), "---\nid: OPR.1.0.1.6\nstatus: active\n---\n# moving-default\n");
    writeFile(path.join(movingDir, "PROGRESS.md"), "---\nstatus: active\n---\n# Progress — moving\n");

    commitAll(projectRoot, "seed progress sync");

    const { db, indexer, app } = mountSlicesApi(missionsRoot, projectRoot);
    try {
      // Pre-close API baseline confirms PROGRESS.md status overrides SPEC.md before closure.
      const preAllRes = await app.request("/api/slices?refresh=1");
      expect(preAllRes.status).toBe(200);
      const preAll = (await preAllRes.json()) as { slices: Array<{ name: string; status: string; rawStatus: string }> };
      const preByName = new Map(preAll.slices.map((s) => [s.name, s]));
      expect(preByName.get(delivered.sliceName)?.status).toBe("active");
      expect(preByName.get(deferredName)?.status).toBe("active");
      expect(preByName.get(supersededName)).toMatchObject({ status: "done", rawStatus: "shipped" });

      const beforeMissionManifest = fs.readFileSync(path.join(delivered.missionDir, "mission.yaml"), "utf8");
      const beforeDeliveredJudgment = fs.readFileSync(path.join(delivered.sliceDir, "proof", "judgments", "00000001.md"), "utf8");

      expect((await runScope(["slice", "close", delivered.sliceName, "--mission", "m-progress-sync", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode).toBe(0);
      expect((await runScope(["slice", "close", deferredName, "--mission", "m-progress-sync", "--in-place", "--reason", "deferred", "--json"], missionsRoot)).exitCode).toBe(0);
      expect((await runScope(["slice", "close", supersededName, "--mission", "m-progress-sync", "--in-place", "--reason", "superseded", "--json"], missionsRoot)).exitCode).toBe(0);
      expect((await runScope(["slice", "close", plainProgressName, "--mission", "m-progress-sync", "--in-place", "--reason", "delivered", "--json"], missionsRoot)).exitCode).toBe(0);
      expect((await runScope(["slice", "close", noStatusFmName, "--mission", "m-progress-sync", "--in-place", "--reason", "deferred", "--json"], missionsRoot)).exitCode).toBe(0);
      expect((await runScope(["slice", "close", movingName, "--mission", "m-progress-sync", "--reason", "wontfix", "--json"], missionsRoot)).exitCode).toBe(0);

      // API + SliceIndexer consistency across active / done / closed filters:
      const activeApi = (await (await app.request("/api/slices?filter=active&refresh=1")).json()) as {
        slices: Array<{ name: string }>;
      };
      expect(activeApi.slices).toEqual([]);

      const doneApi = (await (await app.request("/api/slices?filter=done&refresh=1")).json()) as {
        slices: Array<{ name: string; status: string; rawStatus: string; railItem: string | null; readiness: { state: string } }>;
      };
      expect(doneApi.slices.map((s) => s.name).sort()).toEqual([delivered.sliceName, plainProgressName]);
      const deliveredApiEntry = doneApi.slices.find((s) => s.name === delivered.sliceName)!;
      expect(deliveredApiEntry).toMatchObject({
        status: "done",
        rawStatus: "done",
        railItem: "PL-2727",
        readiness: { state: "ready" },
      });

      const closedApi = (await (await app.request("/api/slices?filter=closed&refresh=1")).json()) as {
        slices: Array<{ name: string; status: string; rawStatus: string }>;
      };
      expect(closedApi.slices.map((s) => s.name).sort()).toEqual([deferredName, supersededName, noStatusFmName]);
      const closedByName = new Map(closedApi.slices.map((s) => [s.name, s]));
      expect(closedByName.get(deferredName)).toMatchObject({ status: "closed", rawStatus: "closed-deferred" });
      expect(closedByName.get(supersededName)).toMatchObject({ status: "closed", rawStatus: "closed-superseded" });
      expect(closedByName.get(noStatusFmName)).toMatchObject({ status: "closed", rawStatus: "closed-deferred" });

      expect(indexer.get(delivered.sliceName)?.status).toBe("done");
      expect(indexer.get(supersededName)?.status).toBe("closed");

      // CLI standing agrees with API/indexer, and default moving close moved 06-moving-default under closed/.
      const cliShipped = JSON.parse((await runScope(["slice", "ls", "--mission", "m-progress-sync", "--state", "shipped", "--json"], missionsRoot)).stdout).slices;
      expect(cliShipped.map((s: { name: string }) => s.name)).toEqual([delivered.sliceName, plainProgressName]);
      const cliClosed = JSON.parse((await runScope(["slice", "ls", "--mission", "m-progress-sync", "--state", "closed", "--json"], missionsRoot)).stdout).slices;
      expect(cliClosed.map((s: { name: string }) => s.name)).toEqual([deferredName, supersededName, noStatusFmName, movingName]);
      expect(fs.existsSync(path.join(delivered.missionDir, "closed", movingName))).toBe(true);

      // Unrelated PROGRESS.md fields, comments, body, frontmatter-less PROGRESS.md, status-less frontmatter PROGRESS.md,
      // parent mission status, and accepted judgment receipt are preserved.
      const updatedDeliveredProgress = fs.readFileSync(deliveredProgressPath, "utf8");
      expect(readFrontmatter(deliveredProgressPath)).toMatchObject({
        doc: "slice-progress",
        status: "done",
        "rail-item": "PL-2727",
        checks: { verdict: "pass" },
      });
      expect(updatedDeliveredProgress).toContain("# current cursor comment");
      expect(updatedDeliveredProgress).toContain("checks:\n  verdict: pass");
      expect(updatedDeliveredProgress).toContain("- Kept author progress note.");
      expect(fs.readFileSync(plainProgressPath, "utf8")).toBe(beforePlainProgress);
      expect(fs.readFileSync(noStatusFmProgressPath, "utf8")).toBe(beforeNoStatusFmProgress);
      expect(YAML.parse(fs.readFileSync(path.join(delivered.missionDir, "mission.yaml"), "utf8")).metadata.status).toBe(
        YAML.parse(beforeMissionManifest).metadata.status,
      );
      expect(fs.readFileSync(path.join(delivered.sliceDir, "proof", "judgments", "00000001.md"), "utf8")).toBe(beforeDeliveredJudgment);
    } finally {
      db.close();
    }
  });

  it("refuses in-place close before any mutation when PROGRESS.md frontmatter has nested-only or later-nested status: entries that line-based slice readers would treat as slice status", async () => {
    const nestedOnly = await seedAcceptedSlice("m-ambiguous-progress", "nested-only-status");
    const nestedOnlyProgressPath = path.join(nestedOnly.sliceDir, "PROGRESS.md");
    writeFile(
      nestedOnlyProgressPath,
      [
        "---",
        "doc: slice-progress",
        "checks:",
        "  status: active",
        "---",
        "# Progress — nested-only status",
        "",
        "- Nested check status only.",
        "",
      ].join("\n"),
    );

    const createdTopPlusNested = await runScope(
      ["slice", "create", "m-ambiguous-progress", "top-plus-later-nested", "--json"],
      missionsRoot,
    );
    const topPlusNestedDir = JSON.parse(createdTopPlusNested.stdout).slice.path as string;
    const topPlusNestedName = path.basename(topPlusNestedDir);
    const topPlusNestedSpecPath = path.join(topPlusNestedDir, "SPEC.md");
    const topPlusNestedProgressPath = path.join(topPlusNestedDir, "PROGRESS.md");
    const topPlusNestedEvidencePath = path.join(topPlusNestedDir, "evidence.txt");
    const topPlusNestedId = String(readFrontmatter(topPlusNestedSpecPath).id ?? "OPR.1.0.1.2");
    writeFile(
      topPlusNestedSpecPath,
      [
        "---",
        `id: ${topPlusNestedId}`,
        "status: active",
        "---",
        "# top-plus-later-nested",
        "",
        "## Intent",
        "Verify pre-mutation refusal when later nested status overrides top-level status in line-based readers.",
        "",
        "## Mini-requirements",
        "1. Preserve every file byte-for-byte on refusal.",
        "",
        "## Proof contract",
        "- [x] Verified pre-mutation refusal <!-- proof-item: nested-refusal-item -->",
        "",
      ].join("\n"),
    );
    writeFile(topPlusNestedEvidencePath, "Evidence for top-plus-later-nested.\n");
    writeFile(
      topPlusNestedProgressPath,
      [
        "---",
        "doc: slice-progress",
        "status: active",
        "checks:",
        "  status: active",
        "---",
        "# Progress — top-level plus later nested status",
        "",
        "- Both top-level and nested status keys.",
        "",
      ].join("\n"),
    );
    const preTopPlusNestedReadiness = readSliceReadiness(topPlusNestedDir);
    recordJudgment(
      missionsRoot,
      {
        scope: `m-ambiguous-progress/slices/${topPlusNestedName}`,
        item: preTopPlusNestedReadiness.items[0]!.id,
        verdict: "accept",
        reason: "Verified baseline",
        evidence: ["evidence.txt"],
        expectedRevision: preTopPlusNestedReadiness.items[0]!.revision,
        expectedPrevious: null,
      },
      "judge@trial",
      "transport:v1",
    );
    expect(readSliceReadiness(topPlusNestedDir).state).toBe("ready");

    commitAll(projectRoot, "seed ambiguous nested progress status slices");

    const missionManifestPath = path.join(nestedOnly.missionDir, "mission.yaml");
    const nestedOnlySpecPath = path.join(nestedOnly.sliceDir, "SPEC.md");
    const nestedOnlyEvidencePath = path.join(nestedOnly.sliceDir, "proof", "evidence.md");
    const nestedOnlyJudgmentPath = path.join(nestedOnly.sliceDir, "proof", "judgments", "00000001.md");
    const topPlusNestedJudgmentPath = path.join(topPlusNestedDir, "proof", "judgments", "00000001.md");

    const beforeManifest = fs.readFileSync(missionManifestPath, "utf8");
    const beforeNestedOnlySpec = fs.readFileSync(nestedOnlySpecPath, "utf8");
    const beforeNestedOnlyProgress = fs.readFileSync(nestedOnlyProgressPath, "utf8");
    const beforeNestedOnlyEvidence = fs.readFileSync(nestedOnlyEvidencePath, "utf8");
    const beforeNestedOnlyJudgment = fs.readFileSync(nestedOnlyJudgmentPath, "utf8");
    const beforeTopSpec = fs.readFileSync(topPlusNestedSpecPath, "utf8");
    const beforeTopProgress = fs.readFileSync(topPlusNestedProgressPath, "utf8");
    const beforeTopEvidence = fs.readFileSync(topPlusNestedEvidencePath, "utf8");
    const beforeTopJudgment = fs.readFileSync(topPlusNestedJudgmentPath, "utf8");

    const { db, indexer, app } = mountSlicesApi(missionsRoot, projectRoot);
    try {
      const closeNestedOnly = await runScope(
        ["slice", "close", nestedOnly.sliceName, "--mission", "m-ambiguous-progress", "--in-place", "--reason", "delivered", "--json"],
        missionsRoot,
      );
      expect(closeNestedOnly.exitCode).toBe(1);
      const nestedOnlyError = JSON.parse(closeNestedOnly.stdout) as {
        ok: boolean;
        error: { fact: string; consequence: string; action: string };
      };
      expect(nestedOnlyError.ok).toBe(false);
      expect(nestedOnlyError.error.fact).toContain(nestedOnlyProgressPath);
      expect(nestedOnlyError.error.fact).toContain('nested "status:" entry');
      expect(nestedOnlyError.error.consequence).toContain("before any file was modified");
      expect(nestedOnlyError.error.action).toContain("top-level scalar");

      const closeTopPlusNested = await runScope(
        ["slice", "close", topPlusNestedName, "--mission", "m-ambiguous-progress", "--in-place", "--reason", "deferred"],
        missionsRoot,
      );
      expect(closeTopPlusNested.exitCode).toBe(1);
      expect(closeTopPlusNested.stdout).toBe("");
      expect(closeTopPlusNested.stderr).toContain(topPlusNestedProgressPath);
      expect(closeTopPlusNested.stderr).toContain('nested "status:" entry');
      expect(closeTopPlusNested.stderr).toContain("before any file was modified");

      // Exact byte-equality across mission.yaml, SPEC.md, PROGRESS.md, evidence, and proof judgment receipts:
      expect(fs.readFileSync(missionManifestPath, "utf8")).toBe(beforeManifest);
      expect(fs.readFileSync(nestedOnlySpecPath, "utf8")).toBe(beforeNestedOnlySpec);
      expect(fs.readFileSync(nestedOnlyProgressPath, "utf8")).toBe(beforeNestedOnlyProgress);
      expect(fs.readFileSync(nestedOnlyEvidencePath, "utf8")).toBe(beforeNestedOnlyEvidence);
      expect(fs.readFileSync(nestedOnlyJudgmentPath, "utf8")).toBe(beforeNestedOnlyJudgment);
      expect(fs.readFileSync(topPlusNestedSpecPath, "utf8")).toBe(beforeTopSpec);
      expect(fs.readFileSync(topPlusNestedProgressPath, "utf8")).toBe(beforeTopProgress);
      expect(fs.readFileSync(topPlusNestedEvidencePath, "utf8")).toBe(beforeTopEvidence);
      expect(fs.readFileSync(topPlusNestedJudgmentPath, "utf8")).toBe(beforeTopJudgment);

      // Proof readiness and CLI / SliceIndexer / GET /api/slices status remain 100% consistent ("active"):
      expect(readSliceReadiness(nestedOnly.sliceDir).state).toBe("ready");
      expect(readSliceReadiness(topPlusNestedDir).state).toBe("ready");

      const activeApi = (await (await app.request("/api/slices?filter=active&refresh=1")).json()) as {
        slices: Array<{ name: string; status: string; rawStatus: string }>;
      };
      expect(activeApi.slices.map((s) => s.name).sort()).toEqual([nestedOnly.sliceName, topPlusNestedName]);
      expect(indexer.get(nestedOnly.sliceName)?.status).toBe("active");
      expect(indexer.get(topPlusNestedName)?.status).toBe("active");

      const cliActive = JSON.parse(
        (await runScope(["slice", "ls", "--mission", "m-ambiguous-progress", "--state", "active", "--json"], missionsRoot)).stdout,
      ).slices as Array<{ name: string }>;
      expect(cliActive.map((s) => s.name).sort()).toEqual([nestedOnly.sliceName, topPlusNestedName]);
    } finally {
      db.close();
    }
  });

  it("reports proofApplicability as unevaluated and transitions readiness to unknown when accepted evidence cites SPEC.md or mission.yaml mutated by in-place close", async () => {
    // 1. Judgment citing SPEC.md becomes unknown when delivered --in-place updates SPEC.md status/closed-on.
    expect((await runScope(["mission", "create", "m-cited-evidence", "--json"], missionsRoot)).exitCode).toBe(0);
    const createdCitedSpec = await runScope(["slice", "create", "m-cited-evidence", "cited-spec", "--json"], missionsRoot);
    const citedSpecDir = JSON.parse(createdCitedSpec.stdout).slice.path as string;
    const citedSpecName = path.basename(citedSpecDir);
    const citedSpecId = String(readFrontmatter(path.join(citedSpecDir, "SPEC.md")).id ?? "OPR.1.0.1.1");
    writeFile(
      path.join(citedSpecDir, "SPEC.md"),
      [
        "---",
        `id: ${citedSpecId}`,
        "status: active",
        "---",
        "# cited-spec",
        "",
        "## Intent",
        "Judgment cites SPEC.md directly.",
        "",
        "## Mini-requirements",
        "1. Verify cited node hashing.",
        "",
        "## Proof contract",
        "- [x] Verified node-cited item <!-- proof-item: cited-spec-item -->",
        "",
      ].join("\n"),
    );

    const preSpecReadiness = readSliceReadiness(citedSpecDir);
    recordJudgment(
      missionsRoot,
      {
        scope: `m-cited-evidence/slices/${citedSpecName}`,
        item: preSpecReadiness.items[0]!.id,
        verdict: "accept",
        reason: "Verified against SPEC.md bytes",
        evidence: ["SPEC.md"],
        expectedRevision: preSpecReadiness.items[0]!.revision,
        expectedPrevious: null,
      },
      "judge@trial",
      "transport:v1",
    );
    expect(readSliceReadiness(citedSpecDir).state).toBe("ready");
    const citedSpecReceiptPath = path.join(citedSpecDir, "proof", "judgments", "00000001.md");
    const beforeSpecReceipt = fs.readFileSync(citedSpecReceiptPath, "utf8");

    // 2. Judgment citing ../../mission.yaml becomes unknown when non-delivery --in-place updates mission.yaml active=false.
    const createdCitedManifest = await runScope(["slice", "create", "m-cited-evidence", "cited-manifest", "--json"], missionsRoot);
    const citedManifestDir = JSON.parse(createdCitedManifest.stdout).slice.path as string;
    const citedManifestName = path.basename(citedManifestDir);
    const citedManifestId = String(readFrontmatter(path.join(citedManifestDir, "SPEC.md")).id ?? "OPR.1.0.1.2");
    writeFile(
      path.join(citedManifestDir, "SPEC.md"),
      [
        "---",
        `id: ${citedManifestId}`,
        "status: active",
        "---",
        "# cited-manifest",
        "",
        "## Intent",
        "Judgment cites mission.yaml.",
        "",
        "## Mini-requirements",
        "1. Verify cited manifest hashing.",
        "",
        "## Proof contract",
        "- [x] Verified manifest-cited item <!-- proof-item: cited-manifest-item -->",
        "",
      ].join("\n"),
    );
    const preManifestReadiness = readSliceReadiness(citedManifestDir);
    recordJudgment(
      missionsRoot,
      {
        scope: `m-cited-evidence/slices/${citedManifestName}`,
        item: preManifestReadiness.items[0]!.id,
        verdict: "accept",
        reason: "Verified against mission.yaml bytes",
        evidence: ["../../mission.yaml"],
        expectedRevision: preManifestReadiness.items[0]!.revision,
        expectedPrevious: null,
      },
      "judge@trial",
      "transport:v1",
    );
    expect(readSliceReadiness(citedManifestDir).state).toBe("ready");
    const citedManifestReceiptPath = path.join(citedManifestDir, "proof", "judgments", "00000001.md");
    const beforeManifestReceipt = fs.readFileSync(citedManifestReceiptPath, "utf8");
    commitAll(projectRoot, "seed cited evidence slices");

    // Close cited-spec in place (delivered --json)
    const closeSpecRes = await runScope(
      ["slice", "close", citedSpecName, "--mission", "m-cited-evidence", "--in-place", "--reason", "delivered", "--json"],
      missionsRoot,
    );
    expect(closeSpecRes.exitCode).toBe(0);
    expect(fs.readFileSync(citedSpecReceiptPath, "utf8")).toBe(beforeSpecReceipt);
    const afterSpecReadiness = readSliceReadiness(citedSpecDir);
    expect(afterSpecReadiness.state).toBe("unknown");
    expect(afterSpecReadiness.items[0]!.state).toBe("unknown");
    const closeSpecPayload = JSON.parse(closeSpecRes.stdout);
    expect(closeSpecPayload.closed.proofApplicability).toEqual({
      evaluated: false,
      changed: null,
      pathPreserved: true,
      receiptFilesPreserved: true,
      judgmentCount: 1,
    });

    // Close cited-manifest in place (deferred human output)
    const closeManifestHuman = await runScope(
      ["slice", "close", citedManifestName, "--mission", "m-cited-evidence", "--in-place", "--reason", "deferred"],
      missionsRoot,
    );
    expect(closeManifestHuman.exitCode).toBe(0);
    expect(closeManifestHuman.stdout).toContain("applicability not evaluated");
    expect(fs.readFileSync(citedManifestReceiptPath, "utf8")).toBe(beforeManifestReceipt);
    const afterManifestReadiness = readSliceReadiness(citedManifestDir);
    expect(afterManifestReadiness.state).toBe("unknown");
    expect(afterManifestReadiness.items[0]!.state).toBe("unknown");
  });
});
