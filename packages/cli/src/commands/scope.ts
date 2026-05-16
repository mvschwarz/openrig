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
  resolveMissionsRoot,
  splitFrontmatter,
  todayDateISO,
  updateFrontmatter,
} from "../lib/scope/scope-fs.js";
import {
  renderMissionTemplate,
  renderSliceTemplate,
  titleFromSlug,
} from "../lib/scope/templates.js";

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
        fs.writeFileSync(readmePath, body, "utf8");
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
        // Scaffold the mission directory + README.
        fs.mkdirSync(absPath, { recursive: true });
        fs.mkdirSync(path.join(absPath, "slices"), { recursive: true });
        const title = opts.title ?? titleFromSlug(name.replace(/^release-/, ""));
        const releaseVersion = isReleaseName ? name.replace(/^release-/, "") : "";
        const body = renderMissionTemplate(templateKind, {
          id,
          slug: name,
          mission: name,
          title,
          created_date: todayDateISO(),
          release_version: releaseVersion,
        });
        const readmePath = path.join(absPath, "README.md");
        fs.writeFileSync(readmePath, body, "utf8");
        emit(out, {
          ok: true,
          mission: {
            name,
            id,
            template: templateKind,
            path: absPath,
            readmePath,
          },
        }, json, [
          `Created mission ${name}`,
          `  id: ${id}`,
          `  template: ${templateKind}`,
          `  path: ${absPath}`,
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
  cmd.addCommand(slice);

  const mission = new Command("mission").description("Mission-tier commands");
  mission.addCommand(buildMissionLsCommand());
  mission.addCommand(buildMissionShowCommand());
  mission.addCommand(buildMissionCreateCommand());
  cmd.addCommand(mission);

  return cmd;
}

// Re-exports for tests.
export { DEFAULT_PROJECT_PREFIX, splitFrontmatter };
