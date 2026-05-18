// Slice 09 — HG-8 drift-rule discipline.
//
// The convention's drift-recovery rule is: long-gap / day-boundary /
// observed-conflict → re-confirm (a QUESTION, never a silent switch).
// No signal→auto-mode path exists. v0 ships the
// `expiry_or_stale_rule` FIELD + a conservative default; downstream
// consumers READ it and prompt re-confirmation. The daemon NEVER
// auto-switches a binding.
//
// This file anchors that discipline at the slice source level:
//
//   1. Conservative default rule-kind is `re_confirm_on_long_gap`.
//   2. Validator rejects auto-switch-shaped rule values that aren't
//      in the closed enum.
//   3. The store NEVER mutates bindings during a read. resolveEffective
//      is pure — same binding, same setAt, repeatable.
//   4. Source grep: rig-policy domain code contains NO identifiers
//      that imply automatic mode-switching (auto-switch / auto-apply /
//      signal-based / etc.).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigPolicyStore } from "../src/domain/rig-policy/rig-policy-store.js";
import { DEFAULT_STALE_RULE } from "../src/domain/rig-policy/rig-policy-defaults.js";
import { STALE_RULES, type OperatorContextModeRecord } from "../src/domain/rig-policy/rig-policy-types.js";
import { validateRecord } from "../src/domain/rig-policy/rig-policy-validator.js";

function makeRecord(overrides?: Partial<OperatorContextModeRecord>): OperatorContextModeRecord {
  return {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "operator confirmed debug",
    ...overrides,
  };
}

describe("HG-8 drift-rule mechanism — convention §Component 4 + §Q3", () => {
  it("DEFAULT_STALE_RULE is the convention's conservative re-confirmation rule", () => {
    expect(DEFAULT_STALE_RULE).toBe("re_confirm_on_long_gap");
    expect(STALE_RULES).toContain(DEFAULT_STALE_RULE);
  });

  it("validator rejects auto-switch-shaped rule values not in the closed enum", () => {
    for (const auto of ["auto_switch", "auto_apply", "switch_on_long_gap", "silent_switch", "on_signal"]) {
      const res = validateRecord(makeRecord({ expiry_or_stale_rule: auto as unknown as OperatorContextModeRecord["expiry_or_stale_rule"] }));
      expect(res.ok, `value '${auto}' must be rejected`).toBe(false);
    }
  });

  it("validator accepts every member of STALE_RULES", () => {
    for (const rule of STALE_RULES) {
      const res = validateRecord(makeRecord({ expiry_or_stale_rule: rule }));
      expect(res.ok, `value '${rule}' must be accepted`).toBe(true);
    }
  });
});

describe("HG-8 — store reads NEVER mutate bindings (no silent switch path)", () => {
  let db: Database.Database;
  let store: RigPolicyStore;

  beforeEach(() => {
    db = createFullTestDb();
    store = new RigPolicyStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("resolveEffective is pure: repeated reads return the same binding (same setAt)", () => {
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));
    const r1 = store.resolveEffective({ qitemId: "q-1" });
    const r2 = store.resolveEffective({ qitemId: "q-1" });
    const r3 = store.resolveEffective({ qitemId: "q-1" });
    expect(r1).not.toBeNull();
    expect(r2!.binding.setAt).toBe(r1!.binding.setAt);
    expect(r3!.binding.setAt).toBe(r1!.binding.setAt);
    expect(r1!.binding.mode).toBe("debug");
    expect(r2!.binding.mode).toBe("debug");
  });

  it("getBinding is pure: repeated reads return the same record", () => {
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const first = store.getBinding("rig", "rig-a");
    const second = store.getBinding("rig", "rig-a");
    expect(first!.setAt).toBe(second!.setAt);
    expect(first!.record).toEqual(second!.record);
  });

  it("listBindings is pure: count and identities stable across reads", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const a = store.listBindings();
    const b = store.listBindings();
    expect(a.map((x) => x.id).sort()).toEqual(b.map((x) => x.id).sort());
    expect(a.map((x) => x.setAt)).toEqual(b.map((x) => x.setAt));
  });

  // Negative — auto-switch class. No code path in the slice domain
  // module mutates a binding's mode from a signal / timer / external
  // observation. This is the source-level discriminator for
  // "no silent switch path exists" (HG-8).
  it("HG-8 source grep: rig-policy domain code contains no auto-switch / auto-apply / signal-driven identifiers", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const domainDir = path.join(here, "..", "src", "domain", "rig-policy");
    const sources = ["rig-policy-types.ts", "rig-policy-validator.ts", "rig-policy-defaults.ts", "rig-policy-store.ts"];
    const combined = sources.map((f) => fs.readFileSync(path.join(domainDir, f), "utf-8")).join("\n");
    for (const forbidden of [
      "autoSwitch",
      "auto_switch",
      "autoApply",
      "auto_apply",
      "silentSwitch",
      "silent_switch",
      "onSignal",
      "on_signal",
      "fromSignal",
      "from_signal",
      "autoSetMode",
      "auto_set_mode",
    ]) {
      expect(combined.includes(forbidden), `forbidden token '${forbidden}' must not appear in rig-policy domain source`).toBe(false);
    }
  });
});
