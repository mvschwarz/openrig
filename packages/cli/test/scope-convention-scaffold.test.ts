// OPR.0.4.4.23 — the scaffold emits the SDLC convention sections for EVERY
// SliceTemplateKind (the Rev-2 exhaustive contract): a slice that doesn't
// carry `## Intent` / `## Mini-requirements` / `## Proof contract` doesn't
// project in the Living Notes UI, whatever its template kind. The tests
// ENUMERATE the exported kind set, so a future kind added to
// SLICE_TEMPLATE_KINDS fails here until its template carries the sections.
// Conventions SSOT: docs/reference/sdlc-conventions.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";
import { renderImplementationPrdTemplate, renderSliceProofTemplate, renderSliceTemplate } from "../src/lib/scope/templates.js";
import { MISSION_TEMPLATE_KINDS, SLICE_TEMPLATE_KINDS } from "../src/lib/scope/types.js";
import { renderMissionTemplate } from "../src/lib/scope/templates.js";

const CONVENTION_SECTIONS = ["## Intent", "## Mini-requirements", "## Proof contract"] as const;
const SSOT_POINTER = "docs/reference/sdlc-conventions.md";

// aa922842 — the dual-context pointer contract.
//
// Scaffolded output lands in a USER's workspace, so it is installed-facing: the reader may
// have no repo at all. The same doc reaches them by three different paths and only two may
// ever be taught:
//   repo source      docs/reference/sdlc-conventions.md          — correct for repo readers
//   installed stable $OPENRIG_HOME/reference/sdlc-conventions.md — correct for installed agents
//                                                                  (default ~/.openrig/…)
//   packed internal  daemon/docs/reference/…                     — assembly input, NEVER taught
//
// Two failure modes this guards, both of which look fine in a repo checkout:
//   1. teaching ONLY the repo path — an installed agent looks somewhere that does not exist;
//   2. teaching the DEFAULT home as the only path — wrong for any operator with a custom
//      OPENRIG_HOME (this rig runs one). Naming `$OPENRIG_HOME/...` is MANDATORY; mentioning
//      `~/.openrig/...` alongside it as the default is honest and explicitly allowed, so this
//      does NOT ban the default — requiring the env-aware pointer already covers the risk.
const INSTALLED_POINTER_ENV = "$OPENRIG_HOME/reference/sdlc-conventions.md";
const INTERNAL_PACKED_PATH = "daemon/docs/reference/";

const RENDER_OPTS = {
  id: "OPR.0.4.4.99",
  slice_number: "99",
  slug: "conventions-probe",
  mission: "release-0.4.4",
  title: "Conventions Probe",
  created_date: "2026-07-06",
};

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-conventions-"));
}

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  fs.mkdirSync(path.join(missionsRoot, "release-0.4.4"), { recursive: true });
  fs.writeFileSync(
    path.join(missionsRoot, "release-0.4.4", "README.md"),
    "---\nid: OPR.0.4.4\nstage: wip\n---\n# release-0.4.4\n",
    "utf8",
  );
  return { root, missionsRoot };
}

async function run(args: string[], missionsRoot: string): Promise<{ exitCode: number; stdout: string }> {
  const stdoutBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", path.dirname(missionsRoot)]);
  } catch {
    // Commander/process.exit paths are captured above.
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join("") };
}

