#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA = "openrig-telemetry-state-migration/v1";
const rig = process.env.OPENRIG_RIG_BIN || "rig";
const DEFAULT_SYSTEM_WORLD = `schema: openrig.system-world/v0alpha1
id: openrig-default
version: "0.5.9"
context:
  - ref: onboarding-width
  - ref: world-public
    profiles:
      claude: guided
      codex: codex-coverage
skills: []
`;

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

function lstatOrNull(pathValue) {
  try {
    return fs.lstatSync(pathValue);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function treeSnapshot(root, ignored = new Set()) {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return { digest: null, rootIdentity: null, entries: [] };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`library root is not a real directory: ${root}`);
  }
  const rows = [];
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (ignored.has(relative)) continue;
      const current = fs.lstatSync(absolute);
      const mode = current.mode & 0o777;
      if (current.isSymbolicLink()) {
        const linkTargetBase64 = fs.readlinkSync(absolute, { encoding: "buffer" }).toString("base64");
        const afterRead = fs.lstatSync(absolute);
        if (!afterRead.isSymbolicLink()
          || afterRead.dev !== current.dev
          || afterRead.ino !== current.ino
          || (afterRead.mode & 0o777) !== mode) {
          throw new Error(`symlink changed while being inventoried: ${absolute}`);
        }
        entries.push({
          path: relative,
          type: "symlink",
          mode,
          linkTargetBase64,
          identity: { dev: String(current.dev), ino: String(current.ino) },
        });
        rows.push(`${relative}\0symlink\0${mode}\0${linkTargetBase64}`);
      } else if (current.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode });
        visit(absolute, relative);
      } else if (current.isFile()) {
        const digest = sha256(fs.readFileSync(absolute));
        entries.push({ path: relative, type: "file", mode, sha256: digest });
        // Preserve the pre-symlink regular-file serialization byte-for-byte.
        rows.push(`${relative}\0${mode}\0${digest}`);
      } else {
        throw new Error(`unsupported library entry is not supported: ${absolute}`);
      }
    }
  };
  visit(root);
  return {
    digest: sha256(rows.join("\n")),
    rootIdentity: { dev: String(rootStat.dev), ino: String(rootStat.ino) },
    entries,
  };
}

function treeDigest(root, ignored = new Set()) {
  return treeSnapshot(root, ignored).digest;
}

function librarySourceDrift(sourcePath, message) {
  const drift = new Error(`context library changed after inventory: ${sourcePath}: ${message}`);
  drift.migrationIssueCode = "library_source_drift";
  drift.migrationPath = sourcePath;
  return drift;
}

function assertTreeSnapshot(root, expected, ignored = new Set()) {
  let current;
  try {
    current = treeSnapshot(root, ignored);
  } catch (error) {
    throw librarySourceDrift(root, error.message);
  }
  const rootIdentityChanged = expected.rootIdentity !== null && (
    current.rootIdentity?.dev !== expected.rootIdentity.dev
    || current.rootIdentity?.ino !== expected.rootIdentity.ino
  );
  if (current.digest !== expected.digest || rootIdentityChanged) {
    throw librarySourceDrift(root, "tree digest or root identity no longer matches");
  }
  const currentLinks = new Map(current.entries
    .filter((entry) => entry.type === "symlink")
    .map((entry) => [entry.path, entry]));
  for (const link of expected.entries.filter((entry) => entry.type === "symlink")) {
    const observed = currentLinks.get(link.path);
    if (!observed
      || observed.mode !== link.mode
      || observed.linkTargetBase64 !== link.linkTargetBase64
      || observed.identity.dev !== link.identity.dev
      || observed.identity.ino !== link.identity.ino) {
      throw librarySourceDrift(path.join(root, link.path), "symlink payload, type, mode, or inode no longer matches");
    }
  }
  return current;
}

function regularFileSnapshot(filePath) {
  const before = lstatOrNull(filePath);
  if (!before) throw new Error(`managed file is missing: ${filePath}`);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`managed path is not a regular file: ${filePath}`);
  }
  const mode = before.mode & 0o777;
  const digest = sha256(fs.readFileSync(filePath));
  const after = fs.lstatSync(filePath);
  if (!after.isFile()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o777) !== mode) {
    throw new Error(`managed file changed while being inventoried: ${filePath}`);
  }
  return {
    type: "file",
    mode,
    sha256: digest,
    identity: { dev: String(before.dev), ino: String(before.ino) },
  };
}

function assertRegularFileSnapshot(filePath, expected) {
  if (!expected) throw new Error(`managed file has no recorded identity: ${filePath}`);
  const current = regularFileSnapshot(filePath);
  if (current.type !== expected.type
    || current.mode !== expected.mode
    || current.sha256 !== expected.sha256
    || current.identity.dev !== expected.identity?.dev
    || current.identity.ino !== expected.identity?.ino) {
    throw new Error(`managed file identity no longer matches: ${filePath}`);
  }
  return current;
}

