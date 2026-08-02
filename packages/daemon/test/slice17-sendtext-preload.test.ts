// Slice 17 (OPR.0.4.7.17) — product-team send_text skill-preload action.
// The copied process skills weren't TRIGGERED in a bootstrapped rig (present on
// disk, never invoked; the conversation-start trigger doesn't fire on --resume).
// Fix (config-only, runtime-neutral): each of the five product-team AgentSpecs
// carries a send_text startup action that imperatively tells the seat to load +
// invoke its OWN process skills, on BOTH fresh_start and restore (idempotent), at
// phase after_ready. This pins the authored contract; QA proves OBSERVED
// invocation (not send-ok) firsthand on Claude + Codex, fresh and restore.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateStartupBlock } from "../src/domain/startup-validation.js";

const SPECS = fileURLToPath(new URL("../specs/", import.meta.url));

// The five product-team AgentSpecs (7 seats → 5 unique specs).
const IN_SCOPE = [
  "orchestration/orchestrator",
  "development/implementer",
  "development/qa",
  "design/product-designer",
  "review/independent-reviewer",
];

// Context/role skills are NOT the process discipline the action must preload.
const CONTEXT_SKILLS = new Set(["openrig-user", "mission-slice-sop"]);
const isProcessSkill = (s: string): boolean => !CONTEXT_SKILLS.has(s) && !s.endsWith("-team");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSkills(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj.skills)) return obj.skills as string[];
  for (const v of Object.values(obj)) {
    const r = findSkills(v);
    if (r.length) return r;
  }
  return [];
}

describe("Slice 17 — product-team send_text skill-preload action", () => {
  it.each(IN_SCOPE)("%s: send_text action, raw snake_case, names THIS seat's own process skills, validates clean", (spec) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = parseYaml(readFileSync(`${SPECS}agents/${spec}/agent.yaml`, "utf8")) as any;
    const action = raw.startup.actions[0];

    // Exact authored contract in RAW snake_case (a camelCase appliesOn would make
    // applies_on undefined → this fails; the false-green the plan warns about).
    expect(action.type).toBe("send_text");
    expect(action.phase).toBe("after_ready");
    expect(action.applies_on).toEqual(["fresh_start", "restore"]); // bug lives on resume → restore required
    expect(action.idempotent).toBe(true); // else validation errors on restore / orchestrator skips
    expect(typeof action.value).toBe("string");

    // Runtime-neutral: no hardcoded "Skill tool" (Codex has no such tool).
    expect(action.value).not.toMatch(/the Skill tool/i);
    expect(action.value.toLowerCase()).toContain("runtime");

    // Names THIS seat's OWN process skills (derived from its skills list, not hardcoded).
    const processSkills = findSkills(raw).filter(isProcessSkill);
    expect(processSkills.length).toBeGreaterThan(0);
    for (const skill of processSkills) expect(action.value).toContain(skill);

    // Validates clean through the real validator (restore-safe because idempotent).
    expect(validateStartupBlock(raw.startup, `${spec}.startup`)).toEqual([]);
  });

  it("regression pin: the raw key is snake_case applies_on (a camelCase appliesOn is silently ignored = false green)", () => {
    for (const spec of IN_SCOPE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = parseYaml(readFileSync(`${SPECS}agents/${spec}/agent.yaml`, "utf8")) as any;
      expect(raw.startup.actions[0].appliesOn).toBeUndefined();
      expect(raw.startup.actions[0].applies_on).toBeDefined();
    }
  });

  it("two differently-skilled seats prove per-seat naming (product-designer has no TDD; implementer does)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const designer = parseYaml(readFileSync(`${SPECS}agents/design/product-designer/agent.yaml`, "utf8")) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const impl = parseYaml(readFileSync(`${SPECS}agents/development/implementer/agent.yaml`, "utf8")) as any;
    expect(designer.startup.actions[0].value).not.toContain("test-driven-development");
    expect(designer.startup.actions[0].value).toContain("frontend-design");
    expect(impl.startup.actions[0].value).toContain("test-driven-development");
  });
});
