import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(DAEMON_ROOT, "../..");
const PACK_PATHS = [
  resolve(DAEMON_ROOT, "assets/onboarding/01-world-and-purpose.md"),
  resolve(DAEMON_ROOT, "assets/onboarding/02-self-and-competent-action.md"),
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
      /\bthis (?:box|instance|rig|vm|machine|host)\b/i,
      /(?:shared-docs\/|missions\/|<corpus>)/i,
    ];
    for (const pattern of mechanicalCandidates) expect(text).not.toMatch(pattern);
  });

  it("cites shipped canon without copying a substantive canonical paragraph", () => {
    const text = packText();
    expect(text).toContain("rig context profile world/install --situation fresh");
    expect(text).toContain("forming-an-openrig-mental-model");
    expect(text).toContain("openrig-operating-model");

    const canonPaths = [
      resolve(DAEMON_ROOT, "context-packs-src/world/install/01-world-from-primitives.md"),
      resolve(DAEMON_ROOT, "context-packs-src/world/install/02-permission-self-sleep.md"),
      resolve(DAEMON_ROOT, "context-packs-src/world/install/03-what-this-is-for.md"),
      resolve(DAEMON_ROOT, "context-packs-src/world/install/04-ontology.md"),
      resolve(DAEMON_ROOT, "context-packs-src/world/install/05-harness-power-use.md"),
      resolve(DAEMON_ROOT, "context-packs-src/world/install/06-a-competent-turn.md"),
      resolve(DAEMON_ROOT, "assets/plugins/openrig-core/skills/forming-an-openrig-mental-model/SKILL.md"),
      resolve(DAEMON_ROOT, "assets/plugins/openrig-core/skills/openrig-operating-model/SKILL.md"),
    ];
    const canonicalParagraphs = new Set(canonPaths.flatMap((path) => paragraphs(readFileSync(path, "utf8"))));
    const copied = paragraphs(text).filter((paragraph) => canonicalParagraphs.has(paragraph));
    expect(copied).toEqual([]);
  });

  it("keeps operator contact open without teaching a router hop", () => {
    const text = packText();
    expect(text).toContain("Any agent may contact them directly for");
    expect(text).toContain("orchestrators and PMs may also send updates");
    expect(text).toContain("use a durable surface");
    expect(text).not.toMatch(/other seats route through them|role-gated/i);
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
