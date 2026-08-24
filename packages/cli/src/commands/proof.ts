import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { findSlice, resolveMissionsRoot } from "../lib/scope/scope-fs.js";
import { ScopeCliError } from "../lib/scope/types.js";

/**
 * `rig proof` — the proof-drop write path (OPR.0.4.4.19 FR-8 + FR-11;
 * conventions C1 + C2 + C8, D2 attestation).
 *
 * CLI-side filesystem only (plan-review + arch-lead confirmed): the drop
 * validates the C1 header AT THE MOMENT THE EVIDENCE IS IN-HAND, writes the
 * artifact into the slice's proof/ dir, and echoes the parsed header (the
 * seat sees what the composer will see). No daemon involvement, no synthetic
 * qitems, no DB writes.
 *
 * LOAD-BEARING boundaries:
 *   - Validation applies ONLY to drops made through this path. An artifact
 *     written by any other means (raw file write, existing workflows) is
 *     NEVER blocked at write time — the backstop is `rig scope audit`
 *     (FR-10), not a write-path gate on ordinary file I/O.
 *   - The D2 proof contract + self_check are AGENT JUDGMENT recorded here;
 *     the drop path ADVISES (exit 0) and never blocks on them. There is no
 *     configuration that makes any advisory blocking (BR-7).
 */

/** C1 ratified closed sets (BR-4 — extending them is a convention change
 *  owned by pm-lead, not a code decision). */
export const C1_ARTIFACT_TYPES = ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const;
export const C1_VERDICTS = ["CLEAR", "BLOCKING", "CONCERNING", "PASS", "NOT-CLEAR"] as const;

/** Video extensions for the C8 UX advisory (screencast evidence). */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);

export interface C1Header {
  slice: string;
  candidate_sha: string;
  artifact_type: string;
  verdict: string;
  money_evidence: string;
  /** D2 optional attestation fields — advise-never-block. */
  evidences?: string[];
  self_check?: string;
}

export interface C1ValidationResult {
  ok: boolean;
  missing: string[];
  invalid: Array<{ field: string; value: string; allowed: readonly string[] }>;
}

/** Validate the five required C1 fields + closed sets. Pure. */
export function validateC1Header(header: Partial<C1Header>): C1ValidationResult {
  const missing: string[] = [];
  for (const field of ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"] as const) {
    const value = header[field];
    if (typeof value !== "string" || value.trim().length === 0) missing.push(field);
  }
  const invalid: C1ValidationResult["invalid"] = [];
  if (header.artifact_type && !(C1_ARTIFACT_TYPES as readonly string[]).includes(header.artifact_type)) {
    invalid.push({ field: "artifact_type", value: header.artifact_type, allowed: C1_ARTIFACT_TYPES });
  }
  if (header.verdict && !(C1_VERDICTS as readonly string[]).includes(header.verdict)) {
    invalid.push({ field: "verdict", value: header.verdict, allowed: C1_VERDICTS });
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

/**
 * Parse the pinned `## Proof contract` section out of a slice's
 * IMPLEMENTATION-PRD.md (the C7 pinned name; PM-lane authored). Returns the
 * promised items (checkbox-item form, one promised item per line), or null
 * when the slice declares no contract (tier-1 degrade — zero noise).
 */
export function parseProofContract(prdContent: string): string[] | null {
  const lines = prdContent.split("\n");
  const start = lines.findIndex((l) => /^##\s+Proof contract\s*$/i.test(l.trim()));
  if (start === -1) return null;
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line)) break; // next section
    const m = line.match(/^\s*-\s*(?:\[[ xX]\]\s*)?(.+\S)\s*$/);
    if (m) items.push(m[1]!);
  }
  return items;
}

