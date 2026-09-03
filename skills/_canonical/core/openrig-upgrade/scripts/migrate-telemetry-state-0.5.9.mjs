#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA = "openrig-telemetry-state-migration/v1";
const rig = process.env.OPENRIG_RIG_BIN || "rig";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function emit(report, status = 0) {
  const stream = status === 0 ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(status);
}

function issue(code, pathValue, next, extra = {}) {
  return { code, ...(pathValue ? { path: pathValue } : {}), ...extra, next };
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inventoryClaudeSeats(issues) {
  const result = spawnSync(rig, ["ps", "--nodes", "-A", "--json", "--full"], { encoding: "utf8" });
  if (result.status !== 0) {
    issues.push(issue(
      "inventory_unavailable",
      null,
      `run ${rig} ps --nodes -A --json --full and restore daemon inventory before retrying`,
      { diagnostic: result.stderr?.trim() || result.stdout?.trim() || "command produced no diagnostic" },
    ));
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(entries) || parsed.truncated === true) throw new Error("inventory is missing or truncated");
    return entries.filter((entry) => entry.runtime === "claude-code" && entry.sessionStatus === "running");
  } catch (error) {
    issues.push(issue("inventory_unavailable", null, "obtain one complete untruncated node inventory before retrying", {
      diagnostic: error.message,
    }));
    return [];
  }
}

function targetIssue(target) {
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (fs.existsSync(cursor) && !fs.statSync(cursor).isDirectory()) {
    return issue("unwriteable_target", target, "replace the non-directory ancestor or choose the correct OpenRig home before apply", {
      blockingPath: cursor,
    });
  }
  if (!fs.existsSync(target)) return null;
  if (!fs.statSync(target).isDirectory()) {
    return issue("unwriteable_target", target, "preserve the non-directory target and repair the path before apply");
  }
  if (fs.readdirSync(target).length > 0) {
    return issue("target_nonempty", target, "inspect and reconcile the existing target; this helper never overwrites it");
  }
  return null;
}

function scanLegacy(directory, kind, destination, issues) {
  if (!fs.existsSync(directory)) return [];
  if (!fs.statSync(directory).isDirectory()) {
    issues.push(issue("foreign_file", directory, "preserve the path and identify the real legacy telemetry directory"));
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json.tmp")) continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      issues.push(issue("foreign_file", source, "move or classify the non-telemetry entry before applying this bounded migration"));
      continue;
    }
    const parsed = readJson(source);
    const identity = kind === "context" ? parsed?.session_name : parsed?.seatSession;
    const timestamp = kind === "context" ? parsed?.sampled_at : parsed?.asOf;
    if (typeof identity !== "string" || identity.length === 0
      || typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
      issues.push(issue("malformed_sidecar", source, `repair or archive the malformed ${kind} sidecar before apply`));
      continue;
    }
    files.push({
      kind,
      source,
      destination: path.join(destination, entry.name),
      sessionName: identity,
      bytes: fs.readFileSync(source),
      mode: fs.statSync(source).mode & 0o777,
    });
  }
  return files;
}

function collectorActions(home, seats, issues) {
  const legacyContext = path.join(home, "context");
  const legacyProvider = path.join(home, "provider-usage");
  const nextContext = path.join(home, "state", "context-usage");
  const nextProvider = path.join(home, "state", "provider-usage");
  const actions = [];
  const seenSettings = new Set();

  for (const seat of seats) {
    const sessionName = seat.canonicalSessionName || seat.sessionName;
    if (typeof seat.cwd !== "string" || seat.cwd.length === 0) {
      issues.push(issue("unknown_live_cwd", null, "resolve the running Claude seat's cwd before rewriting its collector", {
        sessionName: typeof sessionName === "string" ? sessionName : null,
      }));
      continue;
    }
    const settingsPath = path.join(seat.cwd, ".claude", "settings.local.json");
    if (seenSettings.has(settingsPath)) continue;
    seenSettings.add(settingsPath);
    const settings = readJson(settingsPath);
    const command = settings?.statusLine?.command;
    if (typeof command !== "string" || !command.includes(".openrig/context-collector.cjs")) {
      issues.push(issue("collector_projection_missing", settingsPath, "re-project the OpenRig Claude collector or identify the seat as unmanaged before apply", {
        sessionName: typeof sessionName === "string" ? sessionName : null,
      }));
      continue;
    }
    if (!command.includes(legacyContext) || !command.includes(legacyProvider)) {
      issues.push(issue("collector_projection_mismatch", settingsPath, "inspect the collector command and reconcile its two legacy roots before apply", {
        sessionName: typeof sessionName === "string" ? sessionName : null,
      }));
      continue;
    }

    const original = fs.readFileSync(settingsPath);
    const rewrittenSettings = {
      ...settings,
      statusLine: {
        ...settings.statusLine,
        command: command.replaceAll(legacyContext, nextContext).replaceAll(legacyProvider, nextProvider),
      },
    };
    actions.push({
      sessionName,
      path: settingsPath,
      original,
      originalMode: fs.statSync(settingsPath).mode & 0o777,
      rewritten: Buffer.from(JSON.stringify(rewrittenSettings, null, 2)),
    });
  }
  return actions;
}

