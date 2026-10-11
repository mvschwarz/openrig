import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import YAML from "yaml";
import { DaemonClient } from "../client.js";
import { findSlice, resolveMissionsRoot } from "../lib/scope/scope-fs.js";
import { ScopeCliError } from "../lib/scope/types.js";
import { selectProofContractBody, isScaffoldPlaceholderText } from "../lib/scope/scaffold-placeholder.js";
import { parseLogicalCheckboxes } from "../lib/scope/logical-checkbox.js";

/**
 * `rig proof add` — the evidence-capture write path (OPR.0.4.4.19 FR-8 + FR-11;
 * conventions C1 + C2 + C8, D2 attestation).
 *
 * The capture leg is CLI-side filesystem only: the drop
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
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf",
  ".mp3", ".wav", ".ogg", ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv",
  ".zip", ".gz", ".7z", ".exe",
]);

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
 * authored work-node contract (SPEC.md for current work; legacy filenames
 * remain readable). Returns the
 * promised items (checkbox-item form, one promised item per line), or null
 * when the slice declares no contract (tier-1 degrade — zero noise).
 */
export function parseProofContract(prdContent: string): string[] | null {
  const lines = prdContent.split("\n");
  const start = lines.findIndex((l) => /^##\s+Proof contract\s*$/i.test(l.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) { end = i; break; } // next section
  }
  // KI-5.3-2 — ONE grammar: the review composer's logical-checkbox relation
  // (CHECKBOX rows only, deeper continuations JOINED). This makes a 1-based
  // evidence index name the SAME promise here and at render — no phantom bare
  // bullet, no split sub-bullet shifting the byIndex. Scaffold placeholders are
  // NOT filtered here: the pristine-scaffold second-face check below needs to
  // see them; the canonical index filters them per-item after that check,
  // exactly as the composer's extractProofContract does.
  return parseLogicalCheckboxes(lines.slice(start + 1, end).join("\n")).map((it) => it.rawText);
}

