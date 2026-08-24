// OPR.0.4.4.19 FR-8 + FR-11 — rig proof add: C1 header validation at drop
// time, D2 attestation echo, contract + C8 advisories (advise-never-block).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  proofCommand,
  validateC1Header,
  parseProofContract,
  C1_ARTIFACT_TYPES,
  C1_VERDICTS,
} from "../src/commands/proof.js";

describe("validateC1Header (pure)", () => {
  const valid = {
    slice: "OPR.0.4.4.19",
    candidate_sha: "abc1234",
    artifact_type: "qa",
    verdict: "CLEAR",
    money_evidence: "park->resolve walk transitions row shows decision text",
  };

  it("accepts the five required fields with closed-set values", () => {
    expect(validateC1Header(valid).ok).toBe(true);
  });

  it("names every missing field", () => {
    const r = validateC1Header({ artifact_type: "qa" });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["slice", "candidate_sha", "verdict", "money_evidence"]);
  });

  it("rejects out-of-set artifact_type/verdict naming the allowed values (BR-4 closed sets)", () => {
    const r = validateC1Header({ ...valid, artifact_type: "designer", verdict: "SHIP-IT" });
    expect(r.ok).toBe(false);
    expect(r.invalid).toHaveLength(2);
    expect(r.invalid[0]!.allowed).toEqual(C1_ARTIFACT_TYPES);
    expect(r.invalid[1]!.allowed).toEqual(C1_VERDICTS);
  });
});

describe("parseProofContract (pure)", () => {
  it("returns null when no ## Proof contract section exists (zero-noise degrade)", () => {
    expect(parseProofContract("# PRD\n\n## Acceptance\n- [ ] thing\n")).toBeNull();
  });

  it("parses checkbox items until the next section", () => {
    const prd = [
      "# PRD",
      "## Proof contract",
      "- [ ] the live park->resolve walk with the transitions row shown",
      "- [x] approve run showing frontmatter + audit row together",
      "- plain item without checkbox",
      "## Next section",
      "- [ ] NOT a contract item",
    ].join("\n");
    expect(parseProofContract(prd)).toEqual([
      "the live park->resolve walk with the transitions row shown",
      "approve run showing frontmatter + audit row together",
      "plain item without checkbox",
    ]);
  });
});