function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function proofCommand(): Command {
  const cmd = new Command("proof").description(
    "Proof artifacts — drop gate/proof evidence into a slice's proof/ dir with the machine-readable C1 header, validated at the natural moment (OPR.0.4.4.19 FR-8). The drop is the SDLC's proof leg: --evidences joins it to the slice's ## Proof contract items (what the Living Notes DELIVERED section pairs + renders); proof-lock afterwards via rig scope slice approve --scope delivery. Conventions SSOT: docs/reference/sdlc-conventions.md (installed: $OPENRIG_HOME/reference/sdlc-conventions.md)."
  );
  cmd.option("--workspace <path>", "Override workspace root (else cwd walk or $OPENRIG_WORK_ROOT)");

  cmd
    .command("add <slice-path>")
    .description("Drop a proof artifact: authors the C1 frontmatter from flags, writes <slice>/proof/<name>, echoes the parsed header. Contract/self-check/C8 outputs are advisories (exit 0) — never gates.")
    .option("--mission <name>", "Hint mission when slice-path is just NN-slug")
    .requiredOption("--artifact-type <type>", `C1 artifact_type, one of: ${C1_ARTIFACT_TYPES.join(" | ")}`)
    .requiredOption("--verdict <verdict>", `C1 verdict, one of: ${C1_VERDICTS.join(" | ")}`)
    .requiredOption("--candidate-sha <sha>", "C1 candidate_sha — the join key (convention C2): the proven candidate tip this artifact judges")
    .requiredOption("--money-evidence <line>", "C1 money_evidence — the one line of money evidence")
    .option("--slice-id <dot-id>", "C1 slice dot-ID (defaults to the slice frontmatter id)")
    .option("--file <path>", "Artifact body from a file (mutually exclusive with --body)")
    .option("--body <text>", "Artifact body inline (mutually exclusive with --file)")
    .option("--name <filename>", "Artifact filename in proof/ (defaults to the --file basename, else <artifact-type>-<verdict>-<UTC>.md)")
    .option("--evidences <refs>", "D2 attestation: comma-separated proof-contract item refs this artifact covers (item text or 1-based index)")
    .option("--self-check <text>", "D2 attestation: the agent's assertion that it LOOKED at the evidence and confirmed it shows the claim")
    .option("--media <refs>", "Corrective §3.4: comma-separated media refs (relative to the slice proof/ dir) this drop stands behind — appended to the artifact body as markdown refs so the composer curates them into delivered.items[].proof")
    .option("--json", "JSON output for agents")
    .action(async (slicePath: string, opts: {
      mission?: string;
      artifactType: string;
      verdict: string;
      candidateSha: string;
      moneyEvidence: string;
      sliceId?: string;
      file?: string;
      body?: string;
      name?: string;
      evidences?: string;
      selfCheck?: string;
      media?: string;
      json?: boolean;
    }, command: Command) => {
      const json = Boolean(opts.json);
      const advisories: string[] = [];
      const warns: string[] = [];
      try {
        if (opts.file && opts.body) {
          throw new ScopeCliError({
            fact: "Both --file and --body were provided.",
            consequence: "The artifact body is ambiguous.",
            action: "Pass exactly one of --file <path> or --body <text>.",
          });
        }
        const parentOpts = (command.parent?.opts() ?? {}) as { workspace?: string };
        const missionsRoot = resolveMissionsRoot({ override: parentOpts.workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);

        // Resolve the artifact body.
        let body = "";
        if (opts.file) {
          if (!fs.existsSync(opts.file)) {
            throw new ScopeCliError({
              fact: `--file ${opts.file} does not exist.`,
              consequence: "No artifact body to drop.",
              action: "Point --file at the evidence file, or use --body.",
            });
          }
          body = fs.readFileSync(opts.file, "utf8");
        } else if (opts.body) {
          body = opts.body;
        }

        // Corrective §3.4 — attach curated media refs (proof/-relative) to
        // the artifact body as markdown refs; the composer projects them
        // into delivered.items[].proof for the covered deliverables. Same
        // containment discipline as --name: nothing outside the slice dir.
        const sliceProofDir = path.join(slice.absPath, "proof");
        const mediaRefs = opts.media
          ? opts.media.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const mediaLines: string[] = [];
        for (const ref of mediaRefs) {
          if (path.isAbsolute(ref)) {
            throw new ScopeCliError({
              fact: `--media ref '${ref}' is absolute.`,
              consequence: "The artifact was NOT dropped — proof media is co-located slice content (FR-5), referenced relative to the slice's proof/ dir.",
              action: "Copy the media into the slice's proof/ dir and pass the relative name.",
            });
          }
          const resolved = path.resolve(sliceProofDir, ref);
          if (!resolved.startsWith(path.resolve(slice.absPath) + path.sep)) {
            throw new ScopeCliError({
              fact: `--media ref '${ref}' resolves outside the slice dir.`,
              consequence: "The artifact was NOT dropped — out-of-slice media can never be served or frozen with the review (FR-5).",
              action: "Move the media under the slice dir (proof/ is the natural home) and re-run.",
            });
          }
          if (!fs.existsSync(resolved)) {
            warns.push(`--media ref '${ref}' does not exist yet (${resolved}) — the review will show it as unavailable until the file lands`);
          }
          const ext = path.extname(ref).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) mediaLines.push(`<video src="${ref}"></video>`);
          else mediaLines.push(`![${ref}](${ref})`);
        }
        if (mediaLines.length > 0) {
          body = `${body.trimEnd()}\n\n## Media\n\n${mediaLines.join("\n")}\n`;
        }

        // Author the C1 header from flags + slice identity.
        const header: Partial<C1Header> = {
          slice: opts.sliceId ?? (typeof slice.id === "string" ? slice.id : undefined),
          candidate_sha: opts.candidateSha,
          artifact_type: opts.artifactType,
          verdict: opts.verdict,
          money_evidence: opts.moneyEvidence,
        };
        const evidences = opts.evidences
          ? opts.evidences.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        if (evidences && evidences.length > 0) header.evidences = evidences;
        if (opts.selfCheck) header.self_check = opts.selfCheck;

        // Validate the closed sets AT DROP TIME (while the evidence is
        // in-hand) — the one REJECTING validation this path performs.
        const validation = validateC1Header(header);
        if (!validation.ok) {
          const parts: string[] = [];
          if (validation.missing.length > 0) parts.push(`missing required C1 field(s): ${validation.missing.join(", ")}`);
          for (const inv of validation.invalid) {
            parts.push(`${inv.field}='${inv.value}' is not in the ratified closed set (${inv.allowed.join(" | ")})`);
          }
          throw new ScopeCliError({
            fact: `C1 header invalid — ${parts.join("; ")}.`,
            consequence: "The artifact was NOT dropped (post-hoc reconstruction is the failure mode this fights).",
            action: "Provide the named fields with allowed values and re-run while the evidence is in-hand. Extending the closed sets is a pm-lead convention change (BR-4).",
          });
        }

        // D2 — validate evidences refs against the slice's declared proof
        // contract (unknown refs = a named WARN, never a rejection), and
        // emit the coverage/self_check ADVISORY when a contract exists.
        const prdPath = path.join(slice.absPath, "IMPLEMENTATION-PRD.md");
        const prdItems = fs.existsSync(prdPath)
          ? parseProofContract(fs.readFileSync(prdPath, "utf8"))
          : null;
        let contractItems = prdItems;
        let contractSource: "prd" | "spec" | null = prdItems ? "prd" : null;
        // KI-5.3-2 SECOND FACE (row ki532proofssot): a PRISTINE SCAFFOLD
        // contract — every item still the template's [bracket placeholder] —
        // must NEVER become the canonical index (the observed failure:
        // contractItemsDeclared=1 pairing evidence against scaffold text while
        // the locked SPEC held six items). The truthful rule: derive from the
        // SPEC's own authored ## Proof contract with a NAMED advisory, else
        // degrade to no-contract. A genuinely AUTHORED PRD stays canonical
        // (the first-face ruling, preserved).
        const isPlaceholder = (it: string) => /^\[.*\]$/.test(it.trim());
        if (prdItems && prdItems.length > 0 && prdItems.every(isPlaceholder)) {
          const specPath = path.join(slice.absPath, "SPEC.md");
          const specItems = fs.existsSync(specPath)
            ? parseProofContract(fs.readFileSync(specPath, "utf8"))
            : null;
          if (specItems && specItems.length > 0 && !specItems.every(isPlaceholder)) {
            contractItems = specItems;
            contractSource = "spec";
            advisories.push(
              `contract source: IMPLEMENTATION-PRD.md's ## Proof contract is a pristine SCAFFOLD (placeholder items only) — ` +
                `derived the ${specItems.length}-item contract from SPEC.md instead. Author the PRD contract to make it canonical.`,
            );
          } else {
            contractItems = null;
            contractSource = null;
            advisories.push(
              "contract source: IMPLEMENTATION-PRD.md's ## Proof contract is a pristine SCAFFOLD and SPEC.md declares no authored contract — " +
                "treated as no declared contract (a placeholder index is never used).",
            );
          }
        }
        let coveredItems: string[] = [];
        if (contractItems && contractItems.length > 0) {
          if (evidences && evidences.length > 0) {
            for (const ref of evidences) {
              const byIndex = /^\d+$/.test(ref) ? contractItems[Number.parseInt(ref, 10) - 1] : undefined;
              const byText = contractItems.find((item) => item === ref);
              const match = byText ?? byIndex;
              if (match) coveredItems.push(match);
              else warns.push(`evidences ref '${ref}' matches no declared proof-contract item (known items: ${contractItems.map((_, i) => i + 1).join(", ")} or exact text)`);
            }
          }
          if (coveredItems.length === 0 || !header.self_check) {
            const uncovered = contractItems.filter((item) => !coveredItems.includes(item));
            const reasons: string[] = [];
            if (coveredItems.length === 0) reasons.push("this drop covers no declared contract item");
            if (!header.self_check) reasons.push("self_check attestation omitted");
            advisories.push(
              `ADVISORY (D2, advise-never-block): ${reasons.join(" and ")}. ` +
              `Uncovered contract item(s): ${uncovered.map((u) => `"${u}"`).join(", ")}. ` +
              `The Packet-2 promised→delivered join will show these as MISSING (the ▲ insufficient-proof signal).`
            );
          }
        }

        // FR-11 / C8 — the UX-slice video advisory (SHOULD/steer, exit 0,
        // no configuration can make it blocking). Trigger: slice frontmatter
        // ux-change: true (spec-time flag; never a qitem tag, never
        // diff-inference). Satisfied when this drop is a video or the
        // proof/ dir already holds one.
        const uxChange = slice.frontmatter["ux-change"] === true;
        if (uxChange) {
          const proofDir = path.join(slice.absPath, "proof");
          const existingVideo = fs.existsSync(proofDir)
            && fs.readdirSync(proofDir).some((f) => isVideoFile(f));
          const droppingVideo = (opts.file ? isVideoFile(opts.file) : false) || mediaRefs.some((r) => isVideoFile(r));
          if (!existingVideo && !droppingVideo) {
            advisories.push(
              "ADVISORY (C8, SHOULD/steer): this slice is UX-tagged (ux-change: true) and its proof set has no video. " +
              "UX-change slices SHOULD produce screenshot + video together — capture a screencast via the agent-browser-screencast method " +
              "and hold it to the money-shot-edit bar. This never blocks a drop."
            );
          }
        }

        // Write the artifact: YAML frontmatter + body into proof/.
        const proofDir = path.join(slice.absPath, "proof");
        const defaultName = `${opts.artifactType}-${opts.verdict}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
        const fileName = opts.name ?? (opts.file ? path.basename(opts.file) : defaultName);
        // rev1-r2 BLOCKING fix (a7dedd93 review): --name is a FILENAME, never
        // a path. Reject separators / dot-dot / absolute shapes BEFORE any
        // filesystem effect, so the drop can only land inside proof/ (the
        // FR-8 contract) — a traversal name like ../README.md must not reach
        // slice control files.
        if (fileName.includes("/") || fileName.includes("\\") || fileName.startsWith("..") || path.isAbsolute(fileName)) {
          throw new ScopeCliError({
            fact: `--name '${fileName}' is not a plain filename (path separators, '..', and absolute paths are rejected).`,
            consequence: "The artifact was NOT dropped — proof drops land inside the slice proof/ dir only (FR-8).",
            action: "Pass a bare filename like qa-clear.md; the drop path owns the directory.",
          });
        }
        const target = path.resolve(proofDir, fileName);
        // Defense-in-depth: even a name that slips the shape check must
        // resolve INSIDE proof/ (same containment discipline as
        // scope-approve's path-escape guard).
        if (!target.startsWith(path.resolve(proofDir) + path.sep)) {
          throw new ScopeCliError({
            fact: `--name '${fileName}' resolves outside the slice proof/ dir.`,
            consequence: "The artifact was NOT dropped.",
            action: "Pass a bare filename; the drop path owns the directory.",
          });
        }
        fs.mkdirSync(proofDir, { recursive: true });
        const frontmatter = YAML.stringify(header).trimEnd();
        fs.writeFileSync(target, `---\n${frontmatter}\n---\n\n${body}`, "utf8");

        // Echo the parsed header — the seat sees what the composer will see.
        const echo = {
          dropped: path.relative(process.cwd(), target),
          header: header as C1Header,
          contractItemsDeclared: contractItems?.length ?? 0,
          contractSource,
          contractItemsCovered: coveredItems,
          mediaRefs,
          warnings: warns,
          advisories,
        };
        if (json) {
          console.log(JSON.stringify(echo, null, 2));
        } else {
          console.log(`Dropped: ${echo.dropped}`);
          console.log(`Parsed C1 header:\n${frontmatter}`);
          if (contractItems) console.log(`Proof contract: ${coveredItems.length}/${contractItems.length} item(s) covered by this drop.`);
          for (const w of warns) console.error(`warning: ${w}`);
          for (const a of advisories) console.error(a);
        }
        // Advisories + warns NEVER change the exit code (BR-7).
      } catch (err) {
        if (err instanceof ScopeCliError) {
          if (json) {
            console.log(JSON.stringify({ ok: false, error: { fact: err.fact, consequence: err.consequence, action: err.action } }, null, 2));
          } else {
            console.error(`${err.fact}\n${err.consequence}\n${err.action}`);
          }
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return cmd;
}