function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function proofCommand(): Command {
  const cmd = new Command("proof").description(
    "Capture evidence (add), record an attributed item judgment (judge), and read derived readiness (show). Capture, policy acceptance, higher outcome judgment and publication are separate."
  );
  cmd.addHelpText("after", `
The selected daemon owns show/judge. Scope addresses are mission/slices/slice#item.
The project owner selects proofPolicy: { judges: [exact-seat-address] } in the
owning slice.yaml, mission.yaml or project.yaml (nearest wins; no default gate roles).
The contract is the authored ## Proof contract. A sole item needs no # selector.

Example (existing evidence, no copied hashes or operation key):
  rig proof judge trial/slices/01-build#1 --verdict accept --reason 'Observed the promised outcome' --evidence proof/result.md
  rig proof show trial --json
  rig proof judge trial/slices/01-build#1 --verdict withdraw --reason 'The result no longer supports acceptance'

Corrections retain prior receipts in proof/judgments/. --replace deliberately
reaffirms a historical identical judgment after a correction; an ordinary retry
returns its original receipt plus current readiness and never reinstates old truth.
Use judge --help for patch-equivalent comparison receipts and advanced identities.
Legacy proof add artifacts may be referenced directly; queue done and stored
checkboxes do not accept an item under the selected proof policy.
`);
  cmd.option("--workspace <path>", "Capture/add only: override workspace root; show/judge use the selected daemon workspace");

  const client = () => {
    if (cmd.opts().workspace) throw new Error("--workspace applies to proof add. Select the judgment daemon using OPENRIG_URL; proof show reports its scope basis.");
    return new DaemonClient();
  };
  const response = async (r: { status: number; data: unknown }): Promise<Record<string, any>> => {
    const data = r.data as Record<string, any>;
    if (r.status >= 400) throw new Error(`${data.error ?? r.status}: ${data.message ?? "Read the named source and retry"}`);
    return data;
  };
  cmd.command("show [scope]").description("Read current attributed proof readiness for a slice, mission or active project; no status files are changed.")
    .option("--json", "Structured readiness, item revisions and retained judgment references")
    .action(async (scope, opts) => {
      try {
        const data = await response(await client().get(`/api/proof${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`));
        console.log(opts.json ? JSON.stringify(data) : JSON.stringify(data, null, 2));
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });
  cmd.command("judge <scope-item>").description("Record one attributed item judgment and derive readiness. Use mission/slices/slice#item (index, text or ID). Policy inherits proofPolicy.judges from owning slice, mission or project.")
    .requiredOption("--verdict <verdict>", "accept | reject | withdraw")
    .requiredOption("--reason <text>", "The evidence-backed judgment being made")
    .option("--evidence <ref>", "Existing evidence, relative to slice or workspace missions/; repeat for multiple references", (v: string, prior: string[]) => [...prior, v], [])
    .option("--subject <kind:ref>", "artifact, commit or patch-equivalent subject; artifact inferred when omitted")
    .option("--comparison <ref>", "Patch-equivalent subject: actual comparison/adoption receipt alongside outcome evidence")
    .option("--revision <revision>", "Advanced: deliberately require this item revision")
    .option("--operation-id <id>", "Advanced: explicit retry identity")
    .option("--replace", "Deliberately reaffirm a historical judgment after a later correction")
    .option("--json", "Return committed receipt and current readiness")
    .action(async (address: string, opts) => {
      try {
        const at = address.indexOf("#"), scope = at < 0 ? address : address.slice(0, at), selector = at < 0 ? null : address.slice(at + 1);
        const refs = [...new Set<string>([...opts.evidence, ...(opts.comparison ? [opts.comparison] : [])])];
        const query = new URLSearchParams({ scope });
        for (const ref of refs) query.append("evidence", ref);
        const c = client(), view = await response(await c.get(`/api/proof?${query}`));
        const items = view.items as Array<{ id: string; text: string; index: number; revision: string; judgment: { id: string } | null }> | undefined;
        const item = selector ? items?.find(i => i.id === selector || i.text === selector || String(i.index) === selector) : items?.length === 1 ? items[0] : undefined;
        if (!item) throw new Error("Select one current item with scope#item; rig proof show lists IDs, text and indices");
        const subjectAt = opts.subject?.indexOf(":") ?? -1;
        if (opts.subject && subjectAt < 1) throw new Error("--subject must be kind:ref");
        const body = { scope, item: item.id, verdict: opts.verdict, reason: opts.reason,
          ...(refs.length ? { evidence: refs, expectedEvidence: view.preparedEvidence } : {}),
          ...(opts.subject ? { subject: { kind: opts.subject.slice(0, subjectAt), ref: opts.subject.slice(subjectAt + 1), ...(opts.comparison ? { comparison: opts.comparison } : {}) } } : {}),
          expectedRevision: opts.revision ?? item.revision, expectedPrevious: item.judgment?.id ?? null,
          operationId: opts.operationId, replace: opts.replace === true };
        const result = await response(await c.post("/api/proof/judge", body));
        console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });

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
    .option("--name <filename>", "Markdown artifact filename in proof/ (defaults to the --file stem plus .md, else <artifact-type>-<verdict>-<UTC>.md)")
    .option("--replace", "Explicitly replace an existing Markdown artifact")
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
      replace?: boolean;
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
          const input = fs.readFileSync(opts.file);
          if (BINARY_EXTENSIONS.has(path.extname(opts.file).toLowerCase()) || input.includes(0)) {
            throw new ScopeCliError({
              fact: `--file ${opts.file} is binary, not an artifact body.`,
              consequence: "The artifact was NOT dropped and the source file was not changed.",
              action: "Attach screenshots and other binary evidence with --media instead.",
            });
          }
          try {
            body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
          } catch {
            throw new ScopeCliError({
              fact: `--file ${opts.file} is not valid UTF-8 text.`,
              consequence: "The artifact was NOT dropped and the source file was not changed.",
              action: "Use a UTF-8 text file for --file, or attach binary evidence with --media.",
            });
          }
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
        // KI-5.3-2 follow-up (row e69daaef): contract-source selection is
        // ONE-HOMED in the scaffold-placeholder twin (selectProofContractBody)
        // — the same selection compose and the audit consume, so evidence can
        // never again record against one contract and display against another.
        // proof-add reads all three documents and the twin decides; the twins
        // are byte-equal by the arch parity contract (deliberately NOT
        // deduplicated across packages — the ruling in the twin's own header;
        // this deviates from the follow-up row's subpath-export wording WITH
        // that citation: same-package twin import preserves the parity
        // arrangement a cross-package consumer would break).
        const readDoc = (name: string): string | null => {
          const fp = path.join(slice.absPath, name);
          return fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : null;
        };
        const prdDoc = readDoc("IMPLEMENTATION-PRD.md");
        const specDoc = readDoc("SPEC.md");
        const readmeDoc = readDoc("README.md");
        const contractBody = (doc: string | null): string | null => {
          if (doc === null) return null;
          const items = parseProofContract(doc);
          if (items === null) return null;
          const lines = doc.split("\n");
          const start = lines.findIndex((l) => /^##\s+Proof contract\s*$/i.test(l.trim()));
          const rest = lines.slice(start + 1);
          const end = rest.findIndex((l) => /^##\s/.test(l));
          return rest.slice(0, end === -1 ? undefined : end).join("\n");
        };
        const selection = selectProofContractBody({
          prdBody: contractBody(prdDoc),
          specBody: contractBody(specDoc),
          readmeBody: contractBody(readmeDoc),
        });
        const contractSource = selection.source;
        // KI-5.3-2 item-grammar: parse the SELECTED source with the ONE shared
        // logical-checkbox grammar, then drop scaffold-placeholder rows PER-ITEM
        // — the same per-item skip the review composer's extractProofContract
        // applies — so a MIXED placeholder+authored body does not shift a 1-based
        // evidence index onto a placeholder row (the silent one-position mispair).
        let contractItems = contractSource === null
          ? null
          : parseProofContract(contractSource === "prd" ? prdDoc! : contractSource === "spec" ? specDoc! : readmeDoc!);
        if (contractItems) contractItems = contractItems.filter((it) => !isScaffoldPlaceholderText(it));
        if (contractSource !== null && contractSource !== "spec") {
          advisories.push(
            `contract source: SPEC.md has no authored ## Proof contract — ` +
              `the ${contractItems?.length ?? 0}-item contract derives from legacy ${contractSource === "prd" ? "IMPLEMENTATION-PRD.md" : "README.md"}. ` +
              "Move future contract edits into SPEC.md; the legacy file remains readable.",
          );
        } else if (contractSource === null) {
          advisories.push(
            "contract source: no authored SPEC.md proof contract or readable legacy fallback — treated as no declared contract.",
          );
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
        const fileName = opts.name ?? (opts.file ? `${path.parse(opts.file).name}.md` : defaultName);
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
        if (!fileName.toLowerCase().endsWith(".md")) {
          throw new ScopeCliError({
            fact: `--name '${fileName}' is not a Markdown artifact filename.`,
            consequence: "The artifact was NOT dropped; proof media cannot be replaced by a Markdown body.",
            action: "Use a .md name for the artifact and attach binary files with --media.",
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
        const content = `---\n${frontmatter}\n---\n\n${body}`;
        try {
          if (opts.replace) replaceArtifactFile(target, content);
          else fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
        } catch (err) {
          if (opts.replace || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          throw new ScopeCliError({
            fact: `Proof artifact '${fileName}' already exists.`,
            consequence: "The existing artifact was not changed.",
            action: "Choose another --name, or pass --replace to deliberately update this Markdown artifact.",
          });
        }

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

/** Explicit --replace swaps the artifact's directory entry; it never writes through it. A symlink or hard
 *  link at the artifact name therefore keeps its other path's bytes. The staging file is created
 *  exclusively under a unique name, so cleanup only ever removes a file this call created, and a failed
 *  write, close or rename leaves the target as it was. An existing regular artifact's permission bits carry
 *  over, so a replacement never broadens access; a symlinked or new name gets default permissions. The
 *  first failure is the one reported. There is no fsync: this is a same-directory swap, not a
 *  crash-durability guarantee. */
export function replaceArtifactFile(target: string, content: string, stagingId: string = randomUUID()): void {
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${stagingId}.replace-tmp`);
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  const keepMode = existing?.isFile() ? existing.mode & 0o777 : undefined;
  const fd = fs.openSync(staging, "wx", keepMode ?? 0o666); // never created wider than the artifact it replaces
  let failure: unknown;
  try {
    if (keepMode !== undefined) fs.fchmodSync(fd, keepMode);
    fs.writeFileSync(fd, content, "utf8");
  } catch (err) {
    failure = err;
  }
  try {
    fs.closeSync(fd);
  } catch (closeErr) {
    if (failure === undefined) failure = closeErr;
    else console.error(`warning: closing staging file ${staging} also failed: ${(closeErr as Error).message}`);
  }
  try {
    if (failure !== undefined) throw failure;
    fs.renameSync(staging, target);
  } catch (err) {
    try { fs.rmSync(staging, { force: true }); }
    catch (cleanupErr) { console.error(`warning: could not remove staging file ${staging}: ${(cleanupErr as Error).message}`); }
    throw err;
  }
}