function readLibraryConfig(home, issues) {
  const configPath = path.join(home, "config.json");
  const configExists = fs.existsSync(configPath);
  const config = configExists ? readJson(configPath) : {};
  if (!config) {
    issues.push(issue("config_invalid", configPath, "repair config.json before migrating the context library"));
    return null;
  }
  const context = config.context === undefined ? {} : config.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    issues.push(issue("config_invalid", configPath, "make config.context an object before migrating the context library"));
    return null;
  }
  if (context.packsRoot !== undefined && (typeof context.packsRoot !== "string" || context.packsRoot.length === 0)) {
    issues.push(issue("config_invalid", configPath, "make context.packsRoot a non-empty path or remove it before migration"));
    return null;
  }
  if (context.root !== undefined && (typeof context.root !== "string" || context.root.length === 0)) {
    issues.push(issue("config_invalid", configPath, "make context.root a non-empty path or remove it before migration"));
    return null;
  }
  const defaultLegacyRoot = path.join(home, "context-packs");
  const configuredLegacyRoot = context.packsRoot ? path.resolve(context.packsRoot) : defaultLegacyRoot;
  const targetRoot = configuredLegacyRoot === defaultLegacyRoot ? path.join(home, "context") : configuredLegacyRoot;
  if (context.root !== undefined && path.resolve(context.root) !== targetRoot) {
    issues.push(issue("context_root_conflict", configPath, "reconcile context.root with the legacy context.packsRoot selection before migration", {
      configuredRoot: path.resolve(context.root),
      expectedRoot: targetRoot,
    }));
    return null;
  }
  const nextContext = { ...context };
  delete nextContext.packsRoot;
  if (context.packsRoot !== undefined) nextContext.root = targetRoot;
  const nextConfig = { ...config, ...(Object.keys(nextContext).length > 0 ? { context: nextContext } : {}) };
  if (Object.keys(nextContext).length === 0) delete nextConfig.context;
  return {
    configPath,
    configExists,
    originalConfig: configExists ? fs.readFileSync(configPath) : null,
    nextConfig: Buffer.from(`${JSON.stringify(nextConfig, null, 2)}\n`),
    sourceRoot: configuredLegacyRoot,
    targetRoot,
  };
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

function scanLegacy(directory, kind, destination, issues, managedEmptyDirectories = [], allowedDirectories = []) {
  if (!fs.existsSync(directory)) return [];
  if (!fs.statSync(directory).isDirectory()) {
    issues.push(issue("foreign_file", directory, "preserve the path and identify the real legacy telemetry directory"));
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json.tmp")) continue;
    if (kind === "context" && entry.name === "system" && entry.isDirectory()) {
      if (fs.readdirSync(source).length === 0) {
        managedEmptyDirectories.push(source);
        continue;
      }
      if (allowedDirectories.includes(source)) continue;
    }
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
  const managedEmptyDirectories = [];
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
    ...scanLegacy(roots.legacyContext, "context", roots.contextUsage, issues, managedEmptyDirectories),
    ...scanLegacy(roots.legacyProvider, "provider", roots.providerUsage, issues),
  ];
  const seats = inventoryClaudeSeats(issues);
  const collectors = collectorActions(home, seats, issues);
  const library = readLibraryConfig(home, issues);
  if (library && fs.existsSync(library.sourceRoot) && !fs.statSync(library.sourceRoot).isDirectory()) {
    issues.push(issue("library_source_invalid", library.sourceRoot, "preserve the path and identify the real legacy context library"));
  }
  return { roots, telemetry, seats, collectors, library, managedEmptyDirectories, issues };
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
      ...plan.managedEmptyDirectories.map((pathValue) => ({ decision: "remove-empty-scaffold", path: pathValue })),
      ...(plan.library ? [{
        decision: plan.library.sourceRoot === plan.library.targetRoot ? "retarget-library" : "move-library",
        from: plan.library.sourceRoot,
        to: plan.library.targetRoot,
        systemWorld: path.join(plan.library.targetRoot, "system", "system-world.yaml"),
      }] : []),
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
  const records = [
    ...manifest.files,
    ...(Array.isArray(manifest.postApplyLegacyTails) ? manifest.postApplyLegacyTails : []),
  ];
  for (const file of records) {
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
    ...(plan.library?.originalConfig ? [{
      bytes: plan.library.originalConfig,
      mode: fs.statSync(plan.library.configPath).mode & 0o777,
      public: { kind: "config", originalPath: plan.library.configPath },
    }] : []),
  ];
  const files = storePreimage(preimage, records);
  const manifestPath = path.join(preimage, "manifest.json");
  const prepared = {
    schema: SCHEMA,
    home,
    status: "prepared",
    createdAt: new Date().toISOString(),
    files,
    managedEmptyDirectories: plan.managedEmptyDirectories,
  };
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
    next: "start the exact target daemon, wait for fresh samples at both new state roots after every bounded legacy tail, then run --verify with this --preimage",
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

function managedSystemWorldState(home, manifest, issues, expectedArtifact = undefined) {
  const directory = path.join(home, "context", "system");
  const systemWorldPath = path.join(directory, "system-world.yaml");
  const directories = manifest.managedEmptyDirectories ?? [];
  if (!Array.isArray(directories) || directories.length > 1 || directories.some((entry) => entry !== directory)) {
    issues.push(issue("preimage_manifest_mismatch", directory, "use the exact preimage emitted by this helper"));
    return { directories: [], artifact: null };
  }
  if (directories.length === 0) {
    if (expectedArtifact !== undefined && expectedArtifact !== null) {
      issues.push(issue("verification_receipt_invalid", systemWorldPath, "rerun --verify against this exact home and preimage"));
    }
    return { directories, artifact: null };
  }
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    issues.push(issue("system_world_conflict", directory, "start the exact target daemon and require only its canonical default System World before retrying"));
    return { directories, artifact: null };
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== "system-world.yaml" || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    issues.push(issue("system_world_conflict", directory, "preserve the differing or additional System World content and reconcile it manually"));
    return { directories, artifact: null };
  }
  const bytes = fs.readFileSync(systemWorldPath);
  const artifact = {
    path: systemWorldPath,
    sha256: sha256(bytes),
    mode: fs.statSync(systemWorldPath).mode & 0o777,
  };
  if (artifact.sha256 !== sha256(DEFAULT_SYSTEM_WORLD)) {
    issues.push(issue("system_world_conflict", systemWorldPath, "preserve the differing System World and reconcile it manually"));
  }
  if (expectedArtifact !== undefined && (
    expectedArtifact === null
    || expectedArtifact.path !== artifact.path
    || expectedArtifact.sha256 !== artifact.sha256
    || expectedArtifact.mode !== artifact.mode
  )) {
    issues.push(issue("destination_drift", systemWorldPath, "preserve the changed System World and rerun verification from the exact migration state"));
  }
  return { directories, artifact };
}

