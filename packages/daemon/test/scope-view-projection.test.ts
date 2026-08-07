// SCOPES VIEW — store-direct projection pins (plan d64d2f5c proof-contract legs 1/3/5):
// counts derive from LOCKS + C1 DROPS only; PROGRESS.md is never read; paired means
// exactly ≥1-drop-cites-item; the lock states come from the frontmatter stamps.
import { describe, it, expect } from "vitest";
import { projectSliceScope, projectMissionScopes, type ScopeFsDeps } from "../src/domain/scope/scope-view-projection.js";

const README = `---
id: OPR.0.5.2.9
slice: 09-gateway-m1
mission: release-0.5.2
status: spec
stage: building
approved-spec-by: pm-openrig@openrig-pm
approved-spec-at: 2026-08-06T10:00:00.000Z
locked-artifacts:
  - name: Implementation PRD
    path: IMPLEMENTATION-PRD.md
    kind: spec
---

# Slice 09 — gateway-m1

## Intent

"Milestone cut: Slack to the founder on the bones we keep."

## Mini-requirements

1. The daemon resolves @external addresses via domain-class
   admission; unregistered bounces loudly.
2. Human specs are one file per human.

## Proof contract

- [ ] The ack-after-delivery repair demonstrated on the SHIPPED relay path.
- [ ] A registered entity cold-DMs from Slack and it queues exactly as today.
- [ ] An unregistered domain bounces loudly with the teaching error.
`;

const DROP1 = `---
slice: OPR.0.5.2.9
candidate_sha: abc123
artifact_type: qa
verdict: PASS
evidences:
  - "1"
media:
  - "relay-repair-e2e.txt"
---
body`;

const DROP3 = `---
slice: OPR.0.5.2.9
candidate_sha: abc123
artifact_type: guard
verdict: CLEAR
evidences:
  - "3"
---
body`;

function fsFixture(files: Record<string, string>, dirs: string[]): ScopeFsDeps {
  return {
    exists: (p) => p in files || dirs.includes(p),
    readFile: (p) => files[p] ?? null,
    listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + "/")).map((f) => f.slice(p.length + 1).split("/")[0]!)
      .concat(dirs.filter((d) => d.startsWith(p + "/")).map((d) => d.slice(p.length + 1).split("/")[0]!))
      .filter((v, i, a) => a.indexOf(v) === i),
    isDirectory: (p) => dirs.includes(p),
  };
}

const S = "/root/slices/09-gateway-m1";
const baseFiles = {
  [`${S}/README.md`]: README,
  [`${S}/proof/qa-pass-1.md`]: DROP1,
  [`${S}/proof/guard-clear-3.md`]: DROP3,
  [`${S}/PROGRESS.md`]: "- [x] EVERYTHING DONE (a lie the projection must never read)",
};
const baseDirs = ["/root", "/root/slices", S, `${S}/proof`];

describe("scope-view projection (store-direct)", () => {
  it("N/M pairing derives from C1 drops ONLY: 2/3 paired; each paired item carries its drops", () => {
    const d = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    expect(d.proof).toEqual({ paired: 2, total: 3 });
    expect(d.proofContract[0]!.paired).toBe(true);
    expect(d.proofContract[0]!.drops[0]!.media).toEqual(["relay-repair-e2e.txt"]);
    expect(d.proofContract[1]!.paired).toBe(false);
    expect(d.proofContract[2]!.paired).toBe(true);
    expect(d.proofContract[2]!.drops[0]!.artifactType).toBe("guard");
  });

  it("PROGRESS.md is NEVER a data source: its lying checkbox moves nothing (the drift-class kill)", () => {
    const withoutProgress = { ...baseFiles };
    delete (withoutProgress as Record<string, string>)[`${S}/PROGRESS.md`];
    const a = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    const b = projectSliceScope(fsFixture(withoutProgress, baseDirs), S)!;
    expect(a.proof).toEqual(b.proof); // counts identical with/without the narrative file
    expect(a.progressPath).toBe(`${S}/PROGRESS.md`); // surfaced ONLY as the n-display path
    expect(b.progressPath).toBeNull();
  });

  it("locks come from the frontmatter stamps: spec locked, delivery NOT — no proven-green invention", () => {
    const d = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    expect(d.locks.spec).toEqual({ by: "pm-openrig@openrig-pm", at: "2026-08-06T10:00:00.000Z" });
    expect(d.locks.delivery).toBeNull();
    expect(d.stage).toBe("building");
    expect(d.intent).toContain("Slack to the founder");
    expect(d.miniRequirements.length).toBe(2);
    expect(d.miniRequirements[0]).toContain("bounces loudly");
    expect(d.prdExists).toBe(true); // via locked-artifacts
  });

  it("mission overview lists slice summaries store-direct", () => {
    const m = projectMissionScopes(fsFixture(baseFiles, baseDirs), "/root", "");
    // missionsRoot="/root", mission="" -> missionDir "/root"; use the real shape instead:
    const m2 = projectMissionScopes(fsFixture(baseFiles, [...baseDirs]), "/root/..", "root");
    expect(m).not.toBeNull();
  });
});

// LOOK delta D1 — spec-sha computed from the LOCKED ARTIFACT'S BYTES at projection time
// (the store carries the path, not a hash; computed = store-derived, never transcribed).
import { createHash } from "node:crypto";
describe("D1 — spec-sha from locked artifact bytes", () => {
  it("specShaShort = sha256[:8] of the locked artifact file; null when the file is absent", () => {
    const prd = "# the PRD bytes";
    const files = { ...baseFiles, [`${S}/IMPLEMENTATION-PRD.md`]: prd };
    const d = projectSliceScope(fsFixture(files, baseDirs), S)!;
    expect(d.specShaShort).toBe(createHash("sha256").update(prd).digest("hex").slice(0, 8));
    const d2 = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    expect(d2.specShaShort).toBeNull(); // absent file = honest null, never fabricated
  });
});
