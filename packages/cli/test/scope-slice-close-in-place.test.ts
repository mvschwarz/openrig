import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import YAML from "yaml";
import { scopeCommand } from "../src/commands/scope.js";
import { readFrontmatter } from "../src/lib/scope/scope-fs.js";
import {
  readMissionReadiness,
  readSliceReadiness,
  recordJudgment,
} from "../../daemon/src/domain/proof/judgments.js";

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
        changed: false,
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
        changed: true,
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

    // Audit: in-place non-delivery closures must not trigger missing_proof.
    const auditRes = await runScope(["audit", "--mission", "m-mixed", "--json"], missionsRoot);
    expect(auditRes.exitCode).toBe(0);
    const auditPayload = JSON.parse(auditRes.stdout);
    const missingProofPaths = [
      ...(auditPayload.buckets?.medium ?? []),
      ...(auditPayload.buckets?.high ?? []),
    ]
      .filter((item: { findings: Array<{ kind: string }> }) => item.findings.some((f) => f.kind === "missing_proof"))
      .map((item: { path: string }) => item.path);
    expect(missingProofPaths).toEqual([]);
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
});