describe("rig proof add (fs-level, temp workspace)", () => {
  let workRoot: string;
  let sliceDir: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-test-"));
    const missionDir = path.join(workRoot, "missions", "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "missions", "release-x", "README.md"), "---\nid: OPR.X\n---\n# m\n");
    sliceDir = missionDir;
    fs.writeFileSync(
      path.join(sliceDir, "README.md"),
      "---\nid: OPR.X.19\nstatus: building\n---\n# slice\n",
    );
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function run(args: string[]): Promise<void> {
    const cmd = proofCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "proof", "--workspace", workRoot, ...args]);
  }

  const baseArgs = (extra: string[] = []) => [
    "add", "19-signal-layer", "--mission", "release-x",
    "--artifact-type", "qa", "--verdict", "CLEAR",
    "--candidate-sha", "abc1234",
    "--money-evidence", "one line of money",
    "--body", "evidence body",
    "--name", "qa-clear.md",
    ...extra,
  ];

  it("happy drop: writes proof/<name> with valid YAML frontmatter and echoes the parsed header; exit 0", async () => {
    await run(baseArgs());
    const target = path.join(sliceDir, "proof", "qa-clear.md");
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf8");
    const fm = content.split("---")[1]!;
    const parsed = YAML.parse(fm) as Record<string, unknown>;
    expect(parsed.slice).toBe("OPR.X.19");
    expect(parsed.candidate_sha).toBe("abc1234");
    expect(parsed.artifact_type).toBe("qa");
    expect(parsed.verdict).toBe("CLEAR");
    expect(content).toContain("evidence body");
    expect(logs.join("\n")).toContain("Parsed C1 header");
    expect(process.exitCode).toBeUndefined();
  });

  it("out-of-set verdict is rejected naming the allowed values; nothing written; exit 1", async () => {
    await run([
      "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "SHIP-IT",
      "--candidate-sha", "abc1234", "--money-evidence", "m", "--body", "b",
    ]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("closed set");
    expect(fs.existsSync(path.join(sliceDir, "proof"))).toBe(false);
  });

  it("D2: evidences + self_check are parsed and echoed; unknown refs warn (never reject)", async () => {
    fs.writeFileSync(
      path.join(sliceDir, "IMPLEMENTATION-PRD.md"),
      "# PRD\n## Proof contract\n- [ ] item one\n- [ ] item two\n",
    );
    await run(baseArgs(["--evidences", "1,bogus-ref", "--self-check", "I looked; the walk shows the decision text"]));
    expect(process.exitCode).toBeUndefined();
    const content = fs.readFileSync(path.join(sliceDir, "proof", "qa-clear.md"), "utf8");
    expect(content).toContain("self_check");
    expect(errs.join("\n")).toContain("bogus-ref");
  });

  it("contract advisory: declared contract + no covered item/self_check => drop SUCCEEDS with advisory naming uncovered items", async () => {
    fs.writeFileSync(
      path.join(sliceDir, "IMPLEMENTATION-PRD.md"),
      "# PRD\n## Proof contract\n- [ ] item one\n",
    );
    await run(baseArgs());
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(sliceDir, "proof", "qa-clear.md"))).toBe(true);
    expect(errs.join("\n")).toContain("ADVISORY (D2");
    expect(errs.join("\n")).toContain("item one");
  });

  it("zero noise: NO contract declared => no contract advisory", async () => {
    await run(baseArgs());
    expect(errs.join("\n")).not.toContain("ADVISORY (D2");
  });

  it("C8: ux-change slice + no video => drop succeeds with the screencast advisory; exit 0", async () => {
    fs.writeFileSync(
      path.join(sliceDir, "README.md"),
      "---\nid: OPR.X.19\nstatus: building\nux-change: true\n---\n# slice\n",
    );
    await run(baseArgs());
    expect(process.exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("ADVISORY (C8");
    expect(errs.join("\n")).toContain("agent-browser-screencast");
  });

  it("C8 zero noise: no ux-change flag => no video advisory; existing video also silences it", async () => {
    await run(baseArgs());
    expect(errs.join("\n")).not.toContain("ADVISORY (C8");
    // Now flag the slice AND plant a video — advisory stays silent.
    fs.writeFileSync(
      path.join(sliceDir, "README.md"),
      "---\nid: OPR.X.19\nux-change: true\n---\n# slice\n",
    );
    fs.writeFileSync(path.join(sliceDir, "proof", "walk.mp4"), "fake video bytes");
    errs.length = 0;
    await run(baseArgs(["--name", "qa-clear-2.md"]));
    expect(errs.join("\n")).not.toContain("ADVISORY (C8");
  });
});

// rev1-r2 BLOCKING regression (candidate a7dedd93 review): --name must be a
// filename, never a path — a traversal name can never escape proof/.
describe("rig proof add --name traversal rejection (rev1-r2 fixback)", () => {
  let workRoot: string;
  let sliceDir: string;
  let errs: string[];

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-trav-"));
    sliceDir = path.join(workRoot, "missions", "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "missions", "release-x", "README.md"), "---\nid: OPR.X\n---\n# m\n");
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.X.19\nstatus: building\n---\n# ORIGINAL README BODY\n");
    errs = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function runAdd(name: string): Promise<void> {
    const cmd = proofCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      "node", "proof", "--workspace", workRoot,
      "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "CLEAR",
      "--candidate-sha", "abc1234", "--money-evidence", "m",
      "--body", "traversal attempt body",
      "--name", name,
    ]);
  }

  it("--name ../README.md is REJECTED and the slice README is NOT modified", async () => {
    const readmePath = path.join(sliceDir, "README.md");
    const before = fs.readFileSync(readmePath, "utf8");
    await runAdd("../README.md");
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("not a plain filename");
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    // Nothing landed in proof/ either.
    const proofDir = path.join(sliceDir, "proof");
    expect(!fs.existsSync(proofDir) || fs.readdirSync(proofDir).length === 0).toBe(true);
  });

  it("other escape shapes are rejected: nested path, backslash, absolute, dot-dot", async () => {
    for (const name of ["sub/dir.md", "..\\\\evil.md", "/tmp/abs.md", ".."]) {
      process.exitCode = undefined;
      await runAdd(name);
      expect(process.exitCode, `name '${name}' must be rejected`).toBe(1);
    }
  });

  it("a plain filename still drops normally after the fix", async () => {
    await runAdd("qa-clear.md");
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(sliceDir, "proof", "qa-clear.md"))).toBe(true);
  });
});

