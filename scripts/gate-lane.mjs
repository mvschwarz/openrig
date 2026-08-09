#!/usr/bin/env node
// F1 gate-lane runner ENTRYPOINT (arch d6a6c1db, mechanism (B) bound-port, 5 pins). Wires the machine-wide
// mutex (gate-lane-lock) + the honesty-gap legs + the C2 verdict (gate-lane-run) into one gate:
//   acquire lane (non-blocking) → refuse+teach+exit-nonzero on contention (P5) → observe foreign load
//   (advisory, recorded) → run BOTH legs (typecheck AND vitest AND vitest:ui — the two honesty gaps) →
//   write the C2 verdict (green carries the load it ran under) → release (kernel also frees on death).
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, realpathSync, unlinkSync, lstatSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join, dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";
import { renderRefusal, runGate, observeForeignLoad, cleanStaleVendoredBundle } from "./gate-lane-run.mjs";
import { checkDependencyRoot } from "./gate-lane-hermeticity.mjs";

const RUNTIME_DIR = (() => { const d = join(tmpdir(), "openrig-gate"); mkdirSync(d, { recursive: true }); return d; })();
const HOLDER_INFO = join(RUNTIME_DIR, "gate-lane.holder.json");
const VERDICT_PATH = process.env.OPENRIG_GATE_VERDICT ?? join(process.cwd(), "gate-lane-verdict.json");
const SMOKE = process.env.OPENRIG_GATE_LANE_SMOKE === "1"; // skip the real legs (mutex/verdict wiring smoke)

// F1 exclusion-ledger seed (empty by design). Absent/corrupt → treat as EMPTY (strict gate), never a
// silent skip. cutCeiling comes from the seed so the desk owns it in one place.
const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), "gate-lane-exclusions.json");
function loadLedger() {
  try {
    const doc = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return { entries: Array.isArray(doc.entries) ? doc.entries : [], cutCeiling: doc.cutCeiling };
  } catch {
    return { entries: [], cutCeiling: undefined };
  }
}

function snapshotProcesses() {
  try {
    return execSync("ps -eo pid,comm", { encoding: "utf8" }).trim().split("\n").slice(1)
      .map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), command: m[2] } : null; })
      .filter(Boolean);
  } catch { return []; }
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function readCandidateSha(repoRoot) {
  const sha = runGit(["rev-parse", "HEAD"], repoRoot).trim();
  if (!sha) throw new Error("candidate HEAD is empty");
  return sha;
}

function canonicalizeDestination(destination) {
  let cursor = resolve(destination);
  const missingSegments = [];
  while (true) {
    let exists = true;
    try {
      lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      return resolve(realpathSync(cursor), ...missingSegments);
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve verdict destination: ${destination}`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

function resolveVerdictDestination(repoRoot) {
  const root = realpathSync(repoRoot);
  const absolutePath = canonicalizeDestination(VERDICT_PATH);
  const rel = relative(root, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`verdict destination must be inside the current worktree: ${absolutePath}`);
  }
  const relativePath = rel.split(sep).join("/");
  const tracked = runGit(["--literal-pathspecs", "ls-files", "-z", "--", relativePath], repoRoot)
    .split("\0")
    .filter(Boolean);
  if (tracked.includes(relativePath)) {
    throw new Error(`verdict destination must be untracked: ${relativePath}`);
  }
  return { absolutePath, relativePath };
}

function assertCandidateClean(repoRoot, verdictRelativePath) {
  const records = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot)
    .split("\0")
    .filter(Boolean);
  const unexpected = records.filter((record) => {
    if (record.length < 4 || record[2] !== " ") return true;
    return record.slice(3).split(sep).join("/") !== verdictRelativePath;
  });
  if (unexpected.length > 0) {
    throw new Error(`candidate worktree is dirty: ${unexpected.join(" | ")}`);
  }
}

function invalidatePriorVerdict(verdictPath) {
  try {
    unlinkSync(verdictPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const lane = await acquireGateLane({ port: GATE_LANE_PORT, holderInfoPath: HOLDER_INFO });
  if (!lane.ok) {
    console.error(renderRefusal(lane, GATE_LANE_PORT));
    process.exit(2); // hard-refuse, non-blocking (never block-wait)
  }
  let exitCode = 3;
  try {
    const repoRoot = process.cwd();
    const verdictDestination = resolveVerdictDestination(repoRoot);
    // This acquired run supersedes every earlier receipt, including for the same HEAD.
    invalidatePriorVerdict(verdictDestination.absolutePath);
    const foreignLoad = observeForeignLoad({ loadavg: loadavg(), processes: snapshotProcesses() });
    if (foreignLoad.advisory.length) console.warn(`⚠ advisory (exit UNCHANGED, recorded in verdict): ${foreignLoad.advisory.join("; ")}`);
    // Bind the run to one clean, worktree-local candidate BEFORE the first repository mutation.
    const candidateSha = readCandidateSha(repoRoot);
    assertCandidateClean(repoRoot, verdictDestination.relativePath);
    checkDependencyRoot(repoRoot);
    // SOURCE-TRUTH: drop any stale vendored daemon bundle (a gitignored build:package leftover) before
    // the legs run, so test:repo's freshness guard is never poisoned by a desk leftover. Real package-time
    // assembly is still guarded; a fresh checkout is a no-op.
    const removedBundle = cleanStaleVendoredBundle(process.cwd());
    console.log(`[gate] source-truth: cleaned any stale vendored bundle at ${removedBundle}`);
    // The REAL executor is injected into runGate (the skip branch lives INSIDE runGate). A smoke run
    // never reaches spawnSync — runGate picks the skip branch on smoke=true.
    const realExec = async (cmd) => { const r = spawnSync(cmd, { shell: true, stdio: "inherit" }); return { ok: r.status === 0, code: r.status }; };
    const { entries: ledger, cutCeiling } = loadLedger();
    // SELF-DESCRIBING verdict via the ONE wiring origin (gate-lane-run.mjs:runGate): the SAME SMOKE
    // picks the executor AND flows into the verdict, so the two can never disagree. The gate's own
    // negative-control test calls THIS SAME runGate — it guards this shipped path, not a lookalike.
    const verdict = await runGate({ smoke: SMOKE, realExec, foreignLoad, startedAt, ledger, cutCeiling });
    const endingSha = readCandidateSha(repoRoot);
    if (endingSha !== candidateSha) {
      throw new Error(`candidate HEAD changed during gate (started ${candidateSha}, ended ${endingSha})`);
    }
    assertCandidateClean(repoRoot, verdictDestination.relativePath);
    checkDependencyRoot(repoRoot);
    verdict.candidateSha = candidateSha;
    mkdirSync(dirname(verdictDestination.absolutePath), { recursive: true }); // ensure the verdict's home exists
    writeFileSync(verdictDestination.absolutePath, JSON.stringify(verdict, null, 2));
    console.log(verdict.ledgerState); // in-band LOUD: name every exclusion (or "0 exclusions")
    console.log(`gate: ${verdict.gate.toUpperCase()} — verdict → ${verdictDestination.absolutePath} (legs: ${verdict.legs.map((l) => `${l.name}=${l.ok ? "ok" : "FAIL"}`).join(", ")})`);
    exitCode = verdict.gate === "pass" ? 0 : 1;
  } catch (e) {
    console.error("gate-lane legs threw:", e?.stack ?? e);
    exitCode = 3;
  } finally {
    await lane.release(); // release BEFORE exit (kernel also frees the port on death)
  }
  process.exit(exitCode);
}
main().catch((e) => { console.error("gate-lane runner threw:", e?.stack ?? e); process.exit(3); });
