// release-0.3.2 slice 12 — `rig scope` CLI primitive.
//
// Command grammar: rig scope <tier> <verb>. v0 ships `mission` +
// `slice` tiers; `project` and `sub-slice` are reserved per the
// substrate convention `conventions/scope-and-versioning/README.md`
// (stage: provisional). The CLI mints stable dot-IDs into created
// mission/slice frontmatter per §1 of that convention.

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { attestationLineage, type AttestationLineage } from "../lib/scope/attestation-lineage.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

import {
  CLOSE_REASONS,
  MISSION_TEMPLATE_KINDS,
  SLICE_TEMPLATE_KINDS,
  STAGE_VALUES,
  ScopeCliError,
  type CloseReason,
  type MissionInfo,
  type MissionTemplateKind,
  type SliceInfo,
  type SliceTemplateKind,
  type SliceState,
  type Stage,
} from "../lib/scope/types.js";
import {
  DEFAULT_PROJECT_PREFIX,
  inferMissionDotId,
  isMissionDotId,
  isSliceDotId,
  nextEscapeBandOrdinal,
  sliceIdFromMission,
} from "../lib/scope/dot-id.js";
import {
  buildMissionDependencyGraph,
  ensureMissionId,
  ensureMissionIdPersisted,
  findMission,
  resolveNodeFile,
  findSlice,
  listMissions,
  listSlices,
  moveSlice,
  nextSliceNN,
  NOTES_FILE_PRECEDENCE,
  pad2,
  readFrontmatter,
  resolveNotesFile,
  resolveMissionsRoot,
  splitFrontmatter,
  todayDateISO,
  updateFrontmatter,
} from "../lib/scope/scope-fs.js";
import {
  renderCapabilityDeltaTemplate,
  renderNotesTemplate,
  renderMissionProgressTemplate,
  renderMissionTemplate,
  renderSliceProofTemplate,
  renderSliceProgressTemplate,
  renderSliceTemplate,
  titleFromSlug,
} from "../lib/scope/templates.js";
import {
  addProgressRow,
  DEFAULT_PROGRESS_SECTION,
  parseStatus,
  PROGRESS_STATUSES,
  setProgressRow,
} from "../lib/scope/progress-edit.js";
import { deriveScopeTrust } from "../lib/scope/trust.js";
import { capabilityDeltaExpiryFindings } from "../lib/scope/capability-delta.js";

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

interface Stdout {
  write: (text: string) => void;
}

function makeStdout(): Stdout {
  return { write: (text: string) => process.stdout.write(text) };
}

