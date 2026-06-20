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

import {
  CLOSE_REASONS,
  MISSION_TEMPLATE_KINDS,
  SLICE_TEMPLATE_KINDS,
  ScopeCliError,
  type CloseReason,
  type MissionTemplateKind,
  type SliceTemplateKind,
  type SliceState,
} from "../lib/scope/types.js";
import {
  DEFAULT_PROJECT_PREFIX,
  inferMissionDotId,
  isMissionDotId,
  nextEscapeBandOrdinal,
  sliceIdFromMission,
} from "../lib/scope/dot-id.js";
import {
  ensureMissionIdPersisted,
  findMission,
  findSlice,
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
  renderMissionNotesTemplate,
  renderMissionProgressTemplate,
  renderMissionTemplate,
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
        const payload = {
          ok: true,
          slice: {
            mission: slice.missionName,
            name: slice.name,
            id: slice.id,
            status: slice.status,
            path: slice.absPath,
            frontmatter: slice.frontmatter,
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
        const body = renderSliceTemplate(kind, {
          id,
          slice_number: pad2(nn),
          slug,
          mission: mission.name,
          title,
          created_date: todayDateISO(),
        });
        fs.mkdirSync(sliceAbs, { recursive: true });
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
        const payload = {
          ok: true,
          mission: {
            name: mission.name,
            id: mission.id,
            path: mission.absPath,
            activeSliceCount: mission.activeSliceCount,
            closedSliceCount: mission.closedSliceCount,
            frontmatter: mission.frontmatter,
            readme,
            slices,
          },
        };
        if (json) {
          out.write(JSON.stringify(payload, null, 2) + "\n");
        } else {
          out.write(`Mission: ${mission.name}\n`);
          out.write(`  id: ${mission.id ?? "—"}\n`);
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
        // All renders succeeded — safe to touch the filesystem.
        fs.mkdirSync(absPath, { recursive: true });
        fs.mkdirSync(path.join(absPath, "slices"), { recursive: true });
        const readmePath = path.join(absPath, "README.md");
        fs.writeFileSync(readmePath, readmeBody, "utf8");
        const progressPath = path.join(absPath, "PROGRESS.md");
        fs.writeFileSync(progressPath, progressBody, "utf8");
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
        const missionReadmeExists = fs.existsSync(missionReadme);
        const missionProgressExists = fs.existsSync(missionProgress);

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
          });
        }

        const slicesDir = path.join(missionDir, "slices");
        const sliceResults: Array<{ name: string; result: ReturnType<typeof classifyScopeItem> }> = [];

        if (fs.existsSync(slicesDir)) {
          for (const entry of fs.readdirSync(slicesDir)) {
            const sliceDir = path.join(slicesDir, entry);
            if (!fs.statSync(sliceDir).isDirectory()) continue;
            const sliceReadme = path.join(sliceDir, "README.md");
            const sliceProgress = path.join(sliceDir, "PROGRESS.md");

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

            const sliceResult = classifyScopeItem({
              id: null,
              path: sliceDir,
              readmeFrontmatterRaw: sliceFm,
              progressFileExists: fs.existsSync(sliceProgress),
              readmeOnlyMarker,
              isActiveRelease: true,
              level: "slice",
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

        if (json) {
          out.write(JSON.stringify({
            ok: allFindings.length === 0,
            mission: { name: missionName, railStatus: missionResult.railStatus, frontmatterError: missionResult.frontmatterError, findings: missionResult.findings },
            slices: sliceResults.map((s) => ({ name: s.name, railStatus: s.result.railStatus, frontmatterError: s.result.frontmatterError, findings: s.result.findings })),
            totalFindings: allFindings.length,
          }, null, 2));
          out.write("\n");
          if (allFindings.length > 0) process.exitCode = 1;
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
          out.write(`\nFAIL: ${allFindings.length} finding(s)\n`);
          process.exitCode = 1;
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

function buildSliceRepairCommand(): Command {
  return new Command("repair")
    .description("Backfill a missing PROGRESS.md for a slice (idempotent; skips readme-only and existing rails)")
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
        emit(out, { ok: true, result }, json, [
          `${result.created ? "Backfilled" : "Skipped"} ${slice.name}: ${result.reason}`,
          ...(result.path ? [`  path: ${result.path}`] : []),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionRepairCommand(): Command {
  return new Command("repair")
    .description("Backfill missing PROGRESS.md for a mission and its slices (idempotent; skips readme-only)")
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
        const created = results.filter((r) => r.created);
        emit(out, { ok: true, mission: mission.name, created, results }, json, [
          `Repaired ${mission.name}: ${created.length} PROGRESS.md backfilled`,
          ...created.map((r) => `  + ${r.scope}/${r.name}`),
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
  cmd.addCommand(slice);

  const mission = new Command("mission").description("Mission-tier commands");
  mission.addCommand(buildMissionLsCommand());
  mission.addCommand(buildMissionShowCommand());
  mission.addCommand(buildMissionCreateCommand());
  mission.addCommand(buildMissionProgressCommand());
  mission.addCommand(buildMissionRepairCommand());
  cmd.addCommand(mission);
  cmd.addCommand(buildAuditCommand());

  return cmd;
}

// Re-exports for tests.
export { DEFAULT_PROJECT_PREFIX, splitFrontmatter };
