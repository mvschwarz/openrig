#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA = "openrig-telemetry-state-migration/v1";
const rig = process.env.OPENRIG_RIG_BIN || "rig";
const HELP = `Usage: migrate-telemetry-state-0.5.9.mjs [options]

No phase flag runs the read-only plan.
This tool performs one bounded operation selected by the user agent. It does not
install, start, stop, or otherwise orchestrate an OpenRig upgrade.

Options:
  --home <path>               OpenRig home to inspect or migrate
  --apply-state               Prepare canonical roots, recovery, and compatibility config
  --verify                    Verify real paired canonical telemetry after activation
  --apply-library             Finalize by non-destructive verified library copy
  --rollback <preimage>       Reverse only helper-owned preparation/finalizer effects
  --preimage <path>           Protected recovery material created by apply-state
  --verification <path>       Successful verification receipt required by the finalizer
  -h, --help                  Show this help without inspecting the instance
`;
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

function parseArguments(argv) {
  const valueOptions = new Set(["--home", "--preimage", "--verification", "--rollback"]);
  const phaseOptions = new Set(["--apply-state", "--verify", "--apply-library"]);
  const values = new Map();
  const phases = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (phaseOptions.has(option)) {
      phases.add(option);
      continue;
    }
    if (valueOptions.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { issue: issue("value_required", null, `${option} requires a value`, { option }) };
      }
      values.set(option, value);
      index += 1;
      continue;
    }
    return { issue: issue("unknown_option", null, "run --help for supported options", { option }) };
  }
  return { values, phases };
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
  const configuredLegacyRoot = context.packsRoot
    ? path.resolve(context.packsRoot)
    : context.root
    ? path.resolve(context.root)
    : defaultLegacyRoot;
  if (context.packsRoot !== undefined && context.root !== undefined
    && path.resolve(context.packsRoot) !== path.resolve(context.root)) {
    issues.push(issue("context_root_conflict", configPath, "choose the one context library that must stay authoritative during activation", {
      legacyRoot: path.resolve(context.packsRoot),
      configuredRoot: path.resolve(context.root),
    }));
    return null;
  }
  const targetRoot = configuredLegacyRoot === defaultLegacyRoot ? path.join(home, "context") : configuredLegacyRoot;
  const activationContext = { ...context, root: configuredLegacyRoot };
  delete activationContext.packsRoot;
  const finalContext = { ...context, root: targetRoot };
  delete finalContext.packsRoot;
  if (context.systemWorld === undefined) {
    activationContext.systemWorld = path.join(home, "context", "system", "system-world.yaml");
    if (targetRoot !== path.join(home, "context")) finalContext.systemWorld = activationContext.systemWorld;
  }
  const activationConfig = { ...config, context: activationContext };
  const finalConfig = { ...config, context: finalContext };
  return {
    configPath,
    configExists,
    originalConfig: configExists ? fs.readFileSync(configPath) : null,
    activationConfig: Buffer.from(`${JSON.stringify(activationConfig, null, 2)}\n`),
    finalConfig: Buffer.from(`${JSON.stringify(finalConfig, null, 2)}\n`),
    sourceRoot: configuredLegacyRoot,
    targetRoot,
  };
}

