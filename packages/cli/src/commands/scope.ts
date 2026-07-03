// release-0.3.2 slice 12 — `rig scope` CLI primitive.
//
// Command grammar: rig scope <tier> <verb>. v0 ships `mission` +
// `slice` tiers; `project` and `sub-slice` are reserved per the
// substrate convention `conventions/scope-and-versioning/README.md`
// (stage: provisional). The CLI mints stable dot-IDs into created
// mission/slice frontmatter per §1 of that convention.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import {
  CLOSE_REASONS,
  MISSION_TEMPLATE_KINDS,
  SLICE_TEMPLATE_KINDS,
  STAGE_VALUES,
  ScopeCliError,
  type CloseReason,
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
  nextEscapeBandOrdinal,
  sliceIdFromMission,
} from "../lib/scope/dot-id.js";
import {
  ensureMissionId,
  ensureMissionIdPersisted,
  findMission,
  findSlice,
  gitTopLevel,
  listMissions,
  listSlices,
  moveSlice,
  nextSliceNN,
  pad2,
  readFrontmatter,
  resolveMissionsRoot,
  splitFrontmatter,
  todayDateISO,
  updateFrontmatter,
} from "../lib/scope/scope-fs.js";
import {
  renderMissionBriefTemplate,
  renderMissionNotesTemplate,
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
    .description("Create a new slice in a mission")
    .argument("<mission>", "Mission name")
    .argument("<slug>", "Short slug (becomes the folder name's suffix)")
    .option("--template <kind>", `Template: ${SLICE_TEMPLATE_KINDS.join(" | ")}`, "placeholder")
    .option("--title <text>", "Display title (defaults to titlecased slug)")
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
        const createdDate = todayDateISO();
        const body = renderSliceTemplate(kind, {
          id,
          slice_number: pad2(nn),
          slug,
          mission: mission.name,
          title,
          created_date: createdDate,
        });
        const proofBody = renderSliceProofTemplate({ id, title });
        fs.mkdirSync(sliceAbs, { recursive: true });
        fs.mkdirSync(path.join(sliceAbs, "proof"), { recursive: true });
        const readmePath = path.join(sliceAbs, "README.md");
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
        const newReadme = path.join(destAbs, "README.md");
        if (fs.existsSync(newReadme)) {
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
        const newReadme = path.join(destAbs, "README.md");
        if (fs.existsSync(newReadme)) {
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
        const newReadme = path.join(destAbs, "README.md");
        if (fs.existsSync(newReadme)) {
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
    .description("List missions (top-level folders with README.md)")
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

function buildMissionCreateCommand(): Command {
  return new Command("create")
    .description("Create a new mission (mints a stable dot-ID into frontmatter)")
    .argument("<name>", "Mission folder name (e.g., release-0.4.0, backlog-foo)")
    .option("--template <kind>", `Template: ${MISSION_TEMPLATE_KINDS.join(" | ")} (auto when name matches release-X.Y.Z)`, "")
    .option("--id <dot-id>", "Explicit dot-ID. Overrides name-pattern inference.")
    .option("--title <text>", "Display title (defaults to titlecased name)")
    .option("--no-mission-notes", "Skip the auto-scaffold of MISSION_NOTES.md (rare; default is to scaffold from conventions/mission-notes/TEMPLATE.md)")
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
        // Resolve titles + render templates BEFORE any filesystem side
        // effects (banked verify-first-then-write — guard catch on
        // OPR.0.3.2.21.FR-3 qitem-20260601121058: a stale
        // OPENRIG_MISSION_NOTES_TEMPLATE_PATH used to throw AFTER
        // mkdirSync + README write, leaking a half-created mission dir
        // that future `mission create <same-name>` would reject as
        // already-existing). Rendering MISSION_NOTES first means a
        // stale env-var fails before any disk mutation.
        const title = opts.title ?? titleFromSlug(name.replace(/^release-/, ""));
        const releaseVersion = isReleaseName ? name.replace(/^release-/, "") : "";
        const readmeBody = renderMissionTemplate(templateKind, {
          id,
          slug: name,
          mission: name,
          title,
          created_date: todayDateISO(),
          release_version: releaseVersion,
        });
        let missionNotesRendered: { rendered: string; resolvedFrom: "env" | "built-in" } | null = null;
        if (opts.missionNotes !== false) {
          const r = renderMissionNotesTemplate({
            mission_id: id,
            mission_name: title,
            created_date: todayDateISO(),
          });
          missionNotesRendered = { rendered: r.rendered, resolvedFrom: r.resolvedFrom };
        }
        const progressBody = renderMissionProgressTemplate(title);
        const missionBriefBody = renderMissionBriefTemplate(title);
        // All renders succeeded — safe to touch the filesystem.
        fs.mkdirSync(absPath, { recursive: true });
        fs.mkdirSync(path.join(absPath, "slices"), { recursive: true });
        const readmePath = path.join(absPath, "README.md");
        fs.writeFileSync(readmePath, readmeBody, "utf8");
        const progressPath = path.join(absPath, "PROGRESS.md");
        fs.writeFileSync(progressPath, progressBody, "utf8");
        const missionBriefPath = path.join(absPath, "MISSION_BRIEF.md");
        fs.writeFileSync(missionBriefPath, missionBriefBody, "utf8");
        let missionNotesPath: string | null = null;
        let missionNotesResolvedFrom: "env" | "built-in" | null = null;
        if (missionNotesRendered) {
          missionNotesPath = path.join(absPath, "MISSION_NOTES.md");
          fs.writeFileSync(missionNotesPath, missionNotesRendered.rendered, "utf8");
          missionNotesResolvedFrom = missionNotesRendered.resolvedFrom;
        }
        const humanLines = [
          `Created mission ${name}`,
          `  id: ${id}`,
          `  template: ${templateKind}`,
          `  path: ${absPath}`,
        ];
        if (missionNotesPath) {
          humanLines.push(`  mission-notes: ${missionNotesPath} (template: ${missionNotesResolvedFrom})`);
        }
        emit(out, {
          ok: true,
          mission: {
            name,
            id,
            template: templateKind,
            path: absPath,
            readmePath,
            missionBriefPath,
            missionNotesPath,
            missionNotesResolvedFrom,
          },
        }, json, humanLines);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// Audit (B2 — read-only scope audit)
// ---------------------------------------------------------------------

/**
 * Files changed by the most recent commit (revision basis: HEAD), returned as
 * ABSOLUTE resolved paths. Returns null when there is NO git context — the dir
 * is not inside a repo, HEAD does not resolve (e.g. a fresh repo with no
 * commits), or the git command fails. Callers then leave the
 * committed-without-PROGRESS classifier inputs UNDEFINED, so the check stays
 * inert: no false-green (we never assume "PROGRESS untouched" without evidence)
 * and no false-positive (we never fire when we cannot see the commit).
 */
function gitHeadTouchedAbsPaths(dir: string): Set<string> | null {
  const topLevel = gitTopLevel(dir);
  if (!topLevel) return null;
  try {
    const out = execFileSync(
      "git",
      ["-C", topLevel, "show", "--name-only", "--pretty=format:", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const abs = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((rel) => path.resolve(topLevel, rel));
    return new Set(abs);
  } catch {
    return null;
  }
}

function buildAuditCommand(): Command {
  return new Command("audit")
    .description("Read-only scope audit: flag missing/malformed progress rails and registration ghosts")
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

        const missionReadme = path.join(missionDir, "README.md");
        const missionProgress = path.join(missionDir, "PROGRESS.md");
        const missionBrief = path.join(missionDir, "MISSION_BRIEF.md");
        const missionNotes = path.join(missionDir, "MISSION_NOTES.md");
        const missionReadmeExists = fs.existsSync(missionReadme);
        const missionProgressExists = fs.existsSync(missionProgress);
        const missionBriefExists = fs.existsSync(missionBrief);

        let missionResult: ReturnType<typeof classifyScopeItem>;
        if (!missionReadmeExists && missionProgressExists) {
          missionResult = {
            railStatus: "malformed",
            findings: [{
              kind: "orphan_progress",
              severity: "high",
              path: missionDir,
              message: `PROGRESS.md exists but no README.md (orphan progress rail, no backing scope item)`,
              remediation: `Add a README.md with frontmatter id, or remove the orphan PROGRESS.md`,
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
            missionBriefExists,
            missionBriefPath: missionBrief,
            missionBriefContent: missionBriefExists ? fs.readFileSync(missionBrief, "utf-8") : null,
            missionNotesExists: fs.existsSync(missionNotes),
            missionNotesPath: missionNotes,
          });
        }

        const slicesDir = path.join(missionDir, "slices");
        const dogfoodEvidenceRoot = defaultDogfoodEvidenceRoot(missionsRoot);
        // Git-derived input for the committed-without-PROGRESS check (CLI-only).
        // Revision basis = the most recent commit (HEAD). null when git context
        // is unavailable → the check is left inert per-slice below.
        const headTouched = gitHeadTouchedAbsPaths(missionDir);
        const sliceResults: Array<{ name: string; result: ReturnType<typeof classifyScopeItem> }> = [];

        if (fs.existsSync(slicesDir)) {
          for (const entry of fs.readdirSync(slicesDir)) {
            const sliceDir = path.join(slicesDir, entry);
            if (!fs.statSync(sliceDir).isDirectory()) continue;
            const sliceReadme = path.join(sliceDir, "README.md");
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
                      message: `PROGRESS.md exists but no README.md (orphan progress rail, no backing scope item)`,
                      remediation: `Add a README.md with frontmatter id, or remove the orphan PROGRESS.md`,
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

            const sliceFm = extractFrontmatterRaw(fs.readFileSync(sliceReadme, "utf-8"));
            const readmeOnlyMarker = sliceFm !== null && /^progress_rail\s*:\s*readme-only/m.test(sliceFm);

            // committed-without-PROGRESS inputs (CLI-only; inert when git is
            // unavailable — leave both undefined so the check does not fire).
            // Normalize to realpath so a symlinked workspace (e.g. macOS
            // /var → /private/var) still matches git's realpath'd output.
            let sliceTouchedByRecentCommit: boolean | undefined;
            let progressTouchedByRecentCommit: boolean | undefined;
            if (headTouched) {
              let realSliceDir = sliceDir;
              try { realSliceDir = fs.realpathSync(sliceDir); } catch { /* keep sliceDir */ }
              const slicePrefix = realSliceDir.endsWith(path.sep) ? realSliceDir : realSliceDir + path.sep;
              const realSliceProgress = path.join(realSliceDir, "PROGRESS.md");
              sliceTouchedByRecentCommit = [...headTouched].some(
                (p) => p === realSliceDir || p.startsWith(slicePrefix),
              );
              progressTouchedByRecentCommit = headTouched.has(realSliceProgress);
            }

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
              sliceTouchedByRecentCommit,
              progressTouchedByRecentCommit,
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

            sliceResults.push({ name: entry, result: sliceResult });
          }
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
            slices: sliceResults.map((s) => ({ name: s.name, railStatus: s.result.railStatus, frontmatterError: s.result.frontmatterError, findings: s.result.findings })),
            totalFindings: allFindings.length,
          }, null, 2));
          out.write("\n");
          if (hardFindings.length > 0) process.exitCode = 1;
          return;
        }

        out.write(`Scope audit: ${missionName}\n`);
        out.write(`Mission rail: ${missionResult.railStatus}\n`);
        out.write(`Slices: ${sliceResults.length} total\n\n`);

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
  const readmePath = path.join(scopeDir, "README.md");
  if (fs.existsSync(readmePath)) {
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
  const readmePath = path.join(scopeDir, "README.md");
  if (!fs.existsSync(readmePath)) {
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
            fact: `Slice ${slice.name} has no README.md.`,
            consequence: "Stage is a frontmatter field on the README; nothing to write.",
            action: "Create the slice README (rig scope slice create) before setting its stage.",
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
            fact: `Mission ${mission.name} has no README.md.`,
            consequence: "Stage is a frontmatter field on the README; nothing to write.",
            action: "Create the mission README before setting its stage.",
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
            fact: `Slice ${slice.name} has no README.md.`,
            consequence: "verified is a frontmatter field on the README; nothing to write.",
            action: "Create the slice README before stamping verified.",
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
            fact: `Mission ${mission.name} has no README.md.`,
            consequence: "verified is a frontmatter field on the README; nothing to write.",
            action: "Create the mission README before stamping verified.",
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

/** Idempotently conform a scope README's mandatory frontmatter. Only ADDS
 *  absent fields — never clobbers an existing id/stage/verified. `mintId` is
 *  called only when `id` is absent (it may persist a parent id per §1 lazy
 *  adoption). */
function conformReadmeFrontmatter(readmePath: string, mintId: () => string | null): FrontmatterConformResult {
  const fm = readFrontmatter(readmePath);
  const updates: Record<string, unknown> = {};

  let idAdded: string | null = null;
  const hasId = typeof fm.id === "string" && fm.id.length > 0;
  if (!hasId) {
    const minted = mintId();
    if (minted) { idAdded = minted; updates.id = minted; }
  }

  let stageAdded: string | null = null;
  if (!fm.stage) {
    stageAdded = mapLegacyStatusToStage(fm.status);
    updates.stage = stageAdded;
  }

  let verifiedAdded: string | null = null;
  if (!fm.verified) {
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
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const result = backfillScopeProgress(slice.absPath, "slice");
        const frontmatter = slice.readmePath
          ? conformReadmeFrontmatter(slice.readmePath, mintSliceIdClosure(slice, missionsRoot))
          : { idAdded: null, stageAdded: null, verifiedAdded: null, changed: false };
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
        if (mission.readmePath) {
          const fm = conformReadmeFrontmatter(mission.readmePath, () => ensureMissionId(mission, missionsRoot));
          conformed.push({ scope: "mission", name: mission.name, frontmatter: fm });
        }
        const freshMission = findMission(missionsRoot, mission.name);
        for (const slice of listSlices(freshMission, "all")) {
          if (!slice.readmePath) continue;
          const fm = conformReadmeFrontmatter(slice.readmePath, mintSliceIdClosure(slice, missionsRoot));
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

// ---------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------

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
  cmd.addCommand(slice);

  const mission = new Command("mission").description("Mission-tier commands");
  mission.addCommand(buildMissionLsCommand());
  mission.addCommand(buildMissionShowCommand());
  mission.addCommand(buildMissionCreateCommand());
  mission.addCommand(buildMissionProgressCommand());
  mission.addCommand(buildMissionRepairCommand());
  mission.addCommand(buildMissionStageCommand());
  mission.addCommand(buildMissionVerifiedCommand());
  cmd.addCommand(mission);
  cmd.addCommand(buildAuditCommand());

  return cmd;
}

// Re-exports for tests.
export { DEFAULT_PROJECT_PREFIX, splitFrontmatter };