function telemetryPair(home, preimage, manifest, sessionName, issues) {
  const filename = contextFilenameForSession(home, preimage, manifest, sessionName);
  if (!filename) return null;
  const contextPath = path.join(home, "state", "context-usage", filename);
  const providerPath = path.join(home, "state", "provider-usage", filename);
  const contextAt = sampleTime(contextPath, "session_name", "sampled_at", sessionName, issues);
  const providerAt = sampleTime(providerPath, "seatSession", "asOf", sessionName, issues);
  if (contextAt === null || providerAt === null) return null;
  return {
    sessionName,
    contextPath,
    providerPath,
    contextAt,
    providerAt,
    sampledAt: new Date(Math.min(contextAt, providerAt)).toISOString(),
  };
}

function legacyTails(manifest, telemetry, appliedAt, issues) {
  const originalByPath = new Map(manifest.files
    .filter((file) => file.kind === "context-source" || file.kind === "provider-source")
    .map((file) => [file.originalPath, file]));
  const tails = [];
  for (const file of telemetry) {
    const original = originalByPath.get(file.source);
    const currentSha256 = sha256(file.bytes);
    if (original && original.sha256 === currentSha256 && original.mode === file.mode) continue;
    const current = readJson(file.source);
    const timeKey = file.kind === "context" ? "sampled_at" : "asOf";
    const identityKey = file.kind === "context" ? "session_name" : "seatSession";
    const observedAt = Date.parse(current?.[timeKey]);
    if (Number.isNaN(observedAt) || observedAt <= appliedAt) {
      issues.push(issue("legacy_source_drift", file.source, "preserve the changed legacy sidecar and rerun the migration from a fresh preimage"));
      continue;
    }
    tails.push({
      kind: file.kind,
      originalPath: file.source,
      sessionName: current[identityKey],
      observedAt: current[timeKey],
      sha256: currentSha256,
      mode: file.mode,
    });
  }
  return tails;
}

function requireTailConvergence(tails, samples, issues) {
  for (const tail of tails) {
    const sample = samples.get(tail.sessionName);
    const observedAt = Date.parse(tail.observedAt);
    if (!sample || sample.contextAt <= observedAt || sample.providerAt <= observedAt) {
      issues.push(issue("legacy_writer_active", tail.originalPath, "obtain newer samples for the named seat at both new state roots, or replace the process if legacy writes continue", {
        sessionName: tail.sessionName,
        observedAt: tail.observedAt,
        ...(sample ? {
          contextObservedAt: new Date(sample.contextAt).toISOString(),
          providerObservedAt: new Date(sample.providerAt).toISOString(),
        } : {}),
      }));
    }
  }
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
  const systemWorld = managedSystemWorldState(home, manifest, issues);
  const legacyTelemetry = [
    ...scanLegacy(path.join(home, "context"), "context", path.join(home, "state", "context-usage"), issues, [], systemWorld.directories),
    ...scanLegacy(path.join(home, "provider-usage"), "provider", path.join(home, "state", "provider-usage"), issues),
  ];
  const tails = legacyTails(manifest, legacyTelemetry, appliedAt, issues);
  const seats = inventoryClaudeSeats(issues);
  const sampleSessions = new Set(tails.map((tail) => tail.sessionName));
  for (const seat of seats) {
    const sessionName = seat.canonicalSessionName || seat.sessionName;
    if (typeof sessionName === "string") sampleSessions.add(sessionName);
  }
  const samples = new Map();
  const freshSamples = [];
  for (const sessionName of sampleSessions) {
    const sample = telemetryPair(home, preimage, manifest, sessionName, issues);
    if (sample) {
      samples.set(sessionName, sample);
      if (sample.contextAt > appliedAt && sample.providerAt > appliedAt) {
        const { contextAt: _contextAt, providerAt: _providerAt, ...publicSample } = sample;
        freshSamples.push(publicSample);
      }
    }
  }
  requireTailConvergence(tails, samples, issues);
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
    preimageManifestSha256: sha256(fs.readFileSync(path.join(preimage, "manifest.json"))),
    managedSystemWorld: systemWorld.artifact,
    freshSamples,
    legacyTails: tails,
    issues,
    next: issues.length === 0 ? "telemetry state relocation is verified" : "resolve the named incomplete state and rerun verify",
  };
  emit(report, issues.length === 0 ? 0 : 1);
}