function systemWorldPlan(home, issues) {
  const directory = path.join(home, "context", "system");
  const filePath = path.join(directory, "system-world.yaml");
  const file = lstatOrNull(filePath);
  if (file && (!file.isFile() || file.isSymbolicLink())) {
    issues.push(issue("system_world_conflict", filePath, "preserve the opaque entry and select the intended System World before preparation"));
    return null;
  }
  if (file && sha256(fs.readFileSync(filePath)) !== sha256(DEFAULT_SYSTEM_WORLD)) {
    issues.push(issue("system_world_conflict", filePath, "preserve the operator-owned System World and explicitly reconcile it before preparation"));
    return null;
  }
  const directoryStat = lstatOrNull(directory);
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) {
    issues.push(issue("system_world_conflict", directory, "preserve the opaque entry and select the intended System World directory before preparation"));
    return null;
  }
  if (directoryStat) {
    const foreign = fs.readdirSync(directory).filter((name) => name !== "system-world.yaml");
    if (foreign.length > 0) {
      issues.push(issue("system_world_conflict", path.join(directory, foreign[0]), "preserve the additional content and reconcile the reserved System World directory before preparation"));
      return null;
    }
  }
  return { directory, filePath, existed: Boolean(file) };
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
      issues.push(issue("foreign_file", source, "classify or archive the non-telemetry entry before applying this bounded migration"));
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
  const systemWorld = systemWorldPlan(home, issues);
  const allowedContextDirectories = systemWorld && lstatOrNull(systemWorld.directory)
    ? [systemWorld.directory]
    : [];
  const telemetry = [
    ...scanLegacy(roots.legacyContext, "context", roots.contextUsage, issues, managedEmptyDirectories, allowedContextDirectories),
    ...scanLegacy(roots.legacyProvider, "provider", roots.providerUsage, issues),
  ];
  inventoryClaudeSeats(issues);
  const library = readLibraryConfig(home, issues);
  if (library && fs.existsSync(library.sourceRoot) && !fs.statSync(library.sourceRoot).isDirectory()) {
    issues.push(issue("library_source_invalid", library.sourceRoot, "preserve the path and identify the real legacy context library"));
  }
  return { roots, telemetry, library, systemWorld, managedEmptyDirectories, issues };
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
      { decision: "prepare-directory", path: plan.roots.contextUsage },
      { decision: "prepare-directory", path: plan.roots.providerUsage },
      ...plan.telemetry.map((item) => ({ decision: "preserve-legacy-fallback", kind: item.kind, path: item.source, sha256: sha256(item.bytes) })),
      ...(plan.systemWorld ? [{ decision: plan.systemWorld.existed ? "preserve-system-world" : "install-system-world", path: plan.systemWorld.filePath }] : []),
      ...(plan.library ? [{
        decision: "pin-library-during-activation",
        from: plan.library.sourceRoot,
        to: plan.library.sourceRoot,
        finalizer: plan.library.sourceRoot === plan.library.targetRoot ? "verify-in-place" : "copy-after-verification",
        finalizerTarget: plan.library.targetRoot,
      }] : []),
    ],
    issues: plan.issues,
    next: plan.issues.length === 0
      ? "after the user agent approves this installation-specific plan, choose an unused --preimage path and run --apply-state"
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
    stateDirectories: [plan.roots.contextUsage, plan.roots.providerUsage].map((directory) => ({
      path: directory,
      existed: Boolean(lstatOrNull(directory)),
    })),
    managedEmptyDirectories: plan.managedEmptyDirectories,
    systemWorld: plan.systemWorld ? {
      path: plan.systemWorld.filePath,
      existed: plan.systemWorld.existed,
      sha256: sha256(DEFAULT_SYSTEM_WORLD),
      mode: 0o644,
    } : null,
    libraryPlan: plan.library ? {
      configPath: plan.library.configPath,
      configExisted: plan.library.configExists,
      sourceRoot: plan.library.sourceRoot,
      targetRoot: plan.library.targetRoot,
      activationConfigBase64: plan.library.activationConfig.toString("base64"),
      activationConfigSha256: sha256(plan.library.activationConfig),
      finalConfigBase64: plan.library.finalConfig.toString("base64"),
      finalConfigSha256: sha256(plan.library.finalConfig),
    } : null,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`, { flag: "wx" });

  try {
    fs.mkdirSync(plan.roots.contextUsage, { recursive: true });
    fs.mkdirSync(plan.roots.providerUsage, { recursive: true });
    if (plan.systemWorld && !plan.systemWorld.existed) {
      atomicWrite(plan.systemWorld.filePath, Buffer.from(DEFAULT_SYSTEM_WORLD), 0o644);
    }
    if (plan.library) {
      const configMode = plan.library.configExists ? fs.statSync(plan.library.configPath).mode & 0o777 : 0o600;
      if (plan.library.configExists && sha256(fs.readFileSync(plan.library.configPath)) !== sha256(plan.library.originalConfig)) {
        throw new Error(`config changed during preparation: ${plan.library.configPath}`);
      }
      atomicWrite(plan.library.configPath, plan.library.activationConfig, configMode);
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
    preparedDirectories: [plan.roots.contextUsage, plan.roots.providerUsage],
    preservedLegacy: plan.telemetry.map((item) => item.source),
    configuredContextRoot: plan.library?.sourceRoot ?? null,
    issues: [],
    next: "the user agent may now activate the exact target runtime; prove canonical-only writes and canonical-first/legacy-fallback reads, then run --verify with this --preimage",
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
  if (manifest.systemWorld) {
    const expected = manifest.systemWorld;
    const filePath = expected.path;
    const current = lstatOrNull(filePath);
    if (!current?.isFile() || current.isSymbolicLink()
      || sha256(fs.readFileSync(filePath)) !== expected.sha256
      || (current.mode & 0o777) !== expected.mode) {
      issues.push(issue("system_world_conflict", filePath, "preserve the changed System World and restore the exact prepared artifact before continuing"));
      return { directories: [path.dirname(filePath)], artifact: null };
    }
    const foreign = fs.readdirSync(path.dirname(filePath)).filter((name) => name !== path.basename(filePath));
    if (foreign.length > 0) {
      issues.push(issue("system_world_conflict", path.join(path.dirname(filePath), foreign[0]), "preserve the additional content and reconcile the reserved System World directory before continuing"));
    }
    const artifact = { path: filePath, sha256: expected.sha256, mode: expected.mode };
    if (expectedArtifact !== undefined && (
      expectedArtifact === null
      || expectedArtifact.path !== artifact.path
      || expectedArtifact.sha256 !== artifact.sha256
      || expectedArtifact.mode !== artifact.mode
    )) {
      issues.push(issue("destination_drift", filePath, "preserve the changed System World and rerun verification from the exact migration state"));
    }
    return { directories: [path.dirname(filePath)], artifact };
  }
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
    next: issues.length === 0 ? "canonical telemetry adoption is verified" : "resolve the named incomplete state and rerun verify",
  };
  emit(report, issues.length === 0 ? 0 : 1);
}

function verificationReceipt(home, preimage, verificationPath) {
  if (!verificationPath) return { issue: issue("verification_receipt_required", null, "capture a successful --verify JSON receipt and pass it with --verification") };
  const receipt = readJson(verificationPath);
  const manifestPath = path.join(preimage, "manifest.json");
  const manifest = readJson(manifestPath);
  const expectsSystemWorld = Boolean(manifest?.systemWorld)
    || (Array.isArray(manifest?.managedEmptyDirectories) && manifest.managedEmptyDirectories.length === 1);
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

function validateLegacySources(preimage, manifest, root, kind, issues, allowedEntries = [], verifiedTails = []) {
  const files = manifest.files.filter((file) => file.kind === kind && path.dirname(file.originalPath) === root);
  const telemetryKind = kind === "context-source" ? "context" : "provider";
  const tails = verifiedTails.filter((tail) => tail.kind === telemetryKind && path.dirname(tail.originalPath) === root);
  const expectedByPath = new Map(files.map((file) => [file.originalPath, file]));
  for (const tail of tails) expectedByPath.set(tail.originalPath, tail);
  const allowed = new Set([...expectedByPath.keys()].map((filePath) => path.basename(filePath)));
  const allowedEntrySet = new Set(allowedEntries);
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
    if (allowedEntrySet.has(path.join(root, entry.name))) continue;
    if (!entry.isFile() || !allowed.has(entry.name)) {
      issues.push(issue("legacy_source_drift", path.join(root, entry.name), "classify the new legacy-root entry and obtain a fresh verification receipt before finalization"));
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

function assertLegacySourcesStillVerified(home, preimage, manifest, allowedContextEntries, verifiedTails) {
  const issues = [];
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "context"),
    "context-source",
    issues,
    allowedContextEntries,
    verifiedTails,
  );
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "provider-usage"),
    "provider-source",
    issues,
    [],
    verifiedTails,
  );
  if (issues.length > 0) {
    const first = issues[0];
    throw legacySourceDrift(first.path ?? home, new Error(first.code));
  }
}

function decodePlannedBytes(encoded, digest) {
  const bytes = Buffer.from(encoded ?? "", "base64");
  if (!encoded || sha256(bytes) !== digest) throw new Error("manifest-planned bytes do not match their digest");
  return bytes;
}

function entrySnapshot(entryPath) {
  const stat = fs.lstatSync(entryPath);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return {
      type: "symlink",
      mode,
      linkTargetBase64: fs.readlinkSync(entryPath, { encoding: "buffer" }).toString("base64"),
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  }
  if (stat.isFile()) {
    return {
      type: "file",
      mode,
      sha256: sha256(fs.readFileSync(entryPath)),
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  }
  if (stat.isDirectory()) {
    return { type: "directory", mode, tree: treeSnapshot(entryPath) };
  }
  throw new Error(`unsupported library entry is not supported: ${entryPath}`);
}

function copyEntryOpaque(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode & 0o777);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(source).sort((left, right) => left.localeCompare(right))) {
      copyEntryOpaque(path.join(source, name), path.join(destination, name));
    }
    fs.chmodSync(destination, stat.mode & 0o777);
    return;
  }
  throw new Error(`unsupported library entry is not supported: ${source}`);
}

function semanticEntrySnapshot(snapshot) {
  if (snapshot.type !== "directory") {
    const { identity: _identity, ...semantic } = snapshot;
    return semantic;
  }
  return {
    type: snapshot.type,
    mode: snapshot.mode,
    digest: snapshot.tree.digest,
    entries: snapshot.tree.entries.map((entry) => {
      const { identity: _identity, ...semantic } = entry;
      return semantic;
    }),
  };
}

function assertEntrySnapshot(entryPath, expected, requireIdentity = true) {
  const current = entrySnapshot(entryPath);
  if (JSON.stringify(semanticEntrySnapshot(current)) !== JSON.stringify(semanticEntrySnapshot(expected))) {
    throw new Error(`entry bytes, type, link payload, or mode changed: ${entryPath}`);
  }
  if (!requireIdentity) return current;
  if (expected.type === "directory") {
    if (current.tree.rootIdentity?.dev !== expected.tree.rootIdentity?.dev
      || current.tree.rootIdentity?.ino !== expected.tree.rootIdentity?.ino) {
      throw new Error(`entry identity changed: ${entryPath}`);
    }
    const currentLinks = new Map(current.tree.entries.filter((entry) => entry.type === "symlink").map((entry) => [entry.path, entry.identity]));
    for (const link of expected.tree.entries.filter((entry) => entry.type === "symlink")) {
      const identity = currentLinks.get(link.path);
      if (identity?.dev !== link.identity?.dev || identity?.ino !== link.identity?.ino) {
        throw new Error(`symlink identity changed: ${path.join(entryPath, link.path)}`);
      }
    }
  } else if (current.identity.dev !== expected.identity.dev || current.identity.ino !== expected.identity.ino) {
    throw new Error(`entry identity changed: ${entryPath}`);
  }
  return current;
}

function libraryPlanFromManifest(manifest, home, issues) {
  const plan = manifest.libraryPlan;
  try {
    if (!plan
      || typeof plan.configPath !== "string"
      || typeof plan.sourceRoot !== "string"
      || typeof plan.targetRoot !== "string"
      || typeof plan.configExisted !== "boolean") throw new Error("library plan is absent or malformed");
    const activationConfig = decodePlannedBytes(plan.activationConfigBase64, plan.activationConfigSha256);
    const finalConfig = decodePlannedBytes(plan.finalConfigBase64, plan.finalConfigSha256);
    if (path.resolve(plan.configPath) !== path.join(home, "config.json")) throw new Error("config path does not match this home");
    return { ...plan, activationConfig, finalConfig };
  } catch (error) {
    issues.push(issue("preimage_manifest_mismatch", path.join(home, "config.json"), "use the exact preparation receipt for this home", {
      diagnostic: error.message,
    }));
    return null;
  }
}

function applyLibrary(home, preimage, verificationPath) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, issues: [issue("preimage_required", null, "pass the apply-state --preimage path")] }, 1);
  }
  const manifest = loadManifest(preimage, home, "apply-library");
  const issues = validatePreimage(preimage, manifest);
  if (manifest.status !== "applied") {
    issues.push(issue("preimage_manifest_mismatch", path.join(preimage, "manifest.json"), "the finalizer requires one completed preparation receipt"));
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
  const library = libraryPlanFromManifest(manifest, home, issues);
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "context"),
    "context-source",
    issues,
    systemWorld.directories,
    verifiedTails,
  );
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "provider-usage"),
    "provider-source",
    issues,
    [],
    verifiedTails,
  );
  if (library) {
    const currentConfigSha = fs.existsSync(library.configPath) ? sha256(fs.readFileSync(library.configPath)) : null;
    if (currentConfigSha !== library.activationConfigSha256) {
      issues.push(issue("config_drift", library.configPath, "preserve the changed config and prepare a fresh migration receipt before finalization"));
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
  const sourceSystemWorld = path.join(library.sourceRoot, "system", "system-world.yaml");
  const sourceSystemEntries = systemEntry?.type === "directory"
    ? sourceTreeSnapshot.entries.filter((entry) => entry.path === "system" || entry.path.startsWith("system/"))
    : [];
  const sourceSystemWorldIsDefault = systemWorldEntry?.type === "file"
    && sha256(fs.readFileSync(sourceSystemWorld)) === sha256(DEFAULT_SYSTEM_WORLD)
    && sourceSystemEntries.length === 2;
  if (systemEntry && !sourceSystemWorldIsDefault) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "system_world_conflict",
      path.join(library.sourceRoot, "system"),
      "preserve the legacy library's reserved system entry and explicitly reconcile it before finalization",
    )] }, 1);
  }

  try {
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
  } catch (error) {
    const libraryDrift = error.migrationIssueCode === "library_source_drift";
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      libraryDrift ? "library_source_drift" : "preimage_mismatch",
      libraryDrift ? error.migrationPath : preimage,
      libraryDrift
        ? "preserve the changed context library and rerun from a fresh inventory"
        : "restore a writeable byte-matching preimage before finalization",
      { diagnostic: error.message },
    )] }, 1);
  }

  const targetStat = lstatOrNull(library.targetRoot);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "library_target_conflict",
      library.targetRoot,
      "preserve the opaque target and select the intended canonical context root before finalization",
    )] }, 1);
  }
  const sourceTopLevel = sourceTreeSnapshot.digest === null
    ? []
    : fs.readdirSync(library.sourceRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name !== "system")
      .sort((left, right) => left.localeCompare(right));
  if (library.sourceRoot !== library.targetRoot) {
    for (const name of sourceTopLevel) {
      const destination = path.join(library.targetRoot, name);
      if (lstatOrNull(destination)) {
        emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
          "library_target_conflict",
          destination,
          "preserve both entries and reconcile the collision before finalization; no existing target is overwritten",
        )] }, 1);
      }
    }
  }

  const prepared = {
    ...manifest,
    status: "finalizer-prepared",
    library: {
      sourceRoot: library.sourceRoot,
      targetRoot: library.targetRoot,
      sourceTreeDigest: sourceTreeSnapshot.digest,
      sourceTreeRootIdentity: sourceTreeSnapshot.rootIdentity,
      sourceTreeInventory: sourceTreeSnapshot.entries,
      skippedMatchingSourceSystemWorld: sourceSystemWorldIsDefault,
      configExisted: library.configExisted,
      activationConfigSha256: library.activationConfigSha256,
      finalConfigSha256: library.finalConfigSha256,
      copiedRoots: [],
    },
  };
  const manifestPath = path.join(preimage, "manifest.json");
  atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`), 0o600);

  try {
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
    fs.mkdirSync(library.targetRoot, { recursive: true });
    const copiedRoots = [];
    if (library.sourceRoot !== library.targetRoot) {
      for (const name of sourceTopLevel) {
        const source = path.join(library.sourceRoot, name);
        const destination = path.join(library.targetRoot, name);
        assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
        const sourceEntry = entrySnapshot(source);
        copyEntryOpaque(source, destination);
        const destinationEntry = assertEntrySnapshot(destination, sourceEntry, false);
        copiedRoots.push({ name, snapshot: destinationEntry });
        atomicWrite(manifestPath, Buffer.from(`${JSON.stringify({
          ...prepared,
          status: "finalizer-copying",
          library: { ...prepared.library, copiedRoots },
        }, null, 2)}\n`), 0o600);
      }
    }
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
    assertLegacySourcesStillVerified(
      home,
      preimage,
      manifest,
      [...systemWorld.directories, ...copiedRoots.map((entry) => path.join(library.targetRoot, entry.name))],
      verifiedTails,
    );
    if (sha256(fs.readFileSync(library.configPath)) !== library.activationConfigSha256) {
      throw new Error(`config changed during finalization: ${library.configPath}`);
    }
    if (library.activationConfigSha256 !== library.finalConfigSha256) {
      atomicWrite(library.configPath, library.finalConfig, fs.statSync(library.configPath).mode & 0o777);
    }
    const appliedAt = new Date().toISOString();
    const completed = {
      ...prepared,
      status: "finalizer-applied",
      library: {
        ...prepared.library,
        copiedRoots,
        targetTreeDigest: treeDigest(library.targetRoot),
        appliedConfigSha256: sha256(fs.readFileSync(library.configPath)),
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
      operation: "non-destructive-finalizer",
      sourceRoot: library.sourceRoot,
      contextRoot: library.targetRoot,
      systemWorldPath: systemWorld.artifact?.path ?? null,
      copied: copiedRoots.map((entry) => path.join(library.targetRoot, entry.name)),
      preservedRecovery: [library.sourceRoot, path.join(home, "context"), path.join(home, "provider-usage")],
      issues: [],
      next: "inspect the copied library, effective context root, System World provenance, and representative fresh-seat behavior; keep the legacy sources until separately retired",
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
          ? "preserve the changed legacy telemetry source and obtain a fresh verification receipt"
          : "run --rollback with this preimage before retrying; copied roots remain recorded and the source was not removed",
        { diagnostic: error.message },
      )],
    }, 1);
  }
}