function buildPlan(home) {
  const issues = [];
  const roots = {
    legacyContext: path.join(home, "context"),
    legacyProvider: path.join(home, "provider-usage"),
    contextUsage: path.join(home, "state", "context-usage"),
    providerUsage: path.join(home, "state", "provider-usage"),
  };
  for (const target of [roots.contextUsage, roots.providerUsage]) {
    const found = targetIssue(target);
    if (found) issues.push(found);
  }
  const telemetry = [
    ...scanLegacy(roots.legacyContext, "context", roots.contextUsage, issues),
    ...scanLegacy(roots.legacyProvider, "provider", roots.providerUsage, issues),
  ];
  const seats = inventoryClaudeSeats(issues);
  const collectors = collectorActions(home, seats, issues);
  return { roots, telemetry, seats, collectors, issues };
}

function publicPlan(home, plan) {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "plan",
    applied: false,
    complete: plan.issues.length === 0,
    roots: plan.roots,
    actions: [
      ...plan.telemetry.map((item) => ({ decision: "copy", kind: item.kind, from: item.source, to: item.destination, sha256: sha256(item.bytes) })),
      ...plan.collectors.map((item) => ({ decision: "rewrite-collector", sessionName: item.sessionName, path: item.path })),
    ],
    issues: plan.issues,
    next: plan.issues.length === 0
      ? "choose an unused --preimage path and rerun with --apply-state"
      : "resolve every issue; plan mode changed nothing",
  };
}