function verificationReceipt(home, preimage, verificationPath) {
  if (!verificationPath) return { issue: issue("verification_receipt_required", null, "capture a successful --verify JSON receipt and pass it with --verification") };
  const receipt = readJson(verificationPath);
  const manifestPath = path.join(preimage, "manifest.json");
  const manifest = readJson(manifestPath);
  const expectsSystemWorld = Array.isArray(manifest?.managedEmptyDirectories) && manifest.managedEmptyDirectories.length === 1;
  const valid = receipt?.schema === SCHEMA
    && receipt.phase === "verify"
    && receipt.verified === true
    && receipt.complete === true
    && typeof receipt.home === "string"
    && typeof receipt.preimage === "string"
    && path.resolve(receipt.home) === home
    && path.resolve(receipt.preimage) === path.resolve(preimage)
    && receipt.preimageManifestSha256 === sha256(fs.readFileSync(manifestPath))
    && Array.isArray(receipt.legacyTails)
    && receipt.legacyTails.every((tail) => (tail?.kind === "context" || tail?.kind === "provider")
      && typeof tail.originalPath === "string"
      && typeof tail.sessionName === "string"
      && typeof tail.observedAt === "string"
      && typeof tail.sha256 === "string"
      && Number.isInteger(tail.mode))
    && (expectsSystemWorld
      ? receipt.managedSystemWorld && typeof receipt.managedSystemWorld.path === "string"
        && typeof receipt.managedSystemWorld.sha256 === "string"
        && Number.isInteger(receipt.managedSystemWorld.mode)
      : receipt.managedSystemWorld === null);
  return valid
    ? { receipt }
    : { issue: issue("verification_receipt_invalid", verificationPath, "rerun --verify against this exact home and preimage, capture its JSON, then retry") };
}

function validateLegacySources(preimage, manifest, root, kind, issues, allowedDirectories = [], verifiedTails = []) {
  const files = manifest.files.filter((file) => file.kind === kind && path.dirname(file.originalPath) === root);
  const telemetryKind = kind === "context-source" ? "context" : "provider";
  const tails = verifiedTails.filter((tail) => tail.kind === telemetryKind && path.dirname(tail.originalPath) === root);
  const expectedByPath = new Map(files.map((file) => [file.originalPath, file]));
  for (const tail of tails) expectedByPath.set(tail.originalPath, tail);
  const allowed = new Set([...expectedByPath.keys()].map((filePath) => path.basename(filePath)));
  const allowedDirectorySet = new Set(allowedDirectories);
  if (!fs.existsSync(root)) {
    for (const file of expectedByPath.values()) {
      issues.push(issue("legacy_source_drift", file.originalPath, "restore the verified legacy telemetry source before migrating the library"));
    }
    return [...expectedByPath.values()];
  }
  if (!fs.statSync(root).isDirectory()) {
    issues.push(issue("legacy_source_drift", root, "restore the verified legacy telemetry directory before migrating the library"));
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json.tmp")) continue;
    if (entry.isDirectory() && allowedDirectorySet.has(path.join(root, entry.name))) continue;
    if (!entry.isFile() || !allowed.has(entry.name)) {
      issues.push(issue("context_dir_not_empty_after_state_move", path.join(root, entry.name), "classify or archive the non-telemetry entry before applying the library move"));
    }
  }
  for (const file of expectedByPath.values()) {
    const sourceKind = fs.existsSync(file.originalPath) ? fs.lstatSync(file.originalPath) : null;
    if (!sourceKind?.isFile() || sourceKind.isSymbolicLink()
      || sha256(fs.readFileSync(file.originalPath)) !== file.sha256
      || (sourceKind.mode & 0o777) !== file.mode) {
      issues.push(issue("legacy_source_drift", file.originalPath, "rerun apply-state and verify; a legacy telemetry source changed after the receipt"));
    }
  }
  return [...expectedByPath.values()];
}

function legacySourceDrift(sourcePath, error) {
  const drift = new Error(`legacy source changed after verification: ${sourcePath}: ${error.message}`);
  drift.migrationIssueCode = "legacy_source_drift";
  drift.migrationPath = sourcePath;
  return drift;
}

