#!/usr/bin/env node
"use strict";
// Native companion to verify-world.sh. The shipped shell file remains the
// shared authored check specification; it is read as data, never executed here.
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url)), example = path.resolve(root, "../world-example");
const read = file => { try { return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"); } catch { return ""; } };
const real = file => { try { return fs.realpathSync.native(file); } catch { return null; } };

function resolveRig() {
  const native = process.platform === "win32";
  const envValue = key => native ? process.env[Object.keys(process.env).sort().find(name => name.toUpperCase() === key)] : process.env[key];
  for (const dir of (envValue("PATH") ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of native ? (envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]) {
      const file = path.resolve(dir.replace(/^"(.*)"$/, "$1"), "rig" + ext.toLowerCase());
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      if (!native) { try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; } }
      if (!native || /\.(?:exe|com)$/i.test(file)) return { command: file, prefix: [] };
      if (!/\.cmd$/i.test(file)) throw Error("Unrecognized Windows rig launcher");
      const text = read(file);
      const modern = /^@echo off\nsetlocal DisableDelayedExpansion\n"([^"\n]+)" "([^"\n]+)" %\*\n$/.exec(text);
      const legacy = /^@echo off\n"([^"%\n]+)" "([^"%\n]+)" %\*\n$/.exec(text);
      const paired = modern || legacy;
      if (paired) {
        const decode = value => {
          if (modern && value.replaceAll("%%", "").includes("%")) throw Error("Unrecognized paired rig path escape");
          return modern ? value.replaceAll("%%", "%") : value;
        };
        // The seat-bin producer hashes fs.realpathSync's spelling. Keep that
        // exact contract; native realpath may expand DOS short-name aliases.
        const interpreter = real(decode(paired[1])), cli = fs.realpathSync(decode(paired[2]));
        if (!cli || interpreter !== real(process.execPath)) throw Error("Unrecognized paired rig entry");
        const digest = createHash("sha256").update(cli).update(modern ? "\0windows-seat-bin-v2" : "").digest("hex");
        if (path.basename(path.dirname(file)) !== digest || path.basename(path.dirname(path.dirname(file))) !== "seat-bin"
          || path.basename(path.dirname(path.dirname(path.dirname(file)))) !== "run") throw Error("Unrecognized paired rig digest");
        const pkg = path.resolve(path.dirname(cli), "..");
        const manifest = JSON.parse(read(path.join(pkg, "package.json")));
        const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rig;
        if (manifest.name !== "@openrig/cli" || typeof declared !== "string" || path.isAbsolute(declared)
          || !inside(pkg, path.resolve(pkg, declared)) || real(path.resolve(pkg, declared)) !== real(cli)) throw Error("Unrecognized paired rig package");
        return { command: process.execPath, prefix: [cli] };
      }
      const bin = path.dirname(file), local = path.basename(bin).toLowerCase() === ".bin";
      const pkg = path.join(local ? path.dirname(bin) : path.join(bin, "node_modules"), "@openrig", "cli");
      const manifest = JSON.parse(read(path.join(pkg, "package.json")));
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rig;
      if (manifest.name !== "@openrig/cli" || typeof entry !== "string" || path.isAbsolute(entry)) throw Error("Unrecognized rig npm package");
      const cli = path.resolve(pkg, entry);
      const needle = "%dp0%\\" + (local ? ".." : "node_modules") + "\\@openrig\\cli\\" + entry.replaceAll("/", "\\");
      if (!inside(pkg, cli) || !text.includes(needle) || !real(cli)) throw Error("Unrecognized rig npm shim");
      return { command: process.execPath, prefix: [cli] };
    }
  }
  return null;
}
function inside(parent, file) { const rel = path.relative(parent, file); return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel); }
let selected;
try { selected = resolveRig(); } catch (error) { console.log("[FAIL] rig-command-surface — " + error.message); process.exit(1); }
if (!selected) { console.log("[skip] rig-command-surface — rig is unavailable; command claims were not evaluated\n0 passed · 0 failed · 1 skipped"); process.exit(0); }
const rig = (...args) => cp.spawnSync(selected.command, [...selected.prefix, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
const ok = result => result.status === 0 && !result.error;
const json = result => { try { return ok(result) ? JSON.parse(result.stdout) : null; } catch { return null; } };
const has = (value, key, expected) => value && typeof value === "object" && (value[key] === expected || Object.values(value).some(child => has(child, key, expected)));
function words(line) {
  const out = []; let word = "", quote = "", started = false;
  for (const char of line) {
    if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { out.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quote) throw Error("Unterminated static check definition");
  if (started) out.push(word); return out;
}
const spec = read(path.join(root, "verify-world.sh"));
const passes = [...spec.matchAll(/^\s*pass ([a-z0-9-]+) /gm)];
if (!passes.length || new Set(passes.map(match => match[1])).size !== passes.length) {
  console.log("[FAIL] check-inventory — missing or duplicate named check specification\n0 passed · 1 failed · 0 skipped"); process.exit(1);
}
const requirements = new Map(); let prior = 0;
for (const match of passes) {
  const checks = [];
  for (const line of spec.slice(prior, match.index).split("\n")) {
    const grep = /^\s*(?:if )?grep -Fq(x)?(?: --)? (.+)$/.exec(line);
    const block = /^\s*has_manifest_block_line (.+)$/.exec(line);
    if (grep) {
      const [needle, rawFile] = words(grep[2]);
      const file = rawFile?.replace(/;$/, "");
      if (/^\$(?:root|example)\//.test(file ?? "") && !needle.includes("$")) checks.push({ file, needle, exact: !!grep[1] });
    } else if (block) {
      const [file, heading, needle] = words(block[1]); checks.push({ file, heading, needle, exact: true });
    }
  }
  requirements.set(match[1], checks); prior = match.index + match[0].length;
}
const filePath = value => value.replace(/^\$root(?=\/)/, () => root).replace(/^\$example(?=\/)/, () => example);
function staticCheck(id) {
  return (requirements.get(id) ?? []).every(check => {
    let text = read(filePath(check.file));
    if (check.heading) {
      const start = text.indexOf(check.heading + "\n"); if (start < 0) return false;
      text = text.slice(start + check.heading.length + 1).split(/(?=^  - (?:path|id):)/m)[0];
    }
    return check.exact ? text.split("\n").includes(check.needle) : text.includes(check.needle);
  });
}
const manifest = read(path.join(root, "manifest.yaml")), exampleManifest = read(path.join(example, "manifest.yaml"));
const prose = ["start-here.md", "build-your-world.md", "boundaries.md"].map(file => read(path.join(root, file))).join("\n") + "\n" + read(path.join(example, "your-world.md"));
const claims = read(path.join(root, "claims.yaml"));
const pinnedIds = name => spec.match(new RegExp(name + "='([\\s\\S]*?)'"))?.[1].split("\n").filter(Boolean) ?? [];
const markdownIds = pinnedIds("expected_markdown_claim_ids"), manifestIds = pinnedIds("expected_manifest_claim_ids");
const regions = text => ["identity", "ontology", "terrain", "actors", "laws", "history", "state", "affordances"].every(region => new RegExp("regions:.*\\b" + region + "\\b").test(text));
const results = new Map();
const test = (id, condition) => results.set(id, !!condition && staticCheck(id));
test("pack-taxonomy", /^taxonomy:\s*world\s*$/m.test(manifest));
test("declared-files", ["boundaries.md", "build-your-world.md", "claims.yaml", "start-here.md", "verify-world.sh", "verify-world-native.mjs"].every(file => fs.existsSync(path.join(root, file)) && manifest.includes("path: " + file)));
test("manifest-authored-comments", !/(^|\s)#\s/m.test(manifest + "\n" + exampleManifest));
test("atom-regions", regions(manifest));
const convention = read(path.join(root, "build-your-world.md"));
test("coverage-map-contract", ["product", "topology", "context", "skill", "queue/custody", "source/worktree", "proof/review", "lifecycle/release", "continuity/recovery", "host-boundary"].every(dimension => convention.split("\n").some(line => { const cells = line.split("|").map(cell => cell.trim()); return cells[1] === dimension && /^`[^`]+`$/.test(cells[2]) && cells[3] && cells[4]; })));
const actualIds = [...claims.matchAll(/^\s*- id:\s*(.+)$/gm)].map(match => match[1]);
const marked = [...prose.matchAll(/<!--\s*world-claim:\s*([a-z0-9-]+)\s*-->/g)].map(match => match[1]);
const expectedIds = [...markdownIds, ...manifestIds];
const checkIds = [...claims.matchAll(/^\s*check:\s*(.+)$/gm)].map(match => match[1]);
const known = new Set(passes.map(match => match[1]));
const statements = [...claims.matchAll(/^\s*statement: (".*")$/gm)].map(match => { try { return JSON.parse(match[1]); } catch { return null; } });
test("claim-coverage", expectedIds.length > 0 && JSON.stringify(actualIds) === JSON.stringify(expectedIds) && new Set(actualIds).size === actualIds.length
  && JSON.stringify(marked) === JSON.stringify(markdownIds) && [...claims.matchAll(/^\s+(?:check|flagged):/gm)].length === actualIds.length
  && [...claims.matchAll(/^\s+kind:\s+(?:judgment|operational|structural)\s*$/gm)].length === actualIds.length
  && checkIds.every(id => known.has(id)) && statements.length === actualIds.length && statements.every(statement => statement && (prose + manifest + exampleManifest).includes(statement)));
for (const id of ["public-manifest-authored-claims", "example-manifest-authored-claims", "author-derive-rule", "trust-source-table", "boundary-coverage", "boundary-exclusions", "authoring-convention", "taught-commands", "taxonomy-layout", "agents-md-complement"]) test(id, (requirements.get(id) ?? []).length > 0);
test("rig-command-surface", [[], ["context", "list"], ["context", "show"], ["context", "get"], ["context", "profile"], ["context", "add"], ["context", "rm"]].every(args => ok(rig(...args, "--help"))));
const publicGet = rig("context", "get", "world-public");
test("retrieve-public-pack", ok(publicGet) && ["# Enter the world", "# Build your world", "# Boundaries"].every(heading => publicGet.stdout.includes(heading)));
const profile = json(rig("context", "profile", "world-public", "--situation", "fresh", "--json"));
const profileOk = profile && Number.isInteger(profile.totalEstimatedTokens) && profile.totalEstimatedTokens > 0 && ["enter-the-world", "author-a-world", "know-the-edges"].every(id => has(profile, "atomId", id));
test("compose-fresh-profile", profileOk);
const exampleGet = rig("context", "get", "world-example");
test("retrieve-world-example", ok(exampleGet) && ["# Your world", "## Exercise: Book world", "## Checks"].every(heading => exampleGet.stdout.includes(heading)));
const shown = json(rig("context", "show", "world-public", "--json"));
const packOk = shown && shown.relativePath === "world-public" && shown.sourceType === "builtin" && real(shown.sourcePath) === real(root);
test("derive-pack-path", packOk); test("run-public-verifier", packOk && fs.existsSync(path.join(shown.sourcePath, "verify-world-native.mjs")));
const list = json(rig("context", "list", "--json"));
let namespaceOk = list && has(list, "relativePath", "world-public") && shown?.sourceType === "builtin";
if (has(list, "relativePath", "world/install")) { const privateEntry = json(rig("context", "show", "world/install", "--json")); namespaceOk &&= privateEntry?.relativePath === "world/install" && ["user_file", "workspace"].includes(privateEntry.sourceType); }
test("private-ref-boundary", namespaceOk);
const configured = rig("config", "get", "context.root"), contextRoot = configured.stdout?.trim();
let installOk = ok(configured) && !!contextRoot && (!process.env.OPENRIG_CONTEXT_ROOT || contextRoot === process.env.OPENRIG_CONTEXT_ROOT)
  && ok(rig("context", "add", "--help")) && ok(rig("context", "list", "--help"));
const ref = "world-public-verify-" + randomUUID();
const target = contextRoot ? path.join(contextRoot, ref) : null;
function cleanupProbe() {
  if (!target) return false;
  if (fs.existsSync(target) || has(json(rig("context", "list", "--json")), "relativePath", ref)) {
    rig("context", "rm", ref, "--json");
    // Only the exact newly generated probe path may be removed as fallback.
    if (fs.existsSync(target) && inside(path.resolve(contextRoot), path.resolve(target))) fs.rmSync(target, { recursive: true, force: true });
  }
  const cleaned = json(rig("context", "list", "--json"));
  return !!cleaned && !has(cleaned, "relativePath", ref) && !fs.existsSync(target);
}
if (installOk && target && !fs.existsSync(target) && !has(list, "relativePath", ref)) {
  const onExit = () => { try { cleanupProbe(); } catch (error) { console.error("Probe cleanup incomplete: " + error.message); } };
  const onInterrupt = () => process.exit(130), onTerminate = () => process.exit(143);
  process.once("exit", onExit); process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  try {
    const added = json(rig("context", "add", example, "--name", ref, "--json"));
    const listed = json(rig("context", "list", "--json"));
    installOk = !!added && typeof added.installedAt === "string" && path.resolve(added.installedAt) === path.resolve(target) && !!listed && has(listed, "relativePath", ref);
  } finally {
    try { const cleaned = cleanupProbe(); installOk &&= cleaned; if (!cleaned) console.error(`Probe cleanup unverified: ${ref} at ${target}`); }
    catch { installOk = false; }
    finally { process.removeListener("exit", onExit); process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate); }
  }
} else installOk = false;
test("world-example-install", installOk);
const expectedSession = process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME;
const identity = json(rig("whoami", "--json"));
const seat = identity?.identity ?? identity;
test("derive-identity", seat && typeof seat.rigName === "string" && !!seat.rigName && typeof seat.memberId === "string" && !!seat.memberId
  && typeof seat.sessionName === "string" && /.+@.+/.test(seat.sessionName) && (!expectedSession || seat.sessionName === expectedSession));
const topology = json(rig("ps", "--nodes", "--json"));
test("derive-topology", !!expectedSession && has(topology, "canonicalSessionName", expectedSession) && JSON.stringify(topology).includes('"rigName":'));
test("derived-reading-cost", profileOk);
const profileHelp = rig("context", "profile", "--help");
test("no-region-selector", ok(profileHelp) && !/--region(?:\s|=|$)/.test(profileHelp.stdout));
test("world-example-consistency", regions(exampleManifest));
let failed = 0, passedCount = 0;
for (const match of passes) { const id = match[1], passed = results.get(id) === true; if (!passed) failed++; else passedCount++; console.log(`[${passed ? "ok" : "FAIL"}] ${id} — ${passed ? "check passed" : "check failed"}`); }
const absent = [...results.keys()].filter(id => !passes.some(match => match[1] === id));
if (absent.length) { failed++; console.log("[FAIL] check-inventory — named checks removed from the specification: " + absent.join(", ")); }
console.log(`${passedCount} passed · ${failed} failed · 0 skipped`);
process.exitCode = failed ? 1 : 0;
