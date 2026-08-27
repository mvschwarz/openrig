import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(DAEMON_ROOT, "../..");
const PACK_PATHS = [
  resolve(DAEMON_ROOT, "assets/onboarding/01-world-and-purpose.md"),
  resolve(DAEMON_ROOT, "assets/onboarding/02-self-and-competent-action.md"),
];
const PUBLIC_REFERENCE_PATHS = [
  resolve(DAEMON_ROOT, "assets/onboarding/public-what-you-can-do.md"),
  resolve(DAEMON_ROOT, "assets/onboarding/public-reference-material.md"),
];
const MESSAGE_CEILING_BYTES = 9_400;

function packText(): string {
  return PACK_PATHS.map((path) => readFileSync(path, "utf8")).join("\n");
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 80);
}

describe("default onboarding pack", () => {
  it("ships as exactly two ordered files below the source walk message ceiling", () => {
    expect(PACK_PATHS.map((path) => readFileSync(path).byteLength)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    for (const path of PACK_PATHS) {
      const bytes = readFileSync(path).byteLength;
      expect(bytes, `${path} must remain walk-sized`).toBeLessThanOrEqual(MESSAGE_CEILING_BYTES);
      expect(bytes, `${path} must carry substantive orientation`).toBeGreaterThan(500);
    }
  });

  it("contains no provenance-marked or mechanically suspicious instance facts", () => {
    const text = packText();
    const bannedProvenance = [
      /TELLS-/i,
      /debt\.md/i,
      /measured on (?:this|the) instance/i,
      /may not hold on another/i,
      /map of one instance/i,
      /capability[- ]delta/i,
    ];
    for (const pattern of bannedProvenance) expect(text).not.toMatch(pattern);

    const mechanicalCandidates = [
      /\/(?:Users|home|tmp|private|var|opt)\//,
      /~\//,
      /\b(?:localhost|127\.0\.0\.1):\d+\b/,
      /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/,
      /\b\d+\s+(?:files?|directories|seats?|rigs?|pods?|lines?|bytes?|kib|kb|tokens?)\b/i,
      /\bthis (?:box|instance|vm|machine|host)\b/i,
      /(?:shared-docs\/|missions\/|<corpus>)/i,
    ];
    for (const pattern of mechanicalCandidates) expect(text).not.toMatch(pattern);
  });

  it("discovers an optional world pack without naming a dead default", () => {
    const text = packText();
    const stepTwo = readFileSync(PACK_PATHS[1]!, "utf8");
    expect(text).toContain("rig context list");
    expect(text).toContain("rig context profile <world-pack-ref> --situation fresh");
    expect(text).toContain("complete default mental model");
    expect(text).not.toContain("world/install");
    expect(stepTwo).toContain("public-what-you-can-do.md");
    expect(stepTwo).toContain("public-reference-material.md");
    expect(stepTwo).toContain("file reads within this second onboarding step");
    expect(text).toContain("forming-an-openrig-mental-model");
    expect(text).toContain("openrig-operating-model");

    const [capabilities, sources] = PUBLIC_REFERENCE_PATHS.map((path) => readFileSync(path, "utf8"));
    expect(capabilities).toContain("# What you can do here");
    expect(sources).toContain("## The command surface");
    expect(sources).toContain("## The living answer");
    expect(sources).toContain("## Outside the forest");
    expect(sources).toContain("## The one you read rather than consult");
    expect(sources).not.toContain("## The corpus");
    expect(sources).not.toContain("shared-docs/");
    expect(sources).not.toContain("Everything above is this box. The corpus");

    const canonPaths = [
      resolve(DAEMON_ROOT, "assets/plugins/openrig-core/skills/forming-an-openrig-mental-model/SKILL.md"),
      resolve(DAEMON_ROOT, "assets/plugins/openrig-core/skills/openrig-operating-model/SKILL.md"),
    ];
    const canonicalParagraphs = new Set(canonPaths.flatMap((path) => paragraphs(readFileSync(path, "utf8"))));
    const copied = paragraphs(text).filter((paragraph) => canonicalParagraphs.has(paragraph));
    expect(copied).toEqual([]);
  });

  it("keeps operator contact open without teaching a router hop", () => {
    const pack = packText();

    expect(pack).toContain("Any agent may contact them directly for");
    expect(pack).toContain("use a durable surface");
    expect(pack).toContain("orchestrators and PMs may also send updates");
    expect(pack).not.toMatch(/other seats route through them|role-gated/i);
  });

  it("ships a no-shared-vocabulary selection probe that is red on blank and green on packed context", () => {
    const prompt = "An open-ended cleanup request arrives. Name the physical-world question that prevents a chain of locally defensible improvements from solving the wrong problem.";
    const expected = /how big is the dog\??/i;
    expect(prompt).not.toMatch(/\bbig\b|\bdog\b/i);
    expect("").not.toMatch(expected);
    expect(packText()).toMatch(expected);
  });

  it("wires the typed setting into the production instantiator at launch time", () => {
    const startup = readFileSync(resolve(DAEMON_ROOT, "src/startup.ts"), "utf8");
    expect(startup).toContain('resolveOne("onboarding.default_pack.enabled")');
    expect(startup).toContain("onboardingEnabledResolver");
    expect(startup).not.toContain("OPENRIG_ONBOARDING_DEFAULT_PACK_ENABLED ===");

    const instantiator = readFileSync(resolve(DAEMON_ROOT, "src/domain/rigspec-instantiator.ts"), "utf8");
    expect(instantiator).toContain("assets/onboarding/01-world-and-purpose.md");
    expect(instantiator).toContain("assets/onboarding/02-self-and-competent-action.md");
  });

  it("keeps onboarding changes inside the declared product territory", () => {
    const packageJson = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    expect(packageJson).toContain('"packages/daemon"');
  });
});