function readVerifiedLegacySource(file, sourcePath = file.originalPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const current = fs.lstatSync(sourcePath);
    if (!opened.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || opened.dev !== current.dev
      || opened.ino !== current.ino
      || sha256(bytes) !== file.sha256
      || (current.mode & 0o777) !== file.mode) {
      throw new Error("path, bytes, or mode no longer match the verification receipt");
    }
    return bytes;
  } catch (error) {
    throw legacySourceDrift(file.originalPath, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function preserveVerifiedLegacyTails(preimage, tails) {
  return tails.map((tail, index) => {
    const bytes = readVerifiedLegacySource(tail);
    const storedAs = path.join("post-apply-legacy-tails", `${String(index).padStart(4, "0")}-${tail.sha256}`);
    const storedPath = path.join(preimage, storedAs);
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    if (fs.existsSync(storedPath)) {
      const stored = fs.lstatSync(storedPath);
      if (!stored.isFile() || stored.isSymbolicLink()
        || sha256(fs.readFileSync(storedPath)) !== tail.sha256
        || (stored.mode & 0o777) !== tail.mode) {
        throw new Error(`preserved legacy tail changed: ${storedPath}`);
      }
    } else {
      fs.writeFileSync(storedPath, bytes, { flag: "wx", mode: tail.mode });
      fs.chmodSync(storedPath, tail.mode);
    }
    const stored = fs.lstatSync(storedPath);
    if (!stored.isFile() || stored.isSymbolicLink()
      || sha256(fs.readFileSync(storedPath)) !== tail.sha256
      || (stored.mode & 0o777) !== tail.mode) {
      throw new Error(`preserved legacy tail does not match its receipt: ${storedPath}`);
    }
    return { ...tail, storedAs };
  });
}

function removeVerifiedLegacySource(file) {
  const quarantineRoot = fs.mkdtempSync(path.join(path.dirname(file.originalPath), ".openrig-legacy-remove-"));
  const quarantinedPath = path.join(quarantineRoot, path.basename(file.originalPath));
  let quarantined = false;
  try {
    try {
      fs.renameSync(file.originalPath, quarantinedPath);
      quarantined = true;
    } catch (error) {
      throw legacySourceDrift(file.originalPath, error);
    }
    try {
      readVerifiedLegacySource(file, quarantinedPath);
    } catch (error) {
      try {
        fs.linkSync(quarantinedPath, file.originalPath);
        fs.rmSync(quarantinedPath);
        quarantined = false;
      } catch (restoreError) {
        error.message = `${error.message}; changed entry remains recoverable at ${quarantinedPath}: ${restoreError.message}`;
      }
      throw error;
    }
    fs.rmSync(quarantinedPath);
    quarantined = false;
  } finally {
    if (!quarantined && fs.existsSync(quarantineRoot) && fs.readdirSync(quarantineRoot).length === 0) {
      fs.rmdirSync(quarantineRoot);
    }
  }
}

function removeVerifiedLegacyRoot(root, files, managedFiles = [], emptyDirectories = []) {
  if (!fs.existsSync(root)) return;
  for (const file of files) readVerifiedLegacySource(file);
  for (const file of files) removeVerifiedLegacySource(file);
  for (const file of managedFiles) fs.rmSync(file, { force: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json.tmp")) fs.rmSync(path.join(root, entry.name), { force: true });
  }
  for (const directory of emptyDirectories) fs.rmdirSync(directory);
  const remaining = fs.readdirSync(root);
  if (remaining.length > 0) {
    throw legacySourceDrift(path.join(root, remaining[0]), new Error(`unexpected entries remain: ${remaining.join(", ")}`));
  }
  try {
    fs.rmdirSync(root);
  } catch (error) {
    if (error.code === "ENOTEMPTY") throw legacySourceDrift(root, error);
    throw error;
  }
}

function applyLibrary(home, preimage, verificationPath) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, issues: [issue("preimage_required", null, "pass the apply-state --preimage path")] }, 1);
  }
  const manifest = loadManifest(preimage, home, "apply-library");
  const issues = validatePreimage(preimage, manifest);
  if (manifest.status !== "applied") {
    issues.push(issue("preimage_manifest_mismatch", path.join(preimage, "manifest.json"), "apply-library requires one completed apply-state preimage"));
  }
  const receipt = verificationReceipt(home, preimage, verificationPath);
  if (receipt.issue) issues.push(receipt.issue);
  const verifiedTails = receipt.receipt?.legacyTails ?? [];
  const systemWorld = managedSystemWorldState(home, manifest, issues, receipt.receipt?.managedSystemWorld);
  const tailSamples = new Map();
  for (const sessionName of new Set(verifiedTails.map((tail) => tail.sessionName))) {
    const sample = telemetryPair(home, preimage, manifest, sessionName, issues);
    if (sample) tailSamples.set(sessionName, sample);
  }
  requireTailConvergence(verifiedTails, tailSamples, issues);
  const library = readLibraryConfig(home, issues);
  const legacyContextFiles = validateLegacySources(
    preimage,
    manifest,
    path.join(home, "context"),
    "context-source",
    issues,
    systemWorld.directories,
    verifiedTails,
  );
  const legacyProviderFiles = validateLegacySources(
    preimage,
    manifest,
    path.join(home, "provider-usage"),
    "provider-source",
    issues,
    [],
    verifiedTails,
  );
  const configRecord = manifest.files.find((file) => file.kind === "config");
  if (library?.configExists) {
    const currentConfigSha = sha256(fs.readFileSync(library.configPath));
    if (!configRecord || currentConfigSha !== configRecord.sha256) {
      issues.push(issue("config_drift", library.configPath, "preserve the changed config and rerun the migration from a fresh preimage"));
    }
  }
  if (issues.length > 0 || !library) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues }, 1);
  }

  let sourceTreeSnapshot;
  try {
    sourceTreeSnapshot = treeSnapshot(library.sourceRoot);
  } catch (error) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "library_source_invalid",
      library.sourceRoot,
      "preserve the unsupported entry and extend the bounded migration before retrying",
      { diagnostic: error.message },
    )] }, 1);
  }
  const systemEntry = sourceTreeSnapshot.entries.find((entry) => entry.path === "system");
  const systemWorldEntry = sourceTreeSnapshot.entries.find((entry) => entry.path === "system/system-world.yaml");
  if (systemEntry?.type === "symlink" || systemWorldEntry?.type === "symlink") {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "system_world_conflict",
      path.join(library.sourceRoot, "system"),
      "preserve the opaque entry at the reserved System World path and reconcile it before migration",
    )] }, 1);
  }
  const systemWorldPathBefore = path.join(library.sourceRoot, "system", "system-world.yaml");
  const systemWorldExisted = systemWorldEntry?.type === "file";
  if (systemWorldExisted && sha256(fs.readFileSync(systemWorldPathBefore)) !== sha256(DEFAULT_SYSTEM_WORLD)) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "system_world_conflict",
      systemWorldPathBefore,
      "preserve the operator-owned manifest and explicitly select or reconcile it before retrying",
    )] }, 1);
  }

  let postApplyLegacyTails;
  try {
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
    postApplyLegacyTails = preserveVerifiedLegacyTails(preimage, verifiedTails);
  } catch (error) {
    const sourceDrift = error.migrationIssueCode === "legacy_source_drift";
    const libraryDrift = error.migrationIssueCode === "library_source_drift";
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      sourceDrift ? "legacy_source_drift" : libraryDrift ? "library_source_drift" : "preimage_mismatch",
      sourceDrift || libraryDrift ? error.migrationPath : preimage,
      libraryDrift
        ? "preserve the changed context library and rerun from a fresh inventory"
        : sourceDrift
        ? "preserve the changed legacy telemetry source and rerun verification before migrating the library"
        : "restore a writeable byte-matching preimage before migrating the library",
      { diagnostic: error.message },
    )] }, 1);
  }

  const prepared = {
    ...manifest,
    status: "library-prepared",
    postApplyLegacyTails,
    library: {
      sourceRoot: library.sourceRoot,
      targetRoot: library.targetRoot,
      sourceTreeDigest: sourceTreeSnapshot.digest,
      sourceTreeRootIdentity: sourceTreeSnapshot.rootIdentity,
      sourceTreeInventory: sourceTreeSnapshot.entries,
      systemWorldExisted,
      configExisted: library.configExists,
      nextConfigSha256: library.configExists ? sha256(library.nextConfig) : null,
    },
  };
  const manifestPath = path.join(preimage, "manifest.json");
  atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`), 0o600);

  try {
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
    removeVerifiedLegacyRoot(
      path.join(home, "context"),
      legacyContextFiles,
      systemWorld.artifact ? [systemWorld.artifact.path] : [],
      systemWorld.directories,
    );
    removeVerifiedLegacyRoot(path.join(home, "provider-usage"), legacyProviderFiles);
    if (library.sourceRoot !== library.targetRoot) {
      if (fs.existsSync(library.targetRoot)) throw new Error(`library target still exists after telemetry removal: ${library.targetRoot}`);
      if (sourceTreeSnapshot.digest !== null) {
        assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
        fs.renameSync(library.sourceRoot, library.targetRoot);
        assertTreeSnapshot(library.targetRoot, sourceTreeSnapshot);
      }
      else fs.mkdirSync(library.targetRoot, { recursive: true });
    } else {
      fs.mkdirSync(library.targetRoot, { recursive: true });
      if (sourceTreeSnapshot.digest !== null) assertTreeSnapshot(library.targetRoot, sourceTreeSnapshot);
    }
    const systemWorldPath = path.join(library.targetRoot, "system", "system-world.yaml");
    const systemWorldAdded = !lstatOrNull(systemWorldPath);
    if (systemWorldAdded) atomicWrite(systemWorldPath, Buffer.from(DEFAULT_SYSTEM_WORLD), 0o644);
    const systemWorldIdentity = systemWorldAdded ? regularFileSnapshot(systemWorldPath) : null;
    if (library.configExists && sha256(library.originalConfig) !== sha256(library.nextConfig)) {
      atomicWrite(library.configPath, library.nextConfig, fs.statSync(library.configPath).mode & 0o777);
    }
    const targetTreeDigest = treeDigest(library.targetRoot);
    if (systemWorldAdded) assertRegularFileSnapshot(systemWorldPath, systemWorldIdentity);
    const appliedAt = new Date().toISOString();
    const completed = {
      ...prepared,
      status: "library-applied",
      library: {
        ...prepared.library,
        systemWorldPath,
        systemWorldAdded,
        systemWorldIdentity,
        targetTreeDigest,
        appliedConfigSha256: library.configExists ? sha256(fs.readFileSync(library.configPath)) : null,
        appliedAt,
      },
    };
    atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(completed, null, 2)}\n`), 0o600);
    emit({
      schema: SCHEMA,
      generatedAt: appliedAt,
      home,
      phase: "apply-library",
      applied: true,
      complete: true,
      preimage,
      sourceRoot: library.sourceRoot,
      contextRoot: library.targetRoot,
      systemWorldPath,
      issues: [],
      next: "start the target daemon, inspect context.system_world provenance, and run the representative fresh-seat proof",
    });
  } catch (error) {
    const sourceDrift = error.migrationIssueCode === "legacy_source_drift";
    const libraryDrift = error.migrationIssueCode === "library_source_drift";
    emit({
      schema: SCHEMA,
      phase: "apply-library",
      ok: false,
      applied: false,
      complete: false,
      preimage,
      issues: [issue(
        sourceDrift ? "legacy_source_drift" : libraryDrift ? "library_source_drift" : "library_apply_incomplete",
        sourceDrift || libraryDrift ? error.migrationPath : null,
        libraryDrift
          ? "preserve the changed context library and run --rollback with this preimage before retrying"
          : sourceDrift
          ? "preserve the changed legacy telemetry source and reconcile it with the receipt before rollback or retry"
          : "run --rollback with this preimage before retrying",
        { diagnostic: error.message },
      )],
    }, 1);
  }
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
  const library = manifest.library;
  const libraryPhase = library && (manifest.status === "library-prepared" || manifest.status === "library-applied");
  const postApplyLegacyTails = Array.isArray(manifest.postApplyLegacyTails) ? manifest.postApplyLegacyTails : [];
  const tailByPath = new Map(postApplyLegacyTails.map((file) => [file.originalPath, file]));
  let libraryLocation = null;
  if (libraryPhase) {
    const sourceExists = fs.existsSync(library.sourceRoot);
    const targetExists = fs.existsSync(library.targetRoot);
    if (library.sourceRoot === library.targetRoot) {
      libraryLocation = targetExists ? "target" : "missing";
    } else if (sourceExists && targetExists) {
      issues.push(issue("destination_drift", library.targetRoot, "preserve both context libraries and decide which tree is authoritative before rollback"));
      libraryLocation = "ambiguous";
    } else if (targetExists) {
      libraryLocation = "target";
    } else if (sourceExists) {
      libraryLocation = "source";
    } else {
      libraryLocation = "missing";
    }
    const activeRoot = libraryLocation === "target" ? library.targetRoot : libraryLocation === "source" ? library.sourceRoot : null;
    if (!activeRoot && library.sourceTreeDigest !== null) {
      issues.push(issue("destination_drift", library.targetRoot, "restore the missing context library before rollback"));
    }
    if (activeRoot) {
      try {
        const managedSystemWorldPath = path.join(activeRoot, "system", "system-world.yaml");
        const managedSystemWorldStat = !library.systemWorldExisted ? lstatOrNull(managedSystemWorldPath) : null;
        const ignored = managedSystemWorldStat
          ? new Set(["system/system-world.yaml"])
          : new Set();
        const currentTreeDigest = treeDigest(activeRoot, ignored);
        if (currentTreeDigest !== (library.sourceTreeDigest ?? sha256(""))) {
          issues.push(issue("destination_drift", activeRoot, "preserve the changed context library and decide the merge manually before rollback"));
        }
        if (Array.isArray(library.sourceTreeInventory)) {
          try {
            assertTreeSnapshot(activeRoot, {
              digest: library.sourceTreeDigest,
              rootIdentity: library.sourceTreeRootIdentity,
              entries: library.sourceTreeInventory,
            }, ignored);
          } catch (error) {
            issues.push(issue("destination_drift", error.migrationPath ?? activeRoot, "preserve the changed context library identity and decide the merge manually before rollback", {
              diagnostic: error.message,
            }));
          }
        }
        if (managedSystemWorldStat || library.systemWorldAdded === true) {
          try {
            assertRegularFileSnapshot(managedSystemWorldPath, library.systemWorldIdentity);
          } catch (error) {
            issues.push(issue("destination_drift", managedSystemWorldPath, "preserve the changed System World identity and decide the merge manually before rollback", {
              diagnostic: error.message,
            }));
          }
        }
      } catch (error) {
        issues.push(issue("destination_drift", activeRoot, "preserve the changed context library and decide the merge manually before rollback", {
          diagnostic: error.message,
        }));
      }
    }
    if (library.configExisted) {
      const configRecord = manifest.files.find((file) => file.kind === "config");
      if (!configRecord || !fs.existsSync(configRecord.originalPath)) {
        issues.push(issue("destination_drift", configRecord?.originalPath, "restore the migration-owned config path before rollback"));
      } else {
        const digest = sha256(fs.readFileSync(configRecord.originalPath));
        const acceptedConfigDigests = new Set([configRecord.sha256, library.nextConfigSha256, library.appliedConfigSha256].filter(Boolean));
        if (!acceptedConfigDigests.has(digest)) {
          issues.push(issue("destination_drift", configRecord.originalPath, "preserve the changed config and decide the merge manually before rollback"));
        }
      }
    }
    for (const file of manifest.files.filter((entry) => entry.kind === "context-source" || entry.kind === "provider-source")) {
      const currentDigest = fs.existsSync(file.originalPath) ? sha256(fs.readFileSync(file.originalPath)) : null;
      const acceptedDigests = new Set([file.sha256, tailByPath.get(file.originalPath)?.sha256].filter(Boolean));
      if (currentDigest !== null && !acceptedDigests.has(currentDigest)) {
        issues.push(issue("destination_drift", file.originalPath, "preserve the changed legacy telemetry source and decide the merge manually before rollback"));
      }
    }
    for (const tail of postApplyLegacyTails.filter((entry) => !manifest.files.some((file) => file.originalPath === entry.originalPath))) {
      if (fs.existsSync(tail.originalPath) && sha256(fs.readFileSync(tail.originalPath)) !== tail.sha256) {
        issues.push(issue("destination_drift", tail.originalPath, "preserve the changed post-apply legacy telemetry source and decide the merge manually before rollback"));
      }
    }
  }
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
  if (issues.length > 0) {
    emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, restored: [], alreadyOriginal, issues }, 1);
  }
  if (libraryPhase) {
    const activeRoot = libraryLocation === "target" ? library.targetRoot : libraryLocation === "source" ? library.sourceRoot : null;
    const managedSystemWorldPath = activeRoot ? path.join(activeRoot, "system", "system-world.yaml") : null;
    if (!library.systemWorldExisted && managedSystemWorldPath && lstatOrNull(managedSystemWorldPath)) {
      try {
        assertRegularFileSnapshot(managedSystemWorldPath, library.systemWorldIdentity);
      } catch (error) {
        emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, issues: [issue(
          "destination_drift",
          managedSystemWorldPath,
          "the managed System World identity changed before rollback removal",
          { diagnostic: error.message },
        )] }, 1);
      }
      fs.rmSync(managedSystemWorldPath);
      const systemDir = path.dirname(managedSystemWorldPath);
      if (fs.readdirSync(systemDir).length === 0) fs.rmdirSync(systemDir);
    }
    const restoredTreeDigest = activeRoot ? treeDigest(activeRoot) : null;
    const expectedRestoredTreeDigest = library.sourceTreeDigest ?? sha256("");
    if (activeRoot && restoredTreeDigest !== expectedRestoredTreeDigest) {
      emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, issues: [issue(
        "destination_drift",
        activeRoot,
        "the context library no longer matches its preserved pre-migration tree",
      )] }, 1);
    }
    if (activeRoot && Array.isArray(library.sourceTreeInventory)) {
      try {
        assertTreeSnapshot(activeRoot, {
          digest: library.sourceTreeDigest,
          rootIdentity: library.sourceTreeRootIdentity,
          entries: library.sourceTreeInventory,
        });
      } catch (error) {
        emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, issues: [issue(
          "destination_drift",
          error.migrationPath ?? activeRoot,
          "the context library identity no longer matches its preserved pre-migration tree",
          { diagnostic: error.message },
        )] }, 1);
      }
    }
    if (library.sourceRoot !== library.targetRoot && libraryLocation === "target") {
      if (library.sourceTreeDigest === null) {
        if (fs.readdirSync(library.targetRoot).length === 0) fs.rmdirSync(library.targetRoot);
      } else {
        fs.renameSync(library.targetRoot, library.sourceRoot);
      }
    }
    const configRecord = manifest.files.find((file) => file.kind === "config");
    if (configRecord) {
      const currentDigest = sha256(fs.readFileSync(configRecord.originalPath));
      if (currentDigest !== configRecord.sha256) {
        atomicWrite(configRecord.originalPath, fs.readFileSync(path.join(preimage, configRecord.storedAs)), configRecord.mode);
      }
    }
    for (const file of manifest.files.filter((entry) => entry.kind === "context-source" || entry.kind === "provider-source")) {
      if (!fs.existsSync(file.originalPath) || sha256(fs.readFileSync(file.originalPath)) !== file.sha256) {
        atomicWrite(file.originalPath, fs.readFileSync(path.join(preimage, file.storedAs)), file.mode);
      }
    }
    for (const tail of postApplyLegacyTails.filter((entry) => !manifest.files.some((file) => file.originalPath === entry.originalPath))) {
      if (fs.existsSync(tail.originalPath)) fs.rmSync(tail.originalPath);
    }
    for (const directory of manifest.managedEmptyDirectories ?? []) fs.mkdirSync(directory, { recursive: true });
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
    preservedLegacyTails: postApplyLegacyTails.map((file) => path.join(preimage, file.storedAs)),
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
const applyLibraryFlag = process.argv.includes("--apply-library");
const rollbackArg = argument("--rollback");
if ([apply, verifyFlag, applyLibraryFlag, Boolean(rollbackArg)].filter(Boolean).length > 1) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("phase_conflict", null, "choose exactly one of --apply-state, --verify, --apply-library, or --rollback")] }, 1);
}

if (apply) applyState(home, argument("--preimage"));
if (verifyFlag) verify(home, argument("--preimage"));
if (applyLibraryFlag) applyLibrary(home, argument("--preimage"), argument("--verification"));
if (rollbackArg) rollback(home, path.resolve(rollbackArg));
emit(publicPlan(home, buildPlan(home)));
