// OPR.0.4.4.19 FR-8 + FR-11 — rig proof add: C1 header validation at drop
// time, D2 attestation echo, contract + C8 advisories (advise-never-block).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  proofCommand,
  replaceArtifactFile,
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

  it("parses checkbox items until the next section — checkbox-only (KI-5.3-2)", () => {
    const prd = [
      "# PRD",
      "## Proof contract",
      "- [ ] the live park->resolve walk with the transitions row shown",
      "- [x] approve run showing frontmatter + audit row together",
      "- plain item without checkbox",
      "## Next section",
      "- [ ] NOT a contract item",
    ].join("\n");
    // KI-5.3-2 item-grammar unification: the proof-add grammar now matches the
    // review composer's parseLogicalCheckboxes — CHECKBOX rows only. A bare dash
    // bullet is no longer a phantom item that shifts every byIndex after it.
    expect(parseProofContract(prd)).toEqual([
      "the live park->resolve walk with the transitions row shown",
      "approve run showing frontmatter + audit row together",
    ]);
  });

  // KI-5.3-2 — the proof-add grammar must AGREE with the review composer's
  // parseLogicalCheckboxes over the same body, or a byIndex evidence ref points
  // at a different promise on each side (silent mispair, not a visible miscount).
  it("CONTROL — plain authored checkboxes are one item each (agreement, not a vacuous divergence)", () => {
    expect(parseProofContract("## Proof contract\n- [ ] alpha\n- [x] beta\n")).toEqual(["alpha", "beta"]);
  });

  it("CLASS 2 — a deeper sub-bullet is JOINED into its parent item (was a phantom 3rd item)", () => {
    expect(parseProofContract("## Proof contract\n- [ ] alpha\n  - sub detail\n- [ ] beta\n"))
      .toEqual(["alpha - sub detail", "beta"]);
  });

  it("CLASS 3 — a bare (non-checkbox) bullet between items is dropped (checkbox-only)", () => {
    expect(parseProofContract("## Proof contract\n- [ ] alpha\n- bare bullet\n- [x] beta\n"))
      .toEqual(["alpha", "beta"]);
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

  it("rejects a screenshot passed as --file without changing its bytes", async () => {
    const proofDir = path.join(sliceDir, "proof");
    fs.mkdirSync(proofDir);
    const screenshot = path.join(proofDir, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    fs.writeFileSync(screenshot, bytes);
    await run([
      "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "CLEAR",
      "--candidate-sha", "abc1234", "--money-evidence", "m",
      "--file", screenshot,
    ]);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(screenshot)).toEqual(bytes);
    expect(fs.readdirSync(proofDir)).toEqual(["shot.png"]);
    expect(errs.join("\n")).toContain("--media");

    process.exitCode = undefined;
    await run(baseArgs(["--name", "shot.png"]));
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(screenshot)).toEqual(bytes);
  });

  it("uses a Markdown name for a text file and requires --replace to overwrite it", async () => {
    const source = path.join(workRoot, "notes.txt");
    fs.writeFileSync(source, "first proof");
    const fromFile = [
      "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "CLEAR",
      "--candidate-sha", "abc1234", "--money-evidence", "m",
      "--file", source,
    ];
    await run(fromFile);
    const target = path.join(sliceDir, "proof", "notes.md");
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toContain("first proof");
    fs.writeFileSync(source, "revised proof");
    await run(fromFile);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(target, "utf8")).not.toContain("revised proof");
    process.exitCode = undefined;
    await run([...fromFile, "--replace"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toContain("revised proof");
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

  // KI-5.3-2 — the item grammar the byIndex evidence ref resolves against must
  // match the review composer's, over the SAME selected body.
  async function jsonEcho(prd: string, evidences: string, name: string): Promise<{
    contractItemsDeclared: number; contractSource: string | null; contractItemsCovered: string[];
  }> {
    if (prd) fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), prd);
    logs.length = 0;
    await run(baseArgs(["--evidences", evidences, "--name", name, "--json"]));
    return JSON.parse(logs.join("\n"));
  }

  it("CLASS 1 (mixed placeholder+authored): the placeholder is NOT a contract item and byIndex is not shifted", async () => {
    const prd = "# PRD\n## Proof contract\n- [ ] [scaffold placeholder]\n- [ ] real deliverable A\n- [ ] real deliverable B\n";
    const echo = await jsonEcho(prd, "1", "qa-c1.md");
    // The scaffold placeholder is skipped per-item exactly as the composer does:
    // TWO contract items, not three.
    expect(echo.contractItemsDeclared).toBe(2);
    expect(echo.contractSource).toBe("prd");
    // THE MISPAIR, by value not count: evidence "1" is the FIRST REAL promise
    // (real deliverable A). Pre-fix it landed on "[scaffold placeholder]",
    // shifting every promise by one so evidence rendered against the wrong item.
    expect(echo.contractItemsCovered).toEqual(["real deliverable A"]);
  });

  it("source: NO ## Proof contract section => contractSource null (nothing authored anywhere)", async () => {
    const echo = await jsonEcho("# PRD\n## Acceptance\n- [ ] x\n", "", "qa-null.md");
    expect(echo.contractSource).toBeNull();
    expect(echo.contractItemsDeclared).toBe(0);
  });

  it("source: a present-but-empty ## Proof contract => contractSource 'prd', zero items (authored-empty, distinct from null)", async () => {
    const echo = await jsonEcho("# PRD\n## Proof contract\n\n## Next\n- [ ] later\n", "", "qa-empty.md");
    expect(echo.contractSource).toBe("prd");
    expect(echo.contractItemsDeclared).toBe(0);
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

  it("FACE 1: scaffold PRD + SPEC contract => derives the SPEC's six items", async () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), SCAFFOLD_PRD);
    fs.writeFileSync(path.join(sliceDir, "SPEC.md"), SPEC_WITH_SIX);
    await run(["--evidences", "2", "--self-check", "looked"]);
    const out = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!) as { contractItemsDeclared: number; contractItemsCovered?: string[]; advisories?: string[]; contractSource?: string };
    expect(out.contractItemsDeclared).toBe(6);
    expect(out.contractSource).toBe("spec");
    expect((out.contractItemsCovered ?? []).join(" ")).toContain("BETA DOOR");
    expect(out.advisories ?? []).toHaveLength(0);
  });

  it("FACE 2: scaffold PRD + no SPEC contract => degrades to NO contract (never the placeholder 1-item index)", async () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), SCAFFOLD_PRD);
    await run([]);
    const out = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!) as { contractItemsDeclared: number };
    expect(out.contractItemsDeclared).toBe(0);
  });

  it("CONTROL: a genuinely authored legacy PRD stays readable when SPEC is absent", async () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\nid: x\n---\n# s\n\n## Proof contract\n\n- [ ] REAL ITEM ONE\n- [ ] REAL ITEM TWO\n");
    await run(["--evidences", "1", "--self-check", "looked"]);
    const out = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!) as { contractItemsDeclared: number; contractItemsCovered?: string[]; contractSource?: string };
    expect(out.contractItemsDeclared).toBe(2);
    expect(out.contractSource).toBe("prd");
    expect((out.contractItemsCovered ?? []).join(" ")).toContain("REAL ITEM ONE");
  });
});