function emit(out: Stdout, payload: unknown, json: boolean, lines?: string[]): void {
  if (json) {
    out.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  if (lines) {
    for (const line of lines) out.write(line + "\n");
    return;
  }
  out.write(JSON.stringify(payload, null, 2) + "\n");
}

function fail(err: unknown, json: boolean, out: Stdout): never {
  if (err instanceof ScopeCliError) {
    if (json) {
      out.write(JSON.stringify({
        ok: false,
        error: { fact: err.fact, consequence: err.consequence, action: err.action },
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`Error: ${err.fact}\n${err.consequence}\n${err.action}\n`);
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(1);
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface RootOpts {
  workspace?: string;
}

function getOpts(cmd: Command): RootOpts {
  // commander v13 attaches opts on the parent.
  let walker: Command | null = cmd;
  while (walker) {
    const o = walker.opts() as RootOpts;
    if (o.workspace) return o;
    walker = walker.parent;
  }
  return {};
}

/** FR-5: a one-line human render of the derived stage. Shows the declared
 *  stage, and (when a weak `verified` downgrades it) the effective stage +
 *  why. Derived at read time; nothing is written. */
function formatTrustLine(trust: ReturnType<typeof deriveScopeTrust>): string {
  const declared = trust.declaredStage || "—";
  if (trust.downgraded) {
    return `  stage: ${declared} (effective: ${trust.effectiveStage} — ${trust.verified.status})\n`;
  }
  return `  stage: ${declared}\n`;
}

// ---------------------------------------------------------------------
// rig scope slice ls
// ---------------------------------------------------------------------

function buildSliceLsCommand(): Command {
  const cmd = new Command("ls")
    .description("List slices in a mission (or across all missions)")
    .option("--mission <name>", "Restrict to a single mission")
    .option("--state <state>", "Filter: active | closed | shipped | all", "active")
    .option("--json", "Machine-readable output")
    .action(async (opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      const state = (opts.state as SliceState) ?? "active";
      if (!["active", "closed", "shipped", "all"].includes(state)) {
        fail(new ScopeCliError({
          fact: `Unknown --state value "${state}".`,
          consequence: "Command did not run.",
          action: "Pick one of: active, closed, shipped, all.",
        }), json, out);
      }
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const missions = opts.mission
          ? [findMission(missionsRoot, opts.mission)]
          : listMissions(missionsRoot);
        const rows: unknown[] = [];
        const lines: string[] = [];
        for (const mission of missions) {
          const slices = listSlices(mission, state);
          for (const slice of slices) {
            rows.push({
              mission: mission.name,
              name: slice.name,
              nn: slice.nn,
              slug: slice.slug,
              id: slice.id,
              status: slice.status,
              path: slice.absPath,
            });
            lines.push(`${mission.name}/${slice.name}    ${slice.id ?? "—"}    ${slice.status ?? "—"}`);
          }
        }
        emit(out, { ok: true, count: rows.length, slices: rows }, json, lines.length === 0 ? ["(no slices)"] : lines);
      } catch (err) {
        fail(err, json, out);
      }
    });
  return cmd;
}

// ---------------------------------------------------------------------
// rig scope slice show
// ---------------------------------------------------------------------

function buildSliceShowCommand(): Command {
  return new Command("show")
    .description("Inspect a single slice (frontmatter + README + children)")
    .argument("<slice-path>", "Slice path (absolute, relative-to-substrate, or NN-slug)")
    .option("--mission <name>", "Hint mission when path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const readme = slice.readmePath ? fs.readFileSync(slice.readmePath, "utf8") : null;
        const children = fs.readdirSync(slice.absPath, { withFileTypes: true })
          .map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" as const }));
        // FR-5: derive read-time trust from (stage x verified) — NEVER stored.
        const trust = deriveScopeTrust(slice.frontmatter);
        const payload = {
          ok: true,
          slice: {
            mission: slice.missionName,
            name: slice.name,
            id: slice.id,
            status: slice.status,
            path: slice.absPath,
            frontmatter: slice.frontmatter,
            trust,
            readme,
            children,
          },
        };
        if (json) {
          out.write(JSON.stringify(payload, null, 2) + "\n");
        } else {
          out.write(`Slice: ${slice.missionName}/${slice.name}\n`);
          out.write(`  id: ${slice.id ?? "—"}\n`);
          out.write(`  status: ${slice.status ?? "—"}\n`);
          out.write(formatTrustLine(trust));
          out.write(`  path: ${slice.absPath}\n`);
          out.write(`  children: ${children.length}\n`);
          if (readme) {
            out.write("\n--- README ---\n");
            out.write(readme);
            if (!readme.endsWith("\n")) out.write("\n");
          }
        }
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope slice create
// ---------------------------------------------------------------------

function buildSliceCreateCommand(): Command {
  return new Command("create")
    .description("Create a new slice with SPEC.md, PROGRESS.md, PROOF.md, and proof/. Conventions SSOT: docs/reference/sdlc-conventions.md (installed: $OPENRIG_HOME/reference/sdlc-conventions.md).")
    .argument("<mission>", "Mission name")
    .argument("<slug>", "Short slug (becomes the folder name's suffix)")
    .option("--template <kind>", `Template: ${SLICE_TEMPLATE_KINDS.join(" | ")}`, "placeholder")
    .option("--title <text>", "Display title (defaults to titlecased slug)")
    .option("--intent <text>", "Authored intent stored in SPEC.md frontmatter (defaults to title)")
    .option("--depends-on <dot-id...>", "Advisory build-order dependencies on sibling slice dot-IDs")
    .option("--readme-only", "Write progress_rail: readme-only in README frontmatter instead of scaffolding PROGRESS.md")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, rawSlug: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const kind = opts.template as SliceTemplateKind;
        if (!SLICE_TEMPLATE_KINDS.includes(kind)) {
          throw new ScopeCliError({
            fact: `Unknown --template kind "${kind}".`,
            consequence: "Slice not created.",
            action: `Pick one of: ${SLICE_TEMPLATE_KINDS.join(", ")}.`,
          });
        }
        const slug = slugify(rawSlug);
        if (!slug) {
          throw new ScopeCliError({
            fact: `Slug "${rawSlug}" reduces to empty after slugification.`,
            consequence: "Slice not created.",
            action: "Pick a slug containing letters or digits.",
          });
        }
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        // Persist the parent mission's id back into its README at the
        // SAME moment we mint the child's id (per convention §1
        // lazy-adoption rule + guard BC BLOCK 3 — every child-mint site
        // must persist the parent's id, not just slice create).
        const missionId = ensureMissionIdPersisted(mission, missionsRoot);
        const nn = nextSliceNN(mission.absPath);
        const sliceFolder = `${pad2(nn)}-${slug}`;
        const sliceAbs = path.join(mission.absPath, "slices", sliceFolder);
        if (fs.existsSync(sliceAbs)) {
          throw new ScopeCliError({
            fact: `Slice folder ${sliceAbs} already exists.`,
            consequence: "Refusing to overwrite.",
            action: "Pick a different slug, or rm -rf the existing folder first.",
          });
        }
        const id = sliceIdFromMission(missionId, nn);
        const title = opts.title ?? titleFromSlug(slug);
        const intent = opts.intent ?? title;
        const dependsOn = Array.isArray(opts.dependsOn) ? [...new Set(opts.dependsOn as string[])] : [];
        for (const dependency of dependsOn) {
          if (!isSliceDotId(dependency) || !dependency.startsWith(`${missionId}.`)) {
            throw new ScopeCliError({
              fact: `Dependency "${dependency}" is not a sibling slice dot-ID under ${missionId}.`,
              consequence: "Slice not created.",
              action: `Use a sibling ID shaped like ${missionId}.<n>, or omit --depends-on.`,
            });
          }
        }
        const createdDate = todayDateISO();
        const body = renderSliceTemplate(kind, {
          id,
          slice_number: pad2(nn),
          slug,
          mission: mission.name,
          title,
          created_date: createdDate,
          intent,
          depends_on: dependsOn,
        });
        const proofBody = renderSliceProofTemplate({ id, title });
        fs.mkdirSync(sliceAbs, { recursive: true });
        fs.mkdirSync(path.join(sliceAbs, "proof"), { recursive: true });
        // New scaffolds author SPEC.md; existing README-backed nodes are never rewritten.
        const readmePath = path.join(sliceAbs, "SPEC.md");
        const readmeOnly = Boolean(opts.readmeOnly);
        if (readmeOnly) {
          const markerBody = body.replace(
            /^(---\n)/,
            `---\nprogress_rail: readme-only\n`,
          );
          fs.writeFileSync(readmePath, markerBody, "utf8");
        } else {
          fs.writeFileSync(readmePath, body, "utf8");
          const progressPath = path.join(sliceAbs, "PROGRESS.md");
          fs.writeFileSync(progressPath, renderSliceProgressTemplate(title), "utf8");
        }
        fs.writeFileSync(path.join(sliceAbs, "PROOF.md"), proofBody, "utf8");
        const payload = {
          ok: true,
          slice: {
            mission: mission.name,
            name: sliceFolder,
            id,
            path: sliceAbs,
            readmePath,
            template: kind,
          },
        };
        emit(out, payload, json, [
          `Created ${mission.name}/slices/${sliceFolder}`,
          `  id: ${id}`,
          `  template: ${kind}`,
          `  path: ${sliceAbs}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope slice ship
// ---------------------------------------------------------------------

function buildSliceShipCommand(): Command {
  return new Command("ship")
    .description("Ship a slice to a release mission (preserves git history)")
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .argument("<release-mission>", "Target release mission name")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, releaseMission: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const target = findMission(missionsRoot, releaseMission);
        const targetSlicesDir = path.join(target.absPath, "slices");
        fs.mkdirSync(targetSlicesDir, { recursive: true });
        const newNN = nextSliceNN(target.absPath);
        const slug = slice.slug ?? slugify(slice.name);
        const newName = `${pad2(newNN)}-${slug}`;
        const destAbs = path.join(targetSlicesDir, newName);
        const { usedGit, repoRoot } = moveSlice(slice.absPath, destAbs);
        const targetId = ensureMissionIdPersisted(target, missionsRoot);
        const newSliceId = sliceIdFromMission(targetId, newNN);
        const newReadme = resolveNodeFile(destAbs);
        if (newReadme) {
          updateFrontmatter(newReadme, {
            id: newSliceId,
            mission: target.name,
            status: `shipped-to-${target.name}`,
            "shipped-on": todayDateISO(),
            "shipped-from": slice.missionName,
          });
        }
        emit(out, {
          ok: true,
          shipped: {
            from: { mission: slice.missionName, name: slice.name, id: slice.id },
            to: { mission: target.name, name: newName, id: newSliceId, path: destAbs },
            git: { usedGit, repoRoot },
          },
        }, json, [
          `Shipped ${slice.missionName}/${slice.name} → ${target.name}/slices/${newName}`,
          `  id: ${newSliceId}`,
          `  git: ${usedGit ? "git mv" : "fs.rename (not in a git repo)"}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope slice close
// ---------------------------------------------------------------------

function buildSliceCloseCommand(): Command {
  return new Command("close")
    .description("Close a slice (move to <mission>/closed/, update status)")
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .requiredOption("--reason <reason>", `Closure reason: ${CLOSE_REASONS.join(" | ")}`)
    .option("--note <text>", "Optional closure note")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const reason = opts.reason as CloseReason;
        if (!CLOSE_REASONS.includes(reason)) {
          throw new ScopeCliError({
            fact: `Unknown --reason "${reason}".`,
            consequence: "Slice not closed.",
            action: `Pick one of: ${CLOSE_REASONS.join(", ")}.`,
          });
        }
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const mission = findMission(missionsRoot, slice.missionName);
        const closedDir = path.join(mission.absPath, "closed");
        fs.mkdirSync(closedDir, { recursive: true });
        const destName = slice.name;
        const destAbs = path.join(closedDir, destName);
        const { usedGit, repoRoot } = moveSlice(slice.absPath, destAbs);
        const newReadme = resolveNodeFile(destAbs);
        if (newReadme) {
          const updates: Record<string, unknown> = {
            status: `closed-${reason}`,
            "closed-on": todayDateISO(),
          };
          if (opts.note) updates["closure-note"] = opts.note;
          updateFrontmatter(newReadme, updates);
        }
        emit(out, {
          ok: true,
          closed: {
            mission: slice.missionName,
            name: destName,
            id: slice.id,
            reason,
            note: opts.note ?? null,
            path: destAbs,
            git: { usedGit, repoRoot },
          },
        }, json, [
          `Closed ${slice.missionName}/${slice.name} → ${slice.missionName}/closed/${destName}`,
          `  reason: ${reason}`,
          `  git: ${usedGit ? "git mv" : "fs.rename (not in a git repo)"}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope slice move
// ---------------------------------------------------------------------

function buildSliceMoveCommand(): Command {
  return new Command("move")
    .description("Move a slice between missions (re-numbers in destination)")
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .argument("<dest-mission>", "Destination mission name")
    .option("--mission <name>", "Hint source mission when slice-path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, destMission: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const target = findMission(missionsRoot, destMission);
        const targetSlicesDir = path.join(target.absPath, "slices");
        fs.mkdirSync(targetSlicesDir, { recursive: true });
        const newNN = nextSliceNN(target.absPath);
        const slug = slice.slug ?? slugify(slice.name);
        const newName = `${pad2(newNN)}-${slug}`;
        const destAbs = path.join(targetSlicesDir, newName);
        const { usedGit, repoRoot } = moveSlice(slice.absPath, destAbs);
        const targetId = ensureMissionIdPersisted(target, missionsRoot);
        const newSliceId = sliceIdFromMission(targetId, newNN);
        const newReadme = resolveNodeFile(destAbs);
        if (newReadme) {
          updateFrontmatter(newReadme, {
            id: newSliceId,
            mission: target.name,
            "moved-on": todayDateISO(),
            "moved-from": slice.missionName,
          });
        }
        emit(out, {
          ok: true,
          moved: {
            from: { mission: slice.missionName, name: slice.name, id: slice.id },
            to: { mission: target.name, name: newName, id: newSliceId, path: destAbs },
            git: { usedGit, repoRoot },
          },
        }, json, [
          `Moved ${slice.missionName}/${slice.name} → ${target.name}/slices/${newName}`,
          `  id: ${newSliceId}`,
          `  git: ${usedGit ? "git mv" : "fs.rename (not in a git repo)"}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope mission ls / show / create
// ---------------------------------------------------------------------

function buildMissionLsCommand(): Command {
  return new Command("ls")
    .description("List missions (top-level folders with SPEC.md or a legacy README.md)")
    .option("--json", "Machine-readable output")
    .action(async (opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const missions = listMissions(missionsRoot);
        const rows = missions.map((m) => ({
          name: m.name,
          id: m.id,
          path: m.absPath,
          activeSliceCount: m.activeSliceCount,
          closedSliceCount: m.closedSliceCount,
        }));
        emit(out, { ok: true, count: rows.length, missions: rows }, json,
          rows.length === 0
            ? ["(no missions)"]
            : rows.map((r) => `${r.name}    ${r.id ?? "—"}    active=${r.activeSliceCount}  closed=${r.closedSliceCount}`),
        );
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionShowCommand(): Command {
  return new Command("show")
    .description("Inspect a single mission")
    .argument("<mission>", "Mission name")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        const readme = mission.readmePath ? fs.readFileSync(mission.readmePath, "utf8") : null;
        const slices = listSlices(mission, "all").map((s) => ({
          name: s.name, id: s.id, status: s.status, nn: s.nn,
        }));
        // FR-5: derive read-time trust from (stage x verified) — NEVER stored.
        const trust = deriveScopeTrust(mission.frontmatter);
        const payload = {
          ok: true,
          mission: {
            name: mission.name,
            id: mission.id,
            path: mission.absPath,
            activeSliceCount: mission.activeSliceCount,
            closedSliceCount: mission.closedSliceCount,
            frontmatter: mission.frontmatter,
            trust,
            readme,
            slices,
          },
        };
        if (json) {
          out.write(JSON.stringify(payload, null, 2) + "\n");
        } else {
          out.write(`Mission: ${mission.name}\n`);
          out.write(`  id: ${mission.id ?? "—"}\n`);
          out.write(formatTrustLine(trust));
          out.write(`  active slices: ${mission.activeSliceCount}\n`);
          out.write(`  closed slices: ${mission.closedSliceCount}\n`);
          out.write(`  path: ${mission.absPath}\n`);
          if (readme) {
            out.write(`\n--- ${path.basename(mission.readmePath!)} ---\n`);
            out.write(readme);
            if (!readme.endsWith("\n")) out.write("\n");
          }
        }
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionCreateCommand(): Command {
  return new Command("create")
    .description("Create a new mission (mints a stable dot-ID into frontmatter)")
    .argument("<name>", "Mission folder name (e.g., release-0.4.0, backlog-foo)")
    .option("--template <kind>", `Template: ${MISSION_TEMPLATE_KINDS.join(" | ")} (auto when name matches release-X.Y.Z)`, "")
    .option("--id <dot-id>", "Explicit dot-ID. Overrides name-pattern inference.")
    .option("--title <text>", "Display title (defaults to titlecased name)")
    .option("--intent <text>", "Authored intent stored in SPEC.md frontmatter (defaults to title)")
    .option("--depends-on <dot-id...>", "Advisory build-order dependencies on sibling mission dot-IDs")
    .option("--no-notes", "Skip NOTES.md scaffolding")
    .option("--no-mission-notes", "Deprecated alias for --no-notes")
    .option("--json", "Machine-readable output")
    .action(async (rawName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const name = rawName.trim();
        if (!name || /[\\/\s]/.test(name)) {
          throw new ScopeCliError({
            fact: `Invalid mission name "${rawName}".`,
            consequence: "Mission not created.",
            action: "Pick a name with no whitespace or path separators.",
          });
        }
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const absPath = path.join(missionsRoot, name);
        if (fs.existsSync(absPath)) {
          throw new ScopeCliError({
            fact: `Mission folder ${absPath} already exists.`,
            consequence: "Refusing to overwrite.",
            action: "Pick a different name, or use `rig scope mission show <name>` to inspect the existing mission.",
          });
        }
        // Resolve template kind: explicit > release-pattern auto > placeholder.
        const isReleaseName = /^release-\d+\.\d+(?:\.\d+)?$/.test(name);
        let templateKind: MissionTemplateKind = opts.template as MissionTemplateKind;
        if (!templateKind) templateKind = isReleaseName ? "release" : "placeholder";
        if (!MISSION_TEMPLATE_KINDS.includes(templateKind)) {
          throw new ScopeCliError({
            fact: `Unknown --template kind "${templateKind}".`,
            consequence: "Mission not created.",
            action: `Pick one of: ${MISSION_TEMPLATE_KINDS.join(", ")}.`,
          });
        }
        // Mint the dot-ID.
        let id: string;
        if (opts.id) {
          // Tier-aware validation per guard BC verdict (BLOCK 1).
          // A mission ID has 2-3 numeric segments after the prefix
          // (release X.Y or X.Y.Z; escape-band 99.x.y). Reject
          // slice-shaped IDs (4 segments) so the parent identity stays
          // unambiguous.
          if (!isMissionDotId(opts.id)) {
            throw new ScopeCliError({
              fact: `Supplied --id "${opts.id}" is not a mission-tier dot-ID.`,
              consequence: "Mission not created. A mission ID has the shape <PFX>.<ver> (2-3 numeric segments), not a slice shape <PFX>.<ver>.<n>.",
              action: "Use a mission-shaped dot-ID like OPR.0.3.2 (release) or OPR.99.0.1 (escape band). For slice IDs, scope automatically mints them when you create a slice.",
            });
          }
          id = opts.id;
        } else if (isReleaseName) {
          id = inferMissionDotId(name, null);
        } else {
          const peers = listMissions(missionsRoot);
          const ordinal = nextEscapeBandOrdinal(peers.map((p) => p.id));
          id = inferMissionDotId(name, ordinal);
        }
        // Resolve titles + render templates before any filesystem side
        // effects. A stale current or legacy notes-template override must
        // fail before mkdir, or it leaks a half-created mission directory.
        const title = opts.title ?? titleFromSlug(name.replace(/^release-/, ""));
        const intent = opts.intent ?? title;
        const dependsOn = Array.isArray(opts.dependsOn) ? [...new Set(opts.dependsOn as string[])] : [];
        const project = id.split(".")[0];
        for (const dependency of dependsOn) {
          if (!isMissionDotId(dependency) || dependency.split(".")[0] !== project) {
            throw new ScopeCliError({
              fact: `Dependency "${dependency}" is not a sibling mission dot-ID in project ${project}.`,
              consequence: "Mission not created.",
              action: `Use a mission ID shaped like ${project}.<version>, or omit --depends-on.`,
            });
          }
        }
        const releaseVersion = isReleaseName ? name.replace(/^release-/, "") : "";
        const readmeBody = renderMissionTemplate(templateKind, {
          id,
          slug: name,
          mission: name,
          title,
          created_date: todayDateISO(),
          release_version: releaseVersion,
          intent,
          depends_on: dependsOn,
        });
        let notesRendered: ReturnType<typeof renderNotesTemplate> | null = null;
        if (opts.notes !== false && opts.missionNotes !== false) {
          notesRendered = renderNotesTemplate({
            mission_id: id,
            mission_name: title,
            created_date: todayDateISO(),
          });
        }
        const progressBody = renderMissionProgressTemplate(title);
        const capabilityDeltaBody = isReleaseName
          ? renderCapabilityDeltaTemplate({
              id,
              slug: name,
              mission: name,
              title,
              created_date: todayDateISO(),
              release_version: releaseVersion,
              intent,
              depends_on: dependsOn,
            })
          : null;
        // All renders succeeded — safe to touch the filesystem.
        fs.mkdirSync(absPath, { recursive: true });
        fs.mkdirSync(path.join(absPath, "slices"), { recursive: true });
        // New scaffolds author SPEC.md; existing README-backed nodes are never rewritten.
        const readmePath = path.join(absPath, "SPEC.md");
        fs.writeFileSync(readmePath, readmeBody, "utf8");
        const progressPath = path.join(absPath, "PROGRESS.md");
        fs.writeFileSync(progressPath, progressBody, "utf8");
        const capabilityDeltaPath = capabilityDeltaBody
          ? path.join(absPath, `CAPABILITY-DELTA-v${releaseVersion}.md`)
          : null;
        if (capabilityDeltaPath && capabilityDeltaBody) {
          fs.writeFileSync(capabilityDeltaPath, capabilityDeltaBody, "utf8");
        }
        let notesPath: string | null = null;
        if (notesRendered) {
          notesPath = path.join(absPath, "NOTES.md");
          fs.writeFileSync(notesPath, notesRendered.rendered, "utf8");
        }
        const humanLines = [
          `Created mission ${name}`,
          `  id: ${id}`,
          `  template: ${templateKind}`,
          `  path: ${absPath}`,
        ];
        if (notesPath) {
          humanLines.push(`  notes: ${notesPath} (template: ${notesRendered?.resolvedFrom})`);
        }
        if (capabilityDeltaPath) humanLines.push(`  capability delta: ${capabilityDeltaPath}`);
        if (notesRendered?.resolvedFrom === "legacy-env") {
          humanLines.push("  advisory: OPENRIG_MISSION_NOTES_TEMPLATE_PATH is deprecated; use OPENRIG_NOTES_TEMPLATE_PATH");
        }
        emit(out, {
          ok: true,
          mission: {
            name,
            id,
            template: templateKind,
            path: absPath,
            readmePath,
            notesPath,
            capabilityDeltaPath,
            notesResolvedFrom: notesRendered?.resolvedFrom ?? null,
            advisories: notesRendered?.resolvedFrom === "legacy-env"
              ? ["OPENRIG_MISSION_NOTES_TEMPLATE_PATH is deprecated; use OPENRIG_NOTES_TEMPLATE_PATH"]
              : [],
          },
        }, json, humanLines);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionGraphCommand(): Command {
  return new Command("graph")
    .description("Show advisory sibling build-order edges and the current ready set")
    .argument("<mission>", "Mission name")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const graph = buildMissionDependencyGraph(findMission(missionsRoot, missionName));
        emit(out, { ok: true, graph }, json, [
          `Ready: ${graph.ready.join(", ") || "(none)"}`,
          ...graph.waiting.map((row) => `Waiting: ${row.id} on ${row.on.join(", ")}`),
          ...graph.advisories.map((row) => `Advisory: ${row.id}${row.dependency ? ` -> ${row.dependency}` : ""}: ${row.message}`),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// Audit (B2 — read-only scope audit)
// ---------------------------------------------------------------------

function buildAuditCommand(): Command {
  return new Command("audit")
    .description("Read-only scope audit: flag scope findings and show the advisory dependency graph")
    .requiredOption("--mission <name>", "Mission to audit")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const { classifyScopeItem } = await import("../lib/scope/scope-audit.js");
        const missionName = opts.mission as string;

        const missionDir = path.join(missionsRoot, missionName);
        if (!fs.existsSync(missionDir)) {
          throw new ScopeCliError({ fact: `Mission "${missionName}" not found at ${missionDir}.`, consequence: "Cannot audit.", action: "Check the mission name." });
        }

        const missionReadme = resolveNodeFile(missionDir) ?? path.join(missionDir, "SPEC.md");
        const missionProgress = path.join(missionDir, "PROGRESS.md");
        const missionNotesResolution = resolveNotesFile(missionDir);
        const missionNotesPath = missionNotesResolution?.path
          ?? path.join(missionDir, NOTES_FILE_PRECEDENCE[0]);
        const missionReadmeExists = fs.existsSync(missionReadme);
        const missionProgressExists = fs.existsSync(missionProgress);
        const auditMission: MissionInfo = missionReadmeExists
          ? findMission(missionsRoot, missionName)
          : {
              name: missionName,
              absPath: missionDir,
              readmePath: null,
              frontmatter: {},
              id: null,
              activeSliceCount: 0,
              closedSliceCount: 0,
            };
        const graph = buildMissionDependencyGraph(auditMission);

        let missionResult: ReturnType<typeof classifyScopeItem>;
        if (!missionReadmeExists && missionProgressExists) {
          missionResult = {
            railStatus: "malformed",
            findings: [{
              kind: "orphan_progress",
              severity: "high",
              path: missionDir,
              message: `PROGRESS.md exists but no SPEC.md or legacy README.md (orphan progress rail, no backing scope item)`,
              remediation: `Add SPEC.md with frontmatter id, or remove the orphan PROGRESS.md`,
            }],
            frontmatterError: null,
          };
        } else {
          const missionFm = missionReadmeExists
            ? extractFrontmatterRaw(fs.readFileSync(missionReadme, "utf-8"))
            : null;
          missionResult = classifyScopeItem({
            id: null,
            path: missionDir,
            readmeFrontmatterRaw: missionFm,
            progressFileExists: missionProgressExists,
            readmeOnlyMarker: false,
            isActiveRelease: true,
            level: "mission",
            missionNotesResolution,
            missionNotesPath,
          });
        }

        const missionShadow = shadowedNodeFileFinding(missionDir, "mission");
        if (missionShadow) missionResult.findings.push(missionShadow);
        missionResult.findings.push(...capabilityDeltaExpiryFindings(missionDir));

        const slicesDir = path.join(missionDir, "slices");
        const dogfoodEvidenceRoot = defaultDogfoodEvidenceRoot(missionsRoot);
        const sliceResults: Array<{
          name: string;
          result: ReturnType<typeof classifyScopeItem>;
          attestations?: AttestationLineage;
        }> = [];

        if (fs.existsSync(slicesDir)) {
          for (const entry of fs.readdirSync(slicesDir)) {
            const sliceDir = path.join(slicesDir, entry);
            if (!fs.statSync(sliceDir).isDirectory()) continue;
            const sliceReadme = resolveNodeFile(sliceDir) ?? path.join(sliceDir, "SPEC.md");
            const sliceProgress = path.join(sliceDir, "PROGRESS.md");
            const proofFile = path.join(sliceDir, "PROOF.md");
            const proofDir = path.join(sliceDir, "proof");

            if (!fs.existsSync(sliceReadme)) {
              if (fs.existsSync(sliceProgress)) {
                sliceResults.push({
                  name: entry,
                  result: {
                    railStatus: "malformed" as const,
                    findings: [{
                      kind: "orphan_progress" as const,
                      severity: "high" as const,
                      path: sliceDir,
                      message: `PROGRESS.md exists but no SPEC.md or legacy README.md (orphan progress rail, no backing scope item)`,
                      remediation: `Add SPEC.md with frontmatter id, or remove the orphan PROGRESS.md`,
                    }],
                    frontmatterError: null,
                  },
                });
              } else {
                const noReadmeResult = classifyScopeItem({
                  id: null,
                  path: sliceDir,
                  readmeFrontmatterRaw: null,
                  progressFileExists: false,
                  readmeOnlyMarker: false,
                  isActiveRelease: true,
                  level: "slice",
                });
                sliceResults.push({ name: entry, result: noReadmeResult });
              }
              continue;
            }

            const sliceReadmeContent = fs.readFileSync(sliceReadme, "utf-8");
            const sliceFm = extractFrontmatterRaw(sliceReadmeContent);
            const readmeOnlyMarker = sliceFm !== null && /^progress_rail\s*:\s*readme-only/m.test(sliceFm);

            const sliceResult = classifyScopeItem({
              id: null,
              path: sliceDir,
              readmeFrontmatterRaw: sliceFm,
              progressFileExists: fs.existsSync(sliceProgress),
              readmeOnlyMarker,
              isActiveRelease: true,
              level: "slice",
              proofFileExists: fs.existsSync(proofFile),
              proofFilePath: proofFile,
              proofDirExists: fs.existsSync(proofDir),
              proofDirPath: proofDir,
              proofDirHasEntries: directoryHasEntries(proofDir),
              hasProofPacket: hasProofPacketForSlice(dogfoodEvidenceRoot, entry),
              // OPR.0.4.4.19 FR-10 backstop inputs.
              proofArtifacts: listProofArtifactsForAudit(proofDir),
              implementationPrdExists: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md")),
              // OPR.0.4.4.23 convention-section advisory inputs.
              nodeFileName: path.basename(sliceReadme) as "SPEC.md" | "README.md",
              readmeContent: sliceReadmeContent,
              implementationPrdContent: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"))
                ? fs.readFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "utf-8")
                : null,
            });

            if (!/^\d{2}-/.test(entry)) {
              sliceResult.findings.push({
                kind: "id_convention_violation",
                severity: "high",
                path: sliceDir,
                message: `Directory "${entry}" does not match the NN-slug slice naming convention (e.g. 01-my-slice)`,
                remediation: `Rename to NN-slug format or move out of slices/`,
              });
            }

            sliceResults.push({ name: entry, result: sliceResult, attestations: attestationLineage(sliceFm) });
          }
        }

        for (const sr of sliceResults) {
          const shadow = shadowedNodeFileFinding(path.join(slicesDir, sr.name), "slice");
          if (shadow) sr.result.findings.push(shadow);
        }

        const allFindings = [
          ...missionResult.findings.map((f) => ({ ...f, scope: "mission" as const, scopeName: missionName })),
          ...sliceResults.flatMap((s) => s.result.findings.map((f) => ({ ...f, scope: "slice" as const, scopeName: s.name }))),
        ];
        const hardFindings = allFindings.filter((f) => f.severity === "high");

        if (json) {
          out.write(JSON.stringify({
            ok: hardFindings.length === 0,
            mission: { name: missionName, railStatus: missionResult.railStatus, frontmatterError: missionResult.frontmatterError, findings: missionResult.findings },
            slices: sliceResults.map((s) => ({
              name: s.name,
              railStatus: s.result.railStatus,
              frontmatterError: s.result.frontmatterError,
              findings: s.result.findings,
              // OPR.0.5.0.18 — amendment lineage (present only when re-stamped).
              ...(s.attestations ? { attestations: s.attestations } : {}),
            })),
            graph,
            totalFindings: allFindings.length,
          }, null, 2));
          out.write("\n");
          if (hardFindings.length > 0) process.exitCode = 1;
          return;
        }

        out.write(`Scope audit: ${missionName}\n`);
        out.write(`Mission rail: ${missionResult.railStatus}\n`);
        out.write(`Slices: ${sliceResults.length} total\n`);
        out.write(`Ready: ${graph.ready.join(", ") || "(none)"}\n`);
        for (const row of graph.waiting) out.write(`Waiting: ${row.id} on ${row.on.join(", ")}\n`);
        for (const row of graph.advisories) {
          out.write(`Advisory: ${row.id}${row.dependency ? ` -> ${row.dependency}` : ""}: ${row.message}\n`);
        }
        out.write("\n");

        // OPR.0.5.0.18 — amendment lineage: a re-stamped slice shows the
        // CURRENT attestation + prior-count (the append-only audit rows
        // reconstruct the full history; this is the at-a-glance surface).
        const amended = sliceResults.filter((s) => s.attestations);
        if (amended.length > 0) {
          out.write("AMENDMENT LINEAGE:\n");
          for (const s of amended) {
            for (const [scope, att] of Object.entries(s.attestations!)) {
              out.write(`  ${s.name} [${scope}]: current ${att.by} at ${att.at} — ${att.priors} prior attestation(s) in the audit log\n`);
            }
          }
          out.write("\n");
        }

        if (allFindings.length > 0) {
          out.write("FINDINGS:\n");
          for (const f of allFindings) {
            out.write(`  [${f.severity}] [${f.kind}] ${f.scope}/${f.scopeName}\n`);
            out.write(`    ${f.message}\n`);
            out.write(`    fix: ${f.remediation}\n`);
          }
          if (hardFindings.length > 0) {
            out.write(`\nFAIL: ${allFindings.length} finding(s)\n`);
            process.exitCode = 1;
          } else {
            out.write(`\nWARN: ${allFindings.length} advisory finding(s)\n`);
          }
        } else {
          out.write("PASS: all scope items have valid rails\n");
        }
      } catch (err) {
        if (err instanceof ScopeCliError) { fail(err, json, out); }
        throw err;
      }
    });
}

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
}

function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

function defaultDogfoodEvidenceRoot(missionsRoot: string): string {
  return path.join(path.dirname(missionsRoot), "dogfood-evidence");
}

// OPR.0.4.4.19 FR-10 (C1 backstop input) — list the slice's proof/ markdown
// artifacts with raw frontmatter. Media files are exempt by construction.
// Undefined when the dir is absent/unreadable so the classifier stays inert.
function listProofArtifactsForAudit(proofDir: string): Array<{ path: string; frontmatterRaw: string | null }> | undefined {
  if (!fs.existsSync(proofDir)) return undefined;
  try {
    return fs.readdirSync(proofDir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => {
        const artifactPath = path.join(proofDir, f);
        return { path: artifactPath, frontmatterRaw: extractFrontmatterRaw(fs.readFileSync(artifactPath, "utf-8")) };
      });
  } catch {
    return undefined;
  }
}

function hasProofPacketForSlice(dogfoodEvidenceRoot: string, sliceName: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dogfoodEvidenceRoot, { withFileTypes: true });
  } catch {
    return false;
  }

  const sliceTokens = sliceName.split("-").filter((token) => token.length > 0 && !/^v\d+$/.test(token));
  return entries.some((entry) => {
    if (!entry.isDirectory()) return false;
    const dirTokenSet = new Set(entry.name.split(/[-._]/).filter((token) => token.length > 0));
    return sliceTokens.every((token) => dirTokenSet.has(token));
  });
}

// ---------------------------------------------------------------------
// rig scope <tier> progress  (OPR.0.4.0.33 FR-3 — deterministic update)
// ---------------------------------------------------------------------

/** Resolve which file a progress update edits for a scope dir: the
 *  PROGRESS.md when present, else the README's rail for a readme-only
 *  scope, else an error directing to create/repair (the verb UPDATES an
 *  existing surface; it does not scaffold). */
function resolveProgressTarget(scopeDir: string, level: "mission" | "slice"): {
  targetPath: string;
  kind: "progress" | "readme-only";
} {
  const progressPath = path.join(scopeDir, "PROGRESS.md");
  if (fs.existsSync(progressPath)) return { targetPath: progressPath, kind: "progress" };
  const readmePath = resolveNodeFile(scopeDir);
  if (readmePath) {
    const fm = readFrontmatter(readmePath);
    if (String(fm.progress_rail ?? "") === "readme-only") {
      return { targetPath: readmePath, kind: "readme-only" };
    }
  }
  throw new ScopeCliError({
    fact: `${level} at ${scopeDir} has no progress surface (no PROGRESS.md and no readme-only rail).`,
    consequence: "The progress verb updates an existing surface; it does not scaffold.",
    action: `Backfill it with: rig scope ${level} repair <target> (creates PROGRESS.md), or rig scope ${level} create.`,
  });
}

/** Shared body for slice/mission progress: validate the mutually
 *  exclusive --add/--set modes, edit the resolved surface, write only
 *  on change. */
function runProgressUpdate(
  scopeDir: string,
  level: "mission" | "slice",
  scopeName: string,
  opts: { add?: string; set?: string; section?: string; status?: string },
  out: Stdout,
  json: boolean,
): void {
  const hasAdd = typeof opts.add === "string";
  const hasSet = typeof opts.set === "string";
  if (hasAdd === hasSet) {
    throw new ScopeCliError({
      fact: hasAdd
        ? "Both --add and --set were given."
        : "Neither --add nor --set was given.",
      consequence: "No progress update was made.",
      action: 'Pass exactly one of --add "<row text>" or --set "<row text>".',
    });
  }
  const status = parseStatus(opts.status ?? "active");
  const { targetPath, kind } = resolveProgressTarget(scopeDir, level);
  const before = fs.readFileSync(targetPath, "utf8");

  let result: { content: string; changed: boolean };
  let operation: "add" | "set";
  if (hasAdd) {
    operation = "add";
    result = addProgressRow(before, {
      section: opts.section ?? DEFAULT_PROGRESS_SECTION,
      text: opts.add!,
      status,
    });
  } else {
    operation = "set";
    result = setProgressRow(before, { text: opts.set!, status });
  }

  if (result.changed) fs.writeFileSync(targetPath, result.content, "utf8");

  emit(out, {
    ok: true,
    progress: {
      scope: level,
      name: scopeName,
      target: targetPath,
      kind,
      operation,
      status,
      changed: result.changed,
    },
  }, json, [
    `${result.changed ? "Updated" : "No change"} ${level} ${scopeName} progress (${operation})`,
    `  target: ${targetPath}`,
    `  status: ${status}`,
  ]);
}

function buildSliceProgressCommand(): Command {
  return new Command("progress")
    .description("Update a slice's progress rail deterministically (append a row, or set a row's status)")
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .option("--add <text>", "Append a checkbox row with this text")
    .option("--set <text>", "Set the status of the row whose trimmed text exactly matches")
    .option("--section <heading>", `Section heading for --add (default: ${DEFAULT_PROGRESS_SECTION})`)
    .option("--status <status>", `Row status: ${PROGRESS_STATUSES.join(" | ")}`, "active")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        runProgressUpdate(slice.absPath, "slice", slice.name, opts, out, json);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionProgressCommand(): Command {
  return new Command("progress")
    .description("Update a mission's progress rail deterministically (append a row, or set a row's status)")
    .argument("<mission>", "Mission name")
    .option("--add <text>", "Append a checkbox row with this text")
    .option("--set <text>", "Set the status of the row whose trimmed text exactly matches")
    .option("--section <heading>", `Section heading for --add (default: ${DEFAULT_PROGRESS_SECTION})`)
    .option("--status <status>", `Row status: ${PROGRESS_STATUSES.join(" | ")}`, "active")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        runProgressUpdate(mission.absPath, "mission", mission.name, opts, out, json);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope <tier> repair  (OPR.0.4.0.33 FR-6 — idempotent backfill)
// ---------------------------------------------------------------------

interface BackfillResult {
  scope: "mission" | "slice";
  name: string;
  created: boolean;
  reason: string;
  path: string | null;
}

/** Mirror the create-time title derivation so a backfilled PROGRESS.md
 *  is byte-identical to what create would have written. */
function backfillTitle(level: "mission" | "slice", scopeDir: string): string {
  const base = path.basename(scopeDir);
  return level === "mission"
    ? titleFromSlug(base.replace(/^release-/, ""))
    : titleFromSlug(base.replace(/^\d+-/, ""));
}

/** Create a missing PROGRESS.md for a single scope dir. Idempotent
 *  (skips when one exists) and non-clobbering (skips an intentional
 *  readme-only scope, and skips README-less dirs that are not declared
 *  scopes). */
function backfillScopeProgress(scopeDir: string, level: "mission" | "slice"): BackfillResult {
  const name = path.basename(scopeDir);
  const readmePath = resolveNodeFile(scopeDir);
  if (!readmePath) {
    return { scope: level, name, created: false, reason: "no-readme (not a declared scope)", path: null };
  }
  const progressPath = path.join(scopeDir, "PROGRESS.md");
  if (fs.existsSync(progressPath)) {
    return { scope: level, name, created: false, reason: "already-present", path: progressPath };
  }
  const fm = readFrontmatter(readmePath);
  if (String(fm.progress_rail ?? "") === "readme-only") {
    return { scope: level, name, created: false, reason: "readme-only (intentional opt-out)", path: null };
  }
  const title = backfillTitle(level, scopeDir);
  const body = level === "mission"
    ? renderMissionProgressTemplate(title)
    : renderSliceProgressTemplate(title);
  fs.writeFileSync(progressPath, body, "utf8");
  return { scope: level, name, created: true, reason: "backfilled", path: progressPath };
}

// ---------------------------------------------------------------------
// OPR.0.4.1.6 — stage + verified verbs (deterministic §2 maturity edits)
// ---------------------------------------------------------------------

/** Validate a stage against the §2 enum, rejecting invented values. */
function validateStage(raw: string): Stage {
  if (!STAGE_VALUES.includes(raw as Stage)) {
    throw new ScopeCliError({
      fact: `Invalid stage "${raw}".`,
      consequence: "Stage not changed.",
      action: `Use one of: ${STAGE_VALUES.join(" | ")}.`,
    });
  }
  return raw as Stage;
}

/** Surgically set `stage` (+ `superseded-by` when superseded) on a scope
 *  README, enforcing the §2 superseded-needs-successor rule. */
function applyStage(readmePath: string, stage: Stage, successor: unknown): void {
  const updates: Record<string, unknown> = { stage };
  if (stage === "superseded") {
    const id = typeof successor === "string" ? successor.trim() : "";
    if (!id) {
      throw new ScopeCliError({
        fact: "stage 'superseded' requires a successor.",
        consequence: "Stage not changed (a superseded scope must name what replaces it, per scope-and-versioning §2).",
        action: "Re-run with --successor <id>, e.g. --successor OPR.0.4.1.7.",
      });
    }
    updates["superseded-by"] = id;
  }
  updateFrontmatter(readmePath, updates);
}

/** `retired` is an exit, not a rung — warn (do not block). */
function warnRetired(stage: Stage): void {
  if (stage === "retired") {
    process.stderr.write("Warning: stage 'retired' means do-not-use (an exit, not a maturity rung).\n");
  }
}

/** Validate a --against provenance: mandatory, non-empty, non-whitespace
 *  (the §2 "no bare timestamp" rule). Returns the trimmed source. */
function validateAgainst(raw: unknown): string {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (!source) {
    throw new ScopeCliError({
      fact: "--against provenance is empty or missing.",
      consequence: "verified not stamped — scope-and-versioning §2 forbids a bare timestamp without a named source.",
      action: 'Provide what it was verified against, e.g. --against "runtime (npm+tag+origin)".',
    });
  }
  return source;
}

function buildSliceStageCommand(): Command {
  return new Command("stage")
    .description(`Set a slice's epistemic stage (${STAGE_VALUES.join(" | ")}); superseded needs --successor`)
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .argument("<new-stage>", `New stage: ${STAGE_VALUES.join(" | ")}`)
    .option("--successor <id>", "Successor scope id — REQUIRED when new-stage is superseded")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, newStage: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const stage = validateStage(newStage);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        if (!slice.readmePath) {
          throw new ScopeCliError({
            fact: `Slice ${slice.name} has no SPEC.md or legacy README.md.`,
            consequence: "Stage is a work-node frontmatter field; nothing to write.",
            action: "Create the slice with `rig scope slice create` before setting its stage.",
          });
        }
        applyStage(slice.readmePath, stage, opts.successor);
        warnRetired(stage);
        const supersededBy = stage === "superseded" ? String(opts.successor).trim() : undefined;
        emit(out, { ok: true, scope: { tier: "slice", mission: slice.missionName, name: slice.name, id: slice.id, stage, ...(supersededBy ? { supersededBy } : {}) } }, json, [
          `Set ${slice.missionName}/${slice.name} stage: ${stage}`,
          ...(supersededBy ? [`  superseded-by: ${supersededBy}`] : []),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionStageCommand(): Command {
  return new Command("stage")
    .description(`Set a mission's epistemic stage (${STAGE_VALUES.join(" | ")}); superseded needs --successor`)
    .argument("<mission>", "Mission name")
    .argument("<new-stage>", `New stage: ${STAGE_VALUES.join(" | ")}`)
    .option("--successor <id>", "Successor scope id — REQUIRED when new-stage is superseded")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, newStage: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const stage = validateStage(newStage);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        if (!mission.readmePath) {
          throw new ScopeCliError({
            fact: `Mission ${mission.name} has no SPEC.md or legacy README.md.`,
            consequence: "Stage is a work-node frontmatter field; nothing to write.",
            action: "Create the mission with `rig scope mission create` before setting its stage.",
          });
        }
        applyStage(mission.readmePath, stage, opts.successor);
        warnRetired(stage);
        const supersededBy = stage === "superseded" ? String(opts.successor).trim() : undefined;
        emit(out, { ok: true, scope: { tier: "mission", name: mission.name, id: mission.id, stage, ...(supersededBy ? { supersededBy } : {}) } }, json, [
          `Set ${mission.name} stage: ${stage}`,
          ...(supersededBy ? [`  superseded-by: ${supersededBy}`] : []),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildSliceVerifiedCommand(): Command {
  return new Command("verified")
    .description("Stamp a slice's verified line: <today> against <source> (provenance mandatory; overwrites the prior line)")
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .option("--against <source>", "What it was verified against — MANDATORY (no bare timestamps)")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const source = validateAgainst(opts.against);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        if (!slice.readmePath) {
          throw new ScopeCliError({
            fact: `Slice ${slice.name} has no SPEC.md or legacy README.md.`,
            consequence: "verified is a work-node frontmatter field; nothing to write.",
            action: "Create the slice with `rig scope slice create` before stamping verified.",
          });
        }
        const verified = `${todayDateISO()} against ${source}`;
        updateFrontmatter(slice.readmePath, { verified });
        emit(out, { ok: true, scope: { tier: "slice", mission: slice.missionName, name: slice.name, id: slice.id, verified } }, json, [
          `Stamped ${slice.missionName}/${slice.name} verified: ${verified}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionVerifiedCommand(): Command {
  return new Command("verified")
    .description("Stamp a mission's verified line: <today> against <source> (provenance mandatory; overwrites the prior line)")
    .argument("<mission>", "Mission name")
    .option("--against <source>", "What it was verified against — MANDATORY (no bare timestamps)")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const source = validateAgainst(opts.against);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        if (!mission.readmePath) {
          throw new ScopeCliError({
            fact: `Mission ${mission.name} has no SPEC.md or legacy README.md.`,
            consequence: "verified is a work-node frontmatter field; nothing to write.",
            action: "Create the mission with `rig scope mission create` before stamping verified.",
          });
        }
        const verified = `${todayDateISO()} against ${source}`;
        updateFrontmatter(mission.readmePath, { verified });
        emit(out, { ok: true, scope: { tier: "mission", name: mission.name, id: mission.id, verified } }, json, [
          `Stamped ${mission.name} verified: ${verified}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// OPR.0.4.1.6 FR-4 — frontmatter-conformance backfill (extends `repair`).
// `repair` historically backfilled a missing PROGRESS.md only; per the
// convention's "consolidate, do not invent" it now ALSO conforms the mandatory
// scope-and-versioning §1/§2 frontmatter (id / stage / verified) in the SAME
// idempotent verb, rather than adding a parallel `reconcile`.

interface FrontmatterConformResult {
  /** Minted+written id, or null if already present / unmintable. */
  idAdded: string | null;
  /** Added stage, or null if already present. */
  stageAdded: string | null;
  /** Added verified placeholder, or null if already present. */
  verifiedAdded: string | null;
  changed: boolean;
}

/** Map a legacy `status:` to a §4 migration stage. Default `wip` when absent
 *  or unmapped (the safe floor). */
function mapLegacyStatusToStage(status: unknown): string {
  const s = typeof status === "string" ? status.toLowerCase().trim() : "";
  if (s === "placeholder") return "wip";
  if (s === "draft" || s === "draft-for-comms") return "wip";
  if (s === "active" || s === "in-flight") return "established";
  if (s.startsWith("shipped") || s.startsWith("closed")) return "established";
  if (s === "ready-for-mission" || s === "ready-for-orch-dispatch") return "provisional";
  return "wip";
}

/** Preserve a malformed value before repair replaces it with the conformant
 *  representation. A pre-existing preservation key means a prior repair has
 *  already recorded a different original; refusing is the only lossless move. */
function preserveMalformedFrontmatterValue(
  frontmatter: Record<string, unknown>,
  updates: Record<string, unknown>,
  key: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) return;
  const preservedKey = `repair-original-${key.replaceAll("_", "-")}`;
  if (Object.prototype.hasOwnProperty.call(frontmatter, preservedKey)) {
    throw new ScopeCliError({
      fact: `${key} is malformed and ${preservedKey} already exists.`,
      consequence: "Repair refused rather than overwrite either authored value.",
      action: `Resolve ${key} manually and retain ${preservedKey} as the prior-value record, then re-run repair.`,
    });
  }
  updates[preservedKey] = frontmatter[key];
}

/** Idempotently conform a scope README's mandatory frontmatter. Adds absent
 *  fields and replaces malformed ones only after preserving their values under
 *  repair-original-* keys. A valid id/stage/verified is never touched.
 *  `mintId` is called only when `id` is absent or malformed (it may persist a
 *  parent id per §1 lazy adoption). */
function conformReadmeFrontmatter(readmePath: string, mintId: () => string | null): FrontmatterConformResult {
  const fm = readFrontmatter(readmePath);
  const updates: Record<string, unknown> = {};

  let idAdded: string | null = null;
  const hasId = typeof fm.id === "string" && fm.id.trim().length > 0;
  if (!hasId) {
    preserveMalformedFrontmatterValue(fm, updates, "id");
    const minted = mintId();
    if (minted) { idAdded = minted; updates.id = minted; }
  }

  let stageAdded: string | null = null;
  const hasStage = typeof fm.stage === "string" && STAGE_VALUES.includes(fm.stage as Stage);
  if (!hasStage) {
    preserveMalformedFrontmatterValue(fm, updates, "stage");
    stageAdded = mapLegacyStatusToStage(fm.status);
    updates.stage = stageAdded;
  }

  let verifiedAdded: string | null = null;
  const hasVerified = typeof fm.verified === "string" && fm.verified.trim().length > 0;
  if (!hasVerified) {
    preserveMalformedFrontmatterValue(fm, updates, "verified");
    verifiedAdded = `${todayDateISO()} against backfill (rig scope repair)`;
    updates.verified = verifiedAdded;
  }

  const changed = Object.keys(updates).length > 0;
  if (changed) updateFrontmatter(readmePath, updates);
  return { idAdded, stageAdded, verifiedAdded, changed };
}

/** Mint a slice's id from its (persisted) parent mission id + NN — the §1
 *  lazy parent-ID adoption site. Null when the folder has no NN. */
function mintSliceIdClosure(slice: SliceInfo, missionsRoot: string): () => string | null {
  return () => {
    if (slice.nn == null) return null;
    const mission = findMission(missionsRoot, slice.missionName);
    const missionId = ensureMissionIdPersisted(mission, missionsRoot);
    return sliceIdFromMission(missionId, slice.nn);
  };
}

function conformLines(scope: string, r: FrontmatterConformResult): string[] {
  if (!r.changed) return [`  frontmatter: conformant (no change)`];
  const parts: string[] = [];
  if (r.idAdded) parts.push(`id=${r.idAdded}`);
  if (r.stageAdded) parts.push(`stage=${r.stageAdded}`);
  if (r.verifiedAdded) parts.push(`verified=${r.verifiedAdded}`);
  return [`  frontmatter conformed: ${parts.join(", ")}`];
}

function buildSliceRepairCommand(): Command {
  return new Command("repair")
    .description("Backfill a slice's missing PROGRESS.md + conform mandatory frontmatter (id/stage/verified); idempotent")
    .argument("<slice-path>", "Slice path (absolute, relative, or NN-slug)")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .option("--json", "Machine-readable output")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const legacySlice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const specPath = ensureCurrentSpec(legacySlice.absPath, legacySlice.readmePath, legacySlice.name);
        const slice = findSlice(missionsRoot, legacySlice.absPath, opts.mission ?? null);
        const result = backfillScopeProgress(slice.absPath, "slice");
        const frontmatter = specPath
          ? conformReadmeFrontmatter(specPath, mintSliceIdClosure(slice, missionsRoot))
          : { idAdded: null, stageAdded: null, verifiedAdded: null, changed: false };
        if (specPath) ensureConventionFrontmatter(specPath, slice.name);
        ensureSliceProofSurface(slice.absPath, readFrontmatter(specPath ?? "").id, slice.name);
        emit(out, { ok: true, result, frontmatter }, json, [
          `${result.created ? "Backfilled" : "Skipped"} ${slice.name}: ${result.reason}`,
          ...(result.path ? [`  path: ${result.path}`] : []),
          ...conformLines("slice", frontmatter),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionRepairCommand(): Command {
  return new Command("repair")
    .description("Backfill missing PROGRESS.md + conform mandatory frontmatter (id/stage/verified) for a mission and its slices; idempotent")
    .argument("<mission>", "Mission name")
    .option("--json", "Machine-readable output")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const legacyMission = findMission(missionsRoot, missionName);
        const missionSpec = ensureCurrentSpec(legacyMission.absPath, legacyMission.readmePath, legacyMission.name);
        const mission = findMission(missionsRoot, missionName);
        const results: BackfillResult[] = [];
        results.push(backfillScopeProgress(mission.absPath, "mission"));
        const slicesDir = path.join(mission.absPath, "slices");
        if (fs.existsSync(slicesDir)) {
          for (const entry of fs.readdirSync(slicesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory() || !/^\d+-/.test(entry.name)) continue;
            results.push(backfillScopeProgress(path.join(slicesDir, entry.name), "slice"));
          }
        }

        // FR-4: conform mandatory frontmatter — mission first (mints+persists
        // the mission id), then each slice (child ids derive from the now-
        // persisted parent id).
        const conformed: Array<{ scope: "mission" | "slice"; name: string; frontmatter: FrontmatterConformResult }> = [];
        if (missionSpec) {
          const fm = conformReadmeFrontmatter(missionSpec, () => ensureMissionId(mission, missionsRoot));
          ensureConventionFrontmatter(missionSpec, mission.name);
          conformed.push({ scope: "mission", name: mission.name, frontmatter: fm });
        }
        const freshMission = findMission(missionsRoot, mission.name);
        ensureMissionNotesSurface(freshMission.absPath, freshMission);
        for (const slice of listSlices(freshMission, "all")) {
          const specPath = ensureCurrentSpec(slice.absPath, slice.readmePath, slice.name);
          if (!specPath) continue;
          const fm = conformReadmeFrontmatter(specPath, mintSliceIdClosure(slice, missionsRoot));
          ensureConventionFrontmatter(specPath, slice.name);
          backfillScopeProgress(slice.absPath, "slice");
          ensureSliceProofSurface(slice.absPath, readFrontmatter(specPath).id, slice.name);
          conformed.push({ scope: "slice", name: slice.name, frontmatter: fm });
        }

        const created = results.filter((r) => r.created);
        const fmChanged = conformed.filter((c) => c.frontmatter.changed);
        emit(out, { ok: true, mission: mission.name, created, results, conformed }, json, [
          `Repaired ${mission.name}: ${created.length} PROGRESS.md backfilled, ${fmChanged.length} frontmatter conformed`,
          ...created.map((r) => `  + PROGRESS ${r.scope}/${r.name}`),
          ...fmChanged.map((c) => `  ~ frontmatter ${c.scope}/${c.name}`),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

/** Add the current authored node beside a legacy README without touching the
 * legacy file. Existing SPEC bytes stay in place. */
function ensureCurrentSpec(dir: string, nodePath: string | null, fallbackName: string): string | null {
  const specPath = path.join(dir, "SPEC.md");
  if (fs.existsSync(specPath)) return specPath;
  if (!nodePath || !fs.existsSync(nodePath)) return null;
  fs.copyFileSync(nodePath, specPath);
  ensureConventionFrontmatter(specPath, fallbackName);
  return specPath;
}

function ensureConventionFrontmatter(specPath: string, fallbackName: string): void {
  const content = fs.readFileSync(specPath, "utf8");
  const { frontmatter, body } = splitFrontmatter(content);
  const h2Intent = /^## Intent\s*\n+([\s\S]*?)(?=\n## |$)/m.exec(body)?.[1]?.trim();
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const updates: Record<string, unknown> = {};
  if (!(typeof frontmatter.intent === "string" && frontmatter.intent.trim().length > 0)) {
    preserveMalformedFrontmatterValue(frontmatter, updates, "intent");
    updates.intent = h2Intent && !/^\[.*\]$/.test(h2Intent)
      ? h2Intent
      : h1 ?? titleFromSlug(fallbackName.replace(/^\d+-/, ""));
  }
  if (!Array.isArray(frontmatter.depends_on)) {
    preserveMalformedFrontmatterValue(frontmatter, updates, "depends_on");
    updates.depends_on = [];
  }
  if (Object.keys(updates).length > 0) updateFrontmatter(specPath, updates);
}

function ensureMissionNotesSurface(dir: string, mission: ReturnType<typeof findMission>): void {
  const notesPath = path.join(dir, NOTES_FILE_PRECEDENCE[0]);
  const resolved = resolveNotesFile(dir);
  if (resolved?.name === NOTES_FILE_PRECEDENCE[0]) return;
  if (resolved) {
    fs.copyFileSync(resolved.path, notesPath);
    return;
  }
  const rendered = renderNotesTemplate({
    mission_id: mission.id ?? mission.name,
    mission_name: typeof mission.frontmatter.intent === "string" ? mission.frontmatter.intent : mission.name,
    created_date: todayDateISO(),
  });
  fs.writeFileSync(notesPath, rendered.rendered, "utf8");
}

function ensureSliceProofSurface(dir: string, rawId: unknown, fallbackName: string): void {
  fs.mkdirSync(path.join(dir, "proof"), { recursive: true });
  const proofPath = path.join(dir, "PROOF.md");
  if (fs.existsSync(proofPath)) return;
  fs.writeFileSync(proofPath, renderSliceProofTemplate({
    id: typeof rawId === "string" ? rawId : fallbackName,
    title: titleFromSlug(fallbackName.replace(/^\d+-/, "")),
  }), "utf8");
}

// ---------------------------------------------------------------------
// Approve (OPR.0.4.4.19 FR-9)
// ---------------------------------------------------------------------

// `rig scope slice|mission approve` — a THIN client of the daemon's ONE
// write path (POST /api/scope/approve): frontmatter stamp + append-only
// audit row land together daemon-side (no half-stamp by construction).
// STAGED: --scope spec ("the PRD matches my intent") | delivery (the
// terminal sign-off + future freeze trigger); omitted = delivery.
// DELEGATED: --on-behalf-of records whose decision this is in the audit
// notes; the actor stays the REAL invoking session (honest provenance).
// Two-regime rule (BR-6): approval is freeze/sign-off — NEVER proven-green.
function buildApproveCommand(tier: "slice" | "mission"): Command {
  return new Command("approve")
    .description(
      tier === "slice"
        ? "Approve a slice: writes the frontmatter stamp + an append-only audit row (daemon-side, one operation). --scope spec = the PLAN-LOCK (PRD-matches-intent; this artifact set gets built); delivery (default) = the PROOF-LOCK (terminal sign-off). Approval is freeze/sign-off, never proven-green. Conventions SSOT: docs/reference/sdlc-conventions.md (installed: $OPENRIG_HOME/reference/sdlc-conventions.md)."
        : "Approve a mission: same staged/delegated semantics as slice approve, at mission tier."
    )
    .argument(tier === "slice" ? "<slice-path>" : "<mission>", tier === "slice" ? "Slice path (absolute, relative, or NN-slug)" : "Mission name")
    .option("--mission <name>", tier === "slice" ? "Hint mission when slice-path is just NN-slug" : "(unused at mission tier)")
    .option("--scope <scope>", "Approval scope: spec | delivery (default delivery)")
    .option("--actor <session>", "(deprecated, ignored) approver is derived from the seat env (X-OpenRig-Session)")
    .option("--on-behalf-of <human>", "Record the delegation: whose decision this stamp records (actor stays the real invoking session)")
    .option("--re-approve", "OPR.0.5.0.18 amend/re-stamp: supersede an existing stamp with a new reasoned attestation (prior preserved in the append-only audit log). Requires --reason.")
    .option("--reason <why>", "Why the stamp is being amended (required with --re-approve; recorded on the audit row)")
    .option("--locked-artifacts <paths>", "PLAN-LOCK ONLY (--scope spec): comma-separated slice-relative paths naming the artifact set this lock freezes — replaces the derived default entirely. Each file must exist. Without it, a derivation that would freeze only a missing/scaffold PRD refuses.")
    .option("--json", "Machine-readable output")
    .action(async (target: string, opts: {
      mission?: string;
      scope?: string;
      actor?: string;
      onBehalfOf?: string;
      reApprove?: boolean;
      reason?: string;
      lockedArtifacts?: string;
      json?: boolean;
    }, command: Command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        if (opts.scope !== undefined && opts.scope !== "spec" && opts.scope !== "delivery") {
          throw new ScopeCliError({
            fact: `Unknown --scope value "${opts.scope}".`,
            consequence: "Command did not run.",
            action: "Pick one of: spec, delivery (omit for delivery).",
          });
        }
        // OPR.0.5.0.18 — fail the flag misuse fast and locally (the daemon
        // enforces the same contract; this just saves the round-trip).
        if (opts.reApprove && (!opts.reason || opts.reason.trim().length === 0)) {
          throw new ScopeCliError({
            fact: "--re-approve without --reason.",
            consequence: "A re-stamp is a reasoned deliberate act; nothing was written.",
            action: 'Re-run with --reason "<why>" describing what changed since the prior attestation.',
          });
        }
        if (opts.reason && !opts.reApprove) {
          throw new ScopeCliError({
            fact: "--reason was passed without --re-approve.",
            consequence: "A first-time approval carries no amendment reason; nothing was written.",
            action: "Drop --reason for a first approval, or add --re-approve to amend an existing stamp.",
          });
        }
        // B14 — the explicit set is a PLAN-LOCK concept; on a delivery approval it
        // would silently do nothing, and silence around lock content is the defect.
        const lockedArtifactsList = typeof opts.lockedArtifacts === "string"
          ? opts.lockedArtifacts.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
          : null;
        if (lockedArtifactsList && (tier !== "slice" || opts.scope !== "spec")) {
          throw new ScopeCliError({
            fact: "--locked-artifacts applies only to a slice plan-lock (--scope spec).",
            consequence: "Nothing was written.",
            action: "Re-run with --scope spec, or drop the flag for a delivery/mission approval.",
          });
        }
        // P21: the approver is DERIVED from the seat env (X-OpenRig-Session, stamped by DaemonClient
        // from OPENRIG_SESSION_NAME) — never a flag/body claim. --actor is deprecated + ignored. Fail
        // early with a friendly message if the env is unset (else the daemon returns 400 actor_required —
        // no seat identity to attribute the write to; P18 retired the 401 refusal).
        if (!process.env.OPENRIG_SESSION_NAME) {
          throw new ScopeCliError({
            fact: "No seat identity: OPENRIG_SESSION_NAME is unset (the approver is derived from the seat env, not a flag).",
            consequence: "The daemon has no seat identity to attribute the approval write to (400 actor_required — a missing parameter, not a distrust refusal).",
            action: "Run from a managed seat (OPENRIG_SESSION_NAME set).",
          });
        }
        // Resolve the scope target LOCALLY (rich NN-slug resolution), then
        // send the canonical missions-root-relative path to the daemon.
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        let scopeAbsPath: string;
        if (tier === "slice") {
          const slice = findSlice(missionsRoot, target, opts.mission ?? null);
          scopeAbsPath = slice.absPath;
        } else {
          const mission = findMission(missionsRoot, target);
          scopeAbsPath = mission.absPath;
        }
        const scopePath = path.relative(missionsRoot, scopeAbsPath).split(path.sep).join("/");

        const lifecycleDeps = realDeps();
        const status = await getDaemonStatus(lifecycleDeps);
        if (status.state !== "running" || status.healthy === false) {
          throw new ScopeCliError({
            fact: statusGuardMessage(status).fact, // B8-1b: down ≠ busy
            consequence: "scope approve writes the stamp + audit row through the daemon (one operation).",
            action: "Start it with: rig daemon start",
          });
        }
        const client = new DaemonClient(getDaemonUrl(status));
        const res = await client.post<Record<string, unknown>>("/api/scope/approve", {
          scopeTier: tier,
          scopePath,
          approvalScope: opts.scope,
          // P21: no body actorSession — the daemon derives the approver from the transport header.
          onBehalfOf: opts.onBehalfOf ?? null,
          reApprove: opts.reApprove === true,
          reason: opts.reason ?? null,
          lockedArtifacts: lockedArtifactsList,
        });
        if (res.status >= 400) {
          const err = res.data as { error?: string; message?: string; action?: string };
          throw new ScopeCliError({
            fact: `Approve failed (${err.error ?? res.status}): ${err.message ?? "unknown error"}.`,
            consequence: "No stamp and no audit row were left behind (no half-stamp).",
            action: err.error === "already_approved"
              ? 'The scope already carries this stamp; amend it with --re-approve --reason "<why>" (new attestation; prior preserved in the audit log).'
              : err.action ?? "Fix the named issue and re-run.",
          });
        }
        const data = res.data;
        emit(out, { ok: true, ...data }, json, [
          `${data.reApproved ? "Re-approved" : "Approved"} (${String(data.approvalScope)}) ${tier} ${String(data.scopeId)} — ${String(data.approvedBy)} at ${String(data.approvedAt)}${data.onBehalfOf ? ` on behalf of ${String(data.onBehalfOf)}` : ""}`,
          ...(data.reApproved
            ? [`Superseded prior attestation: ${String(data.priorApprovedBy)} at ${String(data.priorApprovedAt ?? "?")} (preserved in the audit log)`]
            : []),
          `Audit action: ${String(data.actionId)} (scope_path=${String(data.scopePath)})`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------

/**
 * Advisory-only: a work node carrying BOTH authored files.
 *
 * SPEC.md wins and nothing here blocks — but a shadowed README.md is a real hazard worth naming,
 * because every surface that still reads the legacy name is quietly reading the OTHER file. Low
 * severity on purpose: a state to notice, not a failure to gate on.
 */
function shadowedNodeFileFinding(dir: string, level: "mission" | "slice"): {
  kind: "shadowed_node_file"; severity: "low"; path: string; message: string; remediation: string;
} | null {
  if (!fs.existsSync(path.join(dir, "SPEC.md")) || !fs.existsSync(path.join(dir, "README.md"))) return null;
  return {
    kind: "shadowed_node_file",
    severity: "low",
    path: dir,
    message: `${level} has BOTH SPEC.md and README.md; SPEC.md is the authored node file and wins, so README.md is shadowed and any surface still reading the legacy name sees different content.`,
    remediation: "Fold anything still needed from README.md into SPEC.md and remove the shadowed file. Advisory only — nothing is blocked.",
  };
}

export function scopeCommand(): Command {
  const cmd = new Command("scope")
    .description("Scope tree primitive: missions, slices, sub-slices (per conventions/scope-and-versioning)")
    .option("--workspace <path>", "Override workspace root (otherwise inferred from cwd or $OPENRIG_WORK_ROOT)");

  const slice = new Command("slice").description("Slice-tier commands");
  slice.addCommand(buildSliceLsCommand());
  slice.addCommand(buildSliceShowCommand());
  slice.addCommand(buildSliceCreateCommand());
  slice.addCommand(buildSliceShipCommand());
  slice.addCommand(buildSliceCloseCommand());
  slice.addCommand(buildSliceMoveCommand());
  slice.addCommand(buildSliceProgressCommand());
  slice.addCommand(buildSliceRepairCommand());
  slice.addCommand(buildSliceStageCommand());
  slice.addCommand(buildSliceVerifiedCommand());
  slice.addCommand(buildApproveCommand("slice"));
  cmd.addCommand(slice);

  const mission = new Command("mission").description("Mission-tier commands");
  mission.addCommand(buildMissionLsCommand());
  mission.addCommand(buildMissionShowCommand());
  mission.addCommand(buildMissionCreateCommand());
  mission.addCommand(buildMissionGraphCommand());
  mission.addCommand(buildMissionProgressCommand());
  mission.addCommand(buildMissionRepairCommand());
  mission.addCommand(buildMissionStageCommand());
  mission.addCommand(buildMissionVerifiedCommand());
  mission.addCommand(buildApproveCommand("mission"));
  cmd.addCommand(mission);
  cmd.addCommand(buildAuditCommand());

  return cmd;
}

// Re-exports for tests.
export { DEFAULT_PROJECT_PREFIX, splitFrontmatter };