function rollback(home, preimage) {
  const manifest = loadManifest(preimage, home, "rollback");
  const issues = validatePreimage(preimage, manifest);
  const libraryPlan = libraryPlanFromManifest(manifest, home, issues);
  const configRecord = manifest.files.find((file) => file.kind === "config");
  const copiedRoots = Array.isArray(manifest.library?.copiedRoots) ? manifest.library.copiedRoots : [];
  const restored = [];
  const alreadyOriginal = [];

  if (libraryPlan) {
    const configExists = fs.existsSync(libraryPlan.configPath);
    const currentConfigSha = configExists ? sha256(fs.readFileSync(libraryPlan.configPath)) : null;
    const originalSha = configRecord?.sha256 ?? null;
    const accepted = new Set([originalSha, libraryPlan.activationConfigSha256, libraryPlan.finalConfigSha256].filter(Boolean));
    if (currentConfigSha === originalSha || (!libraryPlan.configExisted && currentConfigSha === null)) {
      alreadyOriginal.push(libraryPlan.configPath);
    } else if (currentConfigSha === null || !accepted.has(currentConfigSha)) {
      issues.push(issue("destination_drift", libraryPlan.configPath, "preserve the changed config and decide its recovery before rollback"));
    }
  }

  for (const copied of copiedRoots) {
    const destination = libraryPlan ? path.join(libraryPlan.targetRoot, copied.name) : null;
    if (!destination || copied.name.includes(path.sep) || copied.name === "." || copied.name === "..") {
      issues.push(issue("preimage_manifest_mismatch", destination, "use the exact preparation receipt for this home"));
      continue;
    }
    if (!lstatOrNull(destination)) {
      alreadyOriginal.push(destination);
      continue;
    }
    try {
      assertEntrySnapshot(destination, copied.snapshot, true);
    } catch (error) {
      issues.push(issue("destination_drift", destination, "preserve the changed copied library entry and reconcile it before rollback", {
        diagnostic: error.message,
      }));
    }
  }

  const systemWorld = manifest.systemWorld;
  if (systemWorld && !systemWorld.existed && lstatOrNull(systemWorld.path)) {
    const current = lstatOrNull(systemWorld.path);
    if (!current?.isFile() || current.isSymbolicLink()
      || sha256(fs.readFileSync(systemWorld.path)) !== systemWorld.sha256
      || (current.mode & 0o777) !== systemWorld.mode) {
      issues.push(issue("destination_drift", systemWorld.path, "preserve the changed System World and reconcile it before rollback"));
    }
  }

  if (issues.length > 0) {
    emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, restored: [], alreadyOriginal, issues }, 1);
  }

  for (const copied of [...copiedRoots].reverse()) {
    const destination = path.join(libraryPlan.targetRoot, copied.name);
    if (lstatOrNull(destination)) {
      fs.rmSync(destination, { recursive: true, force: false });
      restored.push(destination);
    }
  }
  if (libraryPlan) {
    if (libraryPlan.configExisted && configRecord) {
      const original = fs.readFileSync(path.join(preimage, configRecord.storedAs));
      if (!fs.existsSync(libraryPlan.configPath) || sha256(fs.readFileSync(libraryPlan.configPath)) !== configRecord.sha256) {
        atomicWrite(libraryPlan.configPath, original, configRecord.mode);
        restored.push(libraryPlan.configPath);
      }
    } else if (fs.existsSync(libraryPlan.configPath)) {
      fs.rmSync(libraryPlan.configPath);
      restored.push(libraryPlan.configPath);
    }
  }
  if (systemWorld && !systemWorld.existed && lstatOrNull(systemWorld.path)) {
    fs.rmSync(systemWorld.path);
    restored.push(systemWorld.path);
    const directory = path.dirname(systemWorld.path);
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
  for (const directory of [...(manifest.stateDirectories ?? [])].reverse()) {
    if (!directory.existed && lstatOrNull(directory.path)?.isDirectory() && fs.readdirSync(directory.path).length === 0) {
      fs.rmdirSync(directory.path);
      restored.push(directory.path);
    }
  }
  emit({
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "rollback",
    rolledBack: true,
    complete: true,
    preimage,
    restored,
    alreadyOriginal,
    preservedLegacy: [path.join(home, "context"), path.join(home, "provider-usage"), libraryPlan?.sourceRoot].filter(Boolean),
    issues: [],
    next: "helper-owned preparation and finalizer effects are reversed; legacy sources and unrelated canonical state remain untouched",
  });
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
const parsed = parseArguments(argv);
if (parsed.issue) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [parsed.issue] }, 1);
}
const homeArg = parsed.values.get("--home") || process.env.OPENRIG_HOME;
if (!homeArg) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("home_required", null, "pass --home or set OPENRIG_HOME")] }, 1);
}
const home = path.resolve(homeArg);
const apply = parsed.phases.has("--apply-state");
const verifyFlag = parsed.phases.has("--verify");
const applyLibraryFlag = parsed.phases.has("--apply-library");
const rollbackArg = parsed.values.get("--rollback");
if ([apply, verifyFlag, applyLibraryFlag, Boolean(rollbackArg)].filter(Boolean).length > 1) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("phase_conflict", null, "choose exactly one of --apply-state, --verify, --apply-library, or --rollback")] }, 1);
}

if (apply) applyState(home, parsed.values.get("--preimage"));
if (verifyFlag) verify(home, parsed.values.get("--preimage"));
if (applyLibraryFlag) applyLibrary(home, parsed.values.get("--preimage"), parsed.values.get("--verification"));
if (rollbackArg) rollback(home, path.resolve(rollbackArg));
emit(publicPlan(home, buildPlan(home)));