describe("rig proof add --replace swaps the entry and never writes through links", () => {
  let workRoot: string;
  let sliceDir: string;
  let proofDir: string;
  let errs: string[];

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replace-"));
    sliceDir = path.join(workRoot, "missions", "release-x", "slices", "19-signal-layer");
    proofDir = path.join(sliceDir, "proof");
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "missions", "release-x", "README.md"), "---\nid: OPR.X\n---\n# m\n");
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.X.19\nstatus: building\n---\n# slice\n");
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

  async function add(name: string, extra: string[] = []): Promise<void> {
    const cmd = proofCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "proof", "--workspace", workRoot, "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "m",
      "--name", name, ...(extra.includes("--file") ? [] : ["--body", "replacement body"]), ...extra]);
  }
  const stagingLeftovers = () => fs.readdirSync(proofDir).filter((f) => f.endsWith(".replace-tmp"));
  const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

  it("a symlinked artifact name is replaced; the linked file keeps its bytes", async () => {
    const outside = path.join(workRoot, "outside");
    fs.mkdirSync(outside);
    const victim = path.join(outside, "victim.png");
    fs.writeFileSync(victim, png("symlink victim"));
    fs.symlinkSync(victim, path.join(proofDir, "linked.md"));
    await add("linked.md", ["--replace"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(victim)).toEqual(png("symlink victim"));
    expect(fs.lstatSync(path.join(proofDir, "linked.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(proofDir, "linked.md"), "utf8")).toContain("replacement body");
    expect(stagingLeftovers()).toEqual([]);
  });

  it("a hard-linked artifact name is replaced; the other link keeps its bytes", async () => {
    const shot = path.join(proofDir, "shot.png");
    fs.writeFileSync(shot, png("hardlink victim"));
    fs.linkSync(shot, path.join(proofDir, "hard.md"));
    await add("hard.md", ["--replace"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(shot)).toEqual(png("hardlink victim"));
    expect(fs.statSync(shot).nlink).toBe(1);
    expect(fs.readFileSync(path.join(proofDir, "hard.md"), "utf8")).toContain("replacement body");
  });

  it("a normal replace and a self-sourced replace both still work", async () => {
    fs.writeFileSync(path.join(proofDir, "normal.md"), "original\n");
    await add("normal.md", ["--replace"]);
    expect(fs.readFileSync(path.join(proofDir, "normal.md"), "utf8")).toContain("replacement body");
    const self = path.join(proofDir, "self.md");
    fs.writeFileSync(self, "self body\n");
    await add("self.md", ["--file", self, "--replace"]);
    expect(process.exitCode).toBeUndefined();
    const after = fs.readFileSync(self, "utf8");
    expect(after.startsWith("---\n")).toBe(true);
    expect(after).toContain("self body");
    expect(stagingLeftovers()).toEqual([]);
  });

  it("without --replace an existing name is still refused and unchanged", async () => {
    const existing = path.join(proofDir, "kept.md");
    fs.writeFileSync(existing, "kept\n");
    await add("kept.md");
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("already exists");
    expect(fs.readFileSync(existing, "utf8")).toBe("kept\n");
  });

  it("never touches a staging file it did not create", () => {
    const target = path.join(proofDir, "x.md");
    fs.writeFileSync(target, "original\n");
    const foreign = path.join(proofDir, ".x.md.fixed.replace-tmp");
    fs.writeFileSync(foreign, "not ours\n");
    expect(() => replaceArtifactFile(target, "new\n", "fixed")).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(fs.readFileSync(foreign, "utf8")).toBe("not ours\n");
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
  });

  it("a failed write leaves the target as it was and removes only its own staging file", async () => {
    const target = path.join(proofDir, "w.md");
    fs.writeFileSync(target, "original\n");
    const real = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (typeof file === "number") throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return (real as (...a: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    await expect(add("w.md", ["--replace"])).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    expect(stagingLeftovers()).toEqual([]);
  });

  it("a directory at the artifact name fails the replace and is left intact", async () => {
    const dir = path.join(proofDir, "dir.md");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "inside.txt"), "inside\n");
    await expect(add("dir.md", ["--replace"])).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "inside.txt"), "utf8")).toBe("inside\n");
    expect(stagingLeftovers()).toEqual([]);
  });

  it("keeps an existing regular artifact's permission bits; a symlinked name gets default permissions", async () => {
    const priv = path.join(proofDir, "private.md");
    fs.writeFileSync(priv, "original\n");
    fs.chmodSync(priv, 0o600);
    const inode = fs.statSync(priv).ino;
    await add("private.md", ["--replace"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.statSync(priv).mode & 0o777).toBe(0o600);
    expect(fs.statSync(priv).ino).not.toBe(inode);
    expect(fs.readFileSync(priv, "utf8")).toContain("replacement body");

    const outside = path.join(workRoot, "outside-mode");
    fs.mkdirSync(outside);
    const linkedTarget = path.join(outside, "secret.png");
    fs.writeFileSync(linkedTarget, png("mode victim"));
    fs.chmodSync(linkedTarget, 0o600);
    fs.symlinkSync(linkedTarget, path.join(proofDir, "via-link.md"));
    await add("via-link.md", ["--replace"]);
    expect(fs.lstatSync(path.join(proofDir, "via-link.md")).mode & 0o777).toBe(0o666 & ~process.umask());
    expect(fs.statSync(linkedTarget).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(linkedTarget)).toEqual(png("mode victim"));
  });

  it("creates the staging file no wider than the artifact it replaces", async () => {
    const priv = path.join(proofDir, "tight.md");
    fs.writeFileSync(priv, "original\n");
    fs.chmodSync(priv, 0o600);
    const createdModes: number[] = [];
    const realFchmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation(((fd: number, mode: fs.Mode) => {
      createdModes.push(fs.fstatSync(fd).mode & 0o777); // the mode the exclusive open created, before narrowing
      return realFchmod(fd, mode);
    }) as typeof fs.fchmodSync);
    await add("tight.md", ["--replace"]);
    expect(process.exitCode).toBeUndefined();
    expect(createdModes).toEqual([0o600]);
    expect(fs.statSync(priv).mode & 0o777).toBe(0o600);
  });

  it("replaces a read-only artifact on explicit --replace and keeps it read-only", async () => {
    const ro = path.join(proofDir, "frozen.md");
    fs.writeFileSync(ro, "original\n");
    fs.chmodSync(ro, 0o444);
    await add("frozen.md", ["--replace"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.statSync(ro).mode & 0o777).toBe(0o444);
    expect(fs.readFileSync(ro, "utf8")).toContain("replacement body");
  });

  it("reports the write failure, not a later close failure, and keeps the target", async () => {
    const target = path.join(proofDir, "wc.md");
    fs.writeFileSync(target, "original\n");
    const realWrite = fs.writeFileSync;
    const realClose = fs.closeSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (typeof file === "number") throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return (realWrite as (...a: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      realClose(fd);
      throw Object.assign(new Error("i/o error on close"), { code: "EIO" });
    }) as typeof fs.closeSync);
    await expect(add("wc.md", ["--replace"])).rejects.toMatchObject({ code: "ENOSPC" });
    expect(errs.join("\n")).toContain("also failed");
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    expect(stagingLeftovers()).toEqual([]);
  });

  it("a close failure alone still refuses the rename", async () => {
    const target = path.join(proofDir, "c.md");
    fs.writeFileSync(target, "original\n");
    const realClose = fs.closeSync;
    vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      realClose(fd);
      throw Object.assign(new Error("i/o error on close"), { code: "EIO" });
    }) as typeof fs.closeSync);
    await expect(add("c.md", ["--replace"])).rejects.toMatchObject({ code: "EIO" });
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    expect(stagingLeftovers()).toEqual([]);
  });

  it("reports the original failure when cleanup also fails", async () => {
    const target = path.join(proofDir, "r.md");
    fs.writeFileSync(target, "original\n");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); });
    vi.spyOn(fs, "rmSync").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    await expect(add("r.md", ["--replace"])).rejects.toMatchObject({ code: "EXDEV" });
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    expect(errs.join("\n")).toContain("could not remove staging file");
  });
});