describe("OPR.0.4.4.23 convention scaffold — exhaustive over SliceTemplateKind", () => {
  it("every SliceTemplateKind template emits the three convention sections + the SSOT pointer", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      for (const section of CONVENTION_SECTIONS) {
        expect(rendered, `template kind "${kind}" is missing "${section}"`).toContain(section);
      }
      expect(rendered, `template kind "${kind}" is missing the SSOT pointer`).toContain(SSOT_POINTER);
      expect(rendered, `template kind "${kind}" is missing the mission-slice-sop skill pointer`).toContain("mission-slice-sop");
    }
  });

  // aa922842 — dual-context pointer discriminator. Scaffolded output is installed-facing.
  it("every slice template teaches BOTH contexts: the repo path AND the OPENRIG_HOME-aware installed path", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      // Repo context retained — a repo reader must not be sent to an installed-only path.
      expect(rendered, `template kind "${kind}" dropped the repo-source pointer`).toContain(SSOT_POINTER);
      // Installed context added — without this an agent on an installed package is told to
      // read a path that does not exist on their machine.
      expect(
        rendered,
        `template kind "${kind}" never names the installed stable path; an installed agent cannot find the conventions doc from this scaffold`,
      ).toContain(INSTALLED_POINTER_ENV);
    }
  });

  it("no template leaks the internal packed path as if it were a user path", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      expect(
        rendered.includes(INTERNAL_PACKED_PATH),
        `template kind "${kind}" teaches the internal assembly path ${INTERNAL_PACKED_PATH} as if it were a user path`,
      ).toBe(false);
    }
  });

  it("the convention sections come FIRST — kind-specific body sits below them", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      const firstSectionIdx = rendered.indexOf("## ");
      expect(
        rendered.slice(firstSectionIdx).startsWith("## Intent"),
        `template kind "${kind}" does not open its sections with ## Intent`,
      ).toBe(true);
      const miniIdx = rendered.indexOf("## Mini-requirements");
      const proofIdx = rendered.indexOf("## Proof contract");
      expect(firstSectionIdx, `kind "${kind}" section order broken`).toBeLessThan(miniIdx);
      expect(miniIdx, `kind "${kind}" section order broken`).toBeLessThan(proofIdx);
    }
  });

  it("the IMPLEMENTATION-PRD skeleton carries the sections + the elastic-middle note", () => {
    const rendered = renderImplementationPrdTemplate(RENDER_OPTS);
    for (const section of CONVENTION_SECTIONS) {
      expect(rendered).toContain(section);
    }
    expect(rendered).toContain("ELASTIC MIDDLE");
    expect(rendered).toContain("may BE the whole PRD");
    expect(rendered).toContain(SSOT_POINTER);
  });

  it("mission templates carry the convention pointer + SOP reference (missions are not slice projections)", () => {
    for (const kind of MISSION_TEMPLATE_KINDS) {
      const rendered = renderMissionTemplate(kind, RENDER_OPTS);
      expect(rendered, `mission template "${kind}" is missing the SSOT pointer`).toContain(SSOT_POINTER);
      expect(rendered, `mission template "${kind}" is missing the mission-slice-sop pointer`).toContain("mission-slice-sop");
    }
  });
});

describe("OPR.0.4.4.23 slice create — every kind lands the full convention artifact set on disk", () => {
  let substrate: { root: string; missionsRoot: string };

  beforeEach(() => { substrate = seedSubstrate(); });
  afterEach(() => { fs.rmSync(substrate.root, { recursive: true, force: true }); });

  it("scaffolds README sections + IMPLEMENTATION-PRD.md + proof/ + PROOF.md for each SliceTemplateKind", async () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const r = await run(
        ["slice", "create", "release-0.4.4", `probe-${kind}`, "--template", kind, "--json"],
        substrate.missionsRoot,
      );
      expect(r.exitCode, `slice create failed for kind "${kind}"`).toBe(0);
      const slicePath = JSON.parse(r.stdout).slice.path as string;

      const readme = fs.readFileSync(path.join(slicePath, "SPEC.md"), "utf8");
      for (const section of CONVENTION_SECTIONS) {
        expect(readme, `created README for kind "${kind}" is missing "${section}"`).toContain(section);
      }

      const prdPath = path.join(slicePath, "IMPLEMENTATION-PRD.md");
      expect(fs.existsSync(prdPath), `kind "${kind}" did not scaffold IMPLEMENTATION-PRD.md`).toBe(true);
      const prd = fs.readFileSync(prdPath, "utf8");
      for (const section of CONVENTION_SECTIONS) {
        expect(prd, `created PRD for kind "${kind}" is missing "${section}"`).toContain(section);
      }
      expect(prd, `created PRD for kind "${kind}" is missing the elastic-middle note`).toContain("ELASTIC MIDDLE");

      expect(fs.statSync(path.join(slicePath, "proof")).isDirectory(), `kind "${kind}" did not scaffold proof/`).toBe(true);
      expect(fs.existsSync(path.join(slicePath, "PROOF.md")), `kind "${kind}" did not scaffold PROOF.md`).toBe(true);
    }
  });
});

// OPR.0.4.4.23 PM-acceptance fixback — the shipped teaching surfaces must
// LEAD a naive agent to the C1 drop verb: every scaffolded artifact that
// mentions proving names `rig proof add` and `--media` explicitly (the
// naive-agent rerun showed generic "rig proof drops" prose produced manual
// proof-dir curation and no C1 drops).
describe("OPR.0.4.4.23 teaching surfaces name the drop verb", () => {
  it("every slice template's proving guidance names rig proof add and --media", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      expect(rendered, `template kind "${kind}" does not name rig proof add`).toContain("rig proof add");
      expect(rendered, `template kind "${kind}" does not name --media`).toContain("--media");
    }
  });

  it("the IMPLEMENTATION-PRD skeleton and the PROOF.md template name rig proof add and --media", () => {
    const prd = renderImplementationPrdTemplate(RENDER_OPTS);
    expect(prd).toContain("rig proof add");
    expect(prd).toContain("--media");
    const proof = renderSliceProofTemplate({ id: RENDER_OPTS.id, title: RENDER_OPTS.title });
    expect(proof).toContain("rig proof add");
    expect(proof).toContain("--media");
    expect(proof).toContain("Hand-placing files without a drop");
  });
});