// KI-5.3-2 SECOND FACE (row ki532proofssot) — a PRISTINE SCAFFOLD contract must
// never be the canonical item index. Both observed faces pinned: the scaffold's
// single bracket-placeholder becoming a plausible one-item contract
// (contractItemsDeclared=1 against a locked SPEC of six), and the zero/unpaired
// degrade. The truthful rule: an all-placeholder contract is a SCAFFOLD —
// derive from the locked SPEC's own ## Proof contract with a NAMED advisory,
// else degrade to no-contract; never silently choose the placeholder index.
// Genuinely authored PRD contracts keep canonical behavior (the KI-5.3-2
// first-face ruling preserved).
describe("proof add — pristine-scaffold contract never canonical (KI-5.3-2 second face)", () => {
  let workRoot: string;
  let sliceDir: string;
  let logs: string[];

  const SCAFFOLD_PRD = "---\nid: OPR.X.19\n---\n# slice\n\n## Proof contract\n\n- [ ] [One promised deliverable, written as an observable outcome — captured. This list is the source the DELIVERED section pairs proof against.]\n";
  const SPEC_WITH_SIX = "---\nid: OPR.X.19\n---\n# slice\n\n## Proof contract\n\n" +
    ["alpha door", "beta door", "gamma door", "delta door", "epsilon door", "zeta door"]
      .map((d) => `- [ ] ${d.toUpperCase()}: the ${d} proves itself`).join("\n") + "\n";

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-ssot-"));
    sliceDir = path.join(workRoot, "missions", "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "missions", "release-x", "README.md"), "---\nid: OPR.X\n---\n# m\n");
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.X.19\nstatus: building\n---\n# slice\n");
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function run(args: string[]): Promise<void> {
    const cmd = proofCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "proof", "--workspace", workRoot, "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234",
      "--money-evidence", "m", "--body", "b", "--name", "qa.md", "--json", ...args]);
  }

  it("FACE 1: scaffold PRD + locked SPEC contract => derives the SPEC's six items with a NAMED advisory; evidences pair against the SPEC", async () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), SCAFFOLD_PRD);
    fs.writeFileSync(path.join(sliceDir, "SPEC.md"), SPEC_WITH_SIX);
    await run(["--evidences", "2", "--self-check", "looked"]);
    const out = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!) as { contractItemsDeclared: number; coveredItems?: string[]; advisories?: string[]; contractSource?: string };
    expect(out.contractItemsDeclared).toBe(6);
    expect(out.contractSource).toBe("spec");
    expect((out.coveredItems ?? []).join(" ")).toContain("BETA DOOR");
    expect((out.advisories ?? []).join(" ")).toMatch(/scaffold/i);
  });

  it("FACE 2: scaffold PRD + no SPEC contract => degrades to NO contract (never the placeholder 1-item index)", async () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), SCAFFOLD_PRD);
    await run([]);
    const out = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!) as { contractItemsDeclared: number };
    expect(out.contractItemsDeclared).toBe(0);
  });

  it("CONTROL: a genuinely authored PRD contract stays canonical even when a SPEC contract also exists", async () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\nid: x\n---\n# s\n\n## Proof contract\n\n- [ ] REAL ITEM ONE\n- [ ] REAL ITEM TWO\n");
    fs.writeFileSync(path.join(sliceDir, "SPEC.md"), SPEC_WITH_SIX);
    await run(["--evidences", "1", "--self-check", "looked"]);
    const out = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!) as { contractItemsDeclared: number; coveredItems?: string[]; contractSource?: string };
    expect(out.contractItemsDeclared).toBe(2);
    expect(out.contractSource).toBe("prd");
    expect((out.coveredItems ?? []).join(" ")).toContain("REAL ITEM ONE");
  });
});