function atomicWrite(destination, bytes, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.openrig-telemetry-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function storePreimage(preimage, records) {
  if (fs.existsSync(preimage)) {
    emit({ schema: SCHEMA, phase: "apply-state", ok: false, issues: [issue(
      "preimage_exists",
      preimage,
      "choose a new preimage path; this helper never overwrites one",
    )] }, 1);
  }
  fs.mkdirSync(preimage, { recursive: true });
  const files = records.map((record, index) => {
    const digest = sha256(record.bytes);
    const storedAs = path.join("files", `${String(index).padStart(4, "0")}-${digest}`);
    const storedPath = path.join(preimage, storedAs);
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    fs.writeFileSync(storedPath, record.bytes, { flag: "wx", mode: record.mode });
    return { ...record.public, storedAs, sha256: digest, mode: record.mode };
  });
  return files;
}

function loadManifest(preimage, home, phase) {
  const manifestPath = path.join(preimage, "manifest.json");
  const manifest = readJson(manifestPath);
  if (manifest?.schema !== SCHEMA || manifest.home !== home || !Array.isArray(manifest.files)) {
    emit({ schema: SCHEMA, phase, ok: false, issues: [issue(
      "preimage_manifest_mismatch",
      manifestPath,
      "use the exact preimage emitted by this home's apply-state receipt",
    )] }, 1);
  }
  return manifest;
}

function validatePreimage(preimage, manifest) {
  const issues = [];
  for (const file of manifest.files) {
    const storedPath = path.resolve(preimage, file.storedAs);
    if (!storedPath.startsWith(`${path.resolve(preimage)}${path.sep}`) || !fs.existsSync(storedPath)
      || sha256(fs.readFileSync(storedPath)) !== file.sha256) {
      issues.push(issue("preimage_mismatch", storedPath, "restore the byte-matching preimage before rollback", {
        originalPath: file.originalPath,
      }));
    }
  }
  return issues;
}

function contextFilenameForSession(home, preimage, manifest, sessionName) {
  const preservedSource = manifest.files.find((file) => {
    if (file.kind !== "context-source") return false;
    return readJson(path.join(preimage, file.storedAs))?.session_name === sessionName;
  });
  if (preservedSource) return path.basename(preservedSource.originalPath);

  const directory = path.join(home, "state", "context-usage");
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return null;
  return fs.readdirSync(directory, { withFileTypes: true })
    .find((entry) => entry.isFile() && readJson(path.join(directory, entry.name))?.session_name === sessionName)?.name ?? null;
}

function applyState(home, preimage) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "apply-state", ok: false, issues: [issue(
      "preimage_required",
      null,
      "pass --preimage with a new path under a protected backup root",
    )] }, 1);
  }
  const plan = buildPlan(home);
  if (plan.issues.length > 0) emit({ ...publicPlan(home, plan), phase: "apply-state", ok: false }, 1);

  const records = [
    ...plan.telemetry.map((item) => ({
      bytes: item.bytes,
      mode: item.mode,
      public: { kind: `${item.kind}-source`, originalPath: item.source },
    })),
    ...plan.collectors.map((item) => ({
      bytes: item.original,
      mode: item.originalMode,
      public: { kind: "settings", originalPath: item.path, appliedSha256: sha256(item.rewritten) },
    })),
  ];
  const files = storePreimage(preimage, records);
  const manifestPath = path.join(preimage, "manifest.json");
  const prepared = { schema: SCHEMA, home, status: "prepared", createdAt: new Date().toISOString(), files };
  fs.writeFileSync(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`, { flag: "wx" });

  try {
    fs.mkdirSync(plan.roots.contextUsage, { recursive: true });
    fs.mkdirSync(plan.roots.providerUsage, { recursive: true });
    for (const item of plan.telemetry) {
      fs.copyFileSync(item.source, item.destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(item.destination, item.mode);
      if (sha256(fs.readFileSync(item.destination)) !== sha256(item.bytes)) throw new Error(`copy verification failed: ${item.destination}`);
    }
    for (const item of plan.collectors) {
      if (sha256(fs.readFileSync(item.path)) !== sha256(item.original)) throw new Error(`collector settings changed during apply: ${item.path}`);
      atomicWrite(item.path, item.rewritten, item.originalMode);
    }
  } catch (error) {
    emit({
      schema: SCHEMA,
      phase: "apply-state",
      ok: false,
      applied: false,
      complete: false,
      preimage,
      issues: [issue("unwriteable_target", null, "inspect the preserved preimage and partial target state; resolve before retrying", {
        diagnostic: error.message,
      })],
    }, 1);
  }

  const appliedAt = new Date().toISOString();
  atomicWrite(manifestPath, Buffer.from(`${JSON.stringify({ ...prepared, status: "applied", appliedAt }, null, 2)}\n`), 0o600);
  emit({
    schema: SCHEMA,
    generatedAt: appliedAt,
    home,
    phase: "apply-state",
    applied: true,
    complete: false,
    preimage,
    copied: plan.telemetry.map((item) => item.destination),
    rewrittenCollectors: plan.collectors.map((item) => item.path),
    issues: [],
    next: "restart or freshly launch one Claude process, wait for a fresh sample at both state roots, then run --verify with this --preimage",
  });
}

function sampleTime(filePath, identityKey, timeKey, expectedSession, issues) {
  const parsed = readJson(filePath);
  if (!parsed) {
    if (fs.existsSync(filePath)) issues.push(issue("malformed_sidecar", filePath, "repair the malformed sidecar and obtain a fresh sample"));
    return null;
  }
  if (parsed[identityKey] !== expectedSession || typeof parsed[timeKey] !== "string") {
    issues.push(issue("malformed_sidecar", filePath, "repair the sidecar identity or timestamp and obtain a fresh sample"));
    return null;
  }
  const time = Date.parse(parsed[timeKey]);
  if (Number.isNaN(time)) {
    issues.push(issue("malformed_sidecar", filePath, "repair the sidecar timestamp and obtain a fresh sample"));
    return null;
  }
  return time;
}

function verify(home, preimage) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "verify", ok: false, issues: [issue("preimage_required", null, "pass the apply-state --preimage path")] }, 1);
  }
  const manifest = loadManifest(preimage, home, "verify");
  const issues = validatePreimage(preimage, manifest);
  if (manifest.status !== "applied" || typeof manifest.appliedAt !== "string") {
    issues.push(issue("preimage_manifest_mismatch", path.join(preimage, "manifest.json"), "use a completed apply-state preimage"));
  }
  const appliedAt = Date.parse(manifest.appliedAt);
  const seats = inventoryClaudeSeats(issues);
  const freshSamples = [];
  for (const seat of seats) {
    const sessionName = seat.canonicalSessionName || seat.sessionName;
    if (typeof sessionName !== "string") continue;
    const filename = contextFilenameForSession(home, preimage, manifest, sessionName);
    if (!filename) continue;
    const contextPath = path.join(home, "state", "context-usage", filename);
    const providerPath = path.join(home, "state", "provider-usage", filename);
    const contextAt = sampleTime(contextPath, "session_name", "sampled_at", sessionName, issues);
    const providerAt = sampleTime(providerPath, "seatSession", "asOf", sessionName, issues);
    if (contextAt !== null && providerAt !== null && contextAt > appliedAt && providerAt > appliedAt) {
      freshSamples.push({ sessionName, contextPath, providerPath, sampledAt: new Date(Math.min(contextAt, providerAt)).toISOString() });
    }
  }

  const legacyTelemetry = [
    ...scanLegacy(path.join(home, "context"), "context", path.join(home, "state", "context-usage"), issues),
    ...scanLegacy(path.join(home, "provider-usage"), "provider", path.join(home, "state", "provider-usage"), issues),
  ];
  for (const file of legacyTelemetry) {
    const current = readJson(file.source);
    const timeKey = file.kind === "context" ? "sampled_at" : "asOf";
    const identityKey = file.kind === "context" ? "session_name" : "seatSession";
    const observedAt = Date.parse(current[timeKey]);
    if (!Number.isNaN(observedAt) && observedAt > appliedAt) {
      issues.push(issue("legacy_writer_active", file.source, "restart or freshly launch the named Claude process so it adopts the rewritten statusLine", {
        sessionName: current[identityKey],
        observedAt: current[timeKey],
      }));
    }
  }
  if (freshSamples.length === 0) {
    issues.push(issue("missing_fresh_sample", path.join(home, "state", "context-usage"), "obtain one post-apply Claude sample at both new telemetry roots before declaring migration complete"));
  }

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "verify",
    verified: issues.length === 0,
    complete: issues.length === 0,
    preimage,
    freshSamples,
    issues,
    next: issues.length === 0 ? "telemetry state relocation is verified" : "resolve the named incomplete state and rerun verify",
  };
  emit(report, issues.length === 0 ? 0 : 1);
}

function rollback(home, preimage) {
  const manifest = loadManifest(preimage, home, "rollback");
  const preimageIssues = validatePreimage(preimage, manifest);
  if (preimageIssues.length > 0) {
    emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, issues: preimageIssues }, 1);
  }
  const settings = manifest.files.filter((file) => file.kind === "settings");
  const toRestore = [];
  const alreadyOriginal = [];
  const issues = [];
  for (const file of settings) {
    if (!fs.existsSync(file.originalPath)) {
      issues.push(issue("destination_drift", file.originalPath, "preserve the changed settings and decide the merge manually before rollback"));
      continue;
    }
    const digest = sha256(fs.readFileSync(file.originalPath));
    if (digest === file.appliedSha256) toRestore.push(file);
    else if (digest === file.sha256) alreadyOriginal.push(file.originalPath);
    else issues.push(issue("destination_drift", file.originalPath, "preserve the changed settings and decide the merge manually before rollback"));
  }
  for (const file of toRestore) {
    atomicWrite(file.originalPath, fs.readFileSync(path.join(preimage, file.storedAs)), file.mode);
  }
  if (issues.length > 0) {
    emit({
      schema: SCHEMA,
      phase: "rollback",
      rolledBack: false,
      complete: false,
      preimage,
      restored: toRestore.map((file) => file.originalPath),
      alreadyOriginal,
      issues,
    }, 1);
  }
  emit({
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "rollback",
    rolledBack: true,
    complete: true,
    preimage,
    restored: toRestore.map((file) => file.originalPath),
    alreadyOriginal,
    preserved: [path.join(home, "state", "context-usage"), path.join(home, "state", "provider-usage")],
    issues: [],
    next: "the legacy collector projection is restored; migrated state copies remain preserved for inspection",
  });
}

const homeArg = argument("--home") || process.env.OPENRIG_HOME;
if (!homeArg) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("home_required", null, "pass --home or set OPENRIG_HOME")] }, 1);
}
const home = path.resolve(homeArg);
const apply = process.argv.includes("--apply-state");
const verifyFlag = process.argv.includes("--verify");
const rollbackArg = argument("--rollback");
if ([apply, verifyFlag, Boolean(rollbackArg)].filter(Boolean).length > 1) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("phase_conflict", null, "choose exactly one of --apply-state, --verify, or --rollback")] }, 1);
}

if (apply) applyState(home, argument("--preimage"));
if (verifyFlag) verify(home, argument("--preimage"));
if (rollbackArg) rollback(home, path.resolve(rollbackArg));
emit(publicPlan(home, buildPlan(home)));
