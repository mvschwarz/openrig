// #2765: a proof policy that names several judges keeps its shipped meaning by default (the item's latest judgment from
// any listed judge decides it), and can require every listed judge with `everyJudge: true`. Either way readiness shows
// each judge's own latest judgment, and a policy without the opt-in keeps the revisions earlier judgments were bound to.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { readSliceReadiness, recordJudgment, type JudgeInput } from "../src/domain/proof/judgments.js";

const R1 = "review-r1@trial", R2 = "review-r2@trial";
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fixtures: string[] = [];
afterEach(() => { for (const p of fixtures.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

function fixture(policy: Record<string, unknown> = { judges: [R1, R2] }) {
  const root = fs.mkdtempSync(join(tmpdir(), "proof-every-judge-")); fixtures.push(root);
  const missions = join(root, "missions"), slice = join(missions, "trial", "slices", "01-alpha");
  const write = (p: string, data: string | object) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, typeof data === "string" ? data : YAML.stringify(data)); };
  const project = (proofPolicy: Record<string, unknown>) =>
    write(join(root, "project.yaml"), { kind: "project", metadata: { id: "trial" }, proofPolicy, missions: { root: "missions" } });
  project(policy);
  write(join(missions, "trial", "mission.yaml"), { kind: "mission", metadata: { name: "trial", status: "active" }, composition: { slices: [{ ref: "slices/01-alpha/slice.yaml", order: 1, active: true }] } });
  write(join(slice, "slice.yaml"), { kind: "slice", metadata: { id: "01-alpha", status: "draft" } });
  write(join(slice, "SPEC.md"), "---\nid: 01-alpha\n---\n# 01-alpha\n\n## Proof contract\n- [ ] Prove 01-alpha.\n");
  for (const actor of [R1, R2]) write(join(slice, "proof", `${actor}.md`), `Observed by ${actor}.\n`);
  // As `rig proof judge` does: the current revision, and the item's latest judgment as the expected predecessor.
  const judge = (actor: string, verdict: JudgeInput["verdict"], replace = false) => {
    const item = readSliceReadiness(slice).items[0]!;
    return recordJudgment(missions, { scope: "trial/slices/01-alpha", item: item.id, verdict, reason: `${actor} ${verdict}`,
      evidence: [`proof/${actor}.md`], expectedRevision: item.revision, expectedPrevious: item.judgment?.id ?? null, replace }, actor, "transport:v1");
  };
  const read = () => readSliceReadiness(slice);
  return { slice, judge, read, project, write };
}

describe("#2765 everyJudge: every listed judge must accept", () => {
  const every = { judges: [R1, R2], everyJudge: true };

  it("one judge's accept doesn't make the item ready while the other has no judgment", () => {
    const f = fixture(every);
    f.judge(R1, "accept");
    const one = f.read();
    expect(one.items[0]).toMatchObject({ state: "pending", reason: `Waiting on ${R2}` });
    expect(one.state).toBe("not-ready");
    f.judge(R2, "accept");
    expect(f.read().items[0]).toMatchObject({ state: "accepted", reason: `Accepted by every judge: ${R1}, ${R2}` });
    expect(f.read().state).toBe("ready");
  });

  it("a later accept by one judge doesn't override the other's reject, and a withdraw doesn't hide it", () => {
    const f = fixture(every);
    f.judge(R2, "reject");
    f.judge(R1, "accept");
    expect(f.read().items[0]).toMatchObject({ state: "rejected", reason: `${R2}: ${R2} reject` });
    expect(f.read().state).toBe("not-ready");
    f.judge(R1, "withdraw");
    expect(f.read().items[0]!.state).toBe("rejected");
    f.judge(R2, "accept");
    expect(f.read().items[0]).toMatchObject({ state: "withdrawn", reason: `${R1}: ${R1} withdraw` });
    // Reaffirming an earlier accept after a later correction is a deliberate --replace, as `rig proof judge` documents.
    f.judge(R1, "accept", true);
    expect(f.read().state).toBe("ready");
  });

  it("one judge's stale evidence reads unknown, whatever the other judge accepted", () => {
    const f = fixture(every);
    f.judge(R1, "accept");
    f.judge(R2, "accept");
    f.write(join(f.slice, "proof", `${R2}.md`), "Changed after the judgment.\n");
    const read = f.read();
    expect(read.items[0]).toMatchObject({ state: "unknown", reason: `${R2}: Evidence missing or changed; inspect the retained judgment` });
    expect(read.state).toBe("unknown");
  });

  it("shows each judge's own latest judgment, and every one of them decides", () => {
    const f = fixture(every);
    f.judge(R2, "reject");
    f.judge(R1, "accept");
    expect(f.read().items[0]!.judges).toEqual([
      { actor: R1, state: "accepted", reason: `${R1} accept`, sequence: 2, decides: true },
      { actor: R2, state: "rejected", reason: `${R2} reject`, sequence: 1, decides: true },
    ]);
    // `judgment` stays the item's latest receipt, which corrections chain on.
    expect(f.read().items[0]!.judgment!.actor).toBe(R1);
  });
});

describe("#2765 the default: the item's latest judgment from any listed judge decides", () => {
  it("keeps the shipped meaning: a later accept decides, and a later reject or withdraw still changes readiness", () => {
    const f = fixture();
    f.judge(R2, "reject");
    f.judge(R1, "accept");
    expect(f.read().items[0]).toMatchObject({ state: "accepted", reason: `${R1} accept` });
    expect(f.read().state).toBe("ready");
    f.judge(R1, "withdraw");
    expect(f.read().items[0]!.state).toBe("withdrawn");
  });

  it("shows each judge's own latest judgment, marking only the deciding one", () => {
    const f = fixture();
    f.judge(R2, "reject");
    f.judge(R1, "accept");
    expect(f.read().items[0]!.judges).toEqual([
      { actor: R1, state: "accepted", reason: `${R1} accept`, sequence: 2, decides: true },
      { actor: R2, state: "rejected", reason: `${R2} reject`, sequence: 1, decides: false },
    ]);
    const fresh = fixture();
    expect(fresh.read().items[0]!.judges).toEqual([
      { actor: R1, state: "pending", reason: "No judgment from this judge", sequence: null, decides: false },
      { actor: R2, state: "pending", reason: "No judgment from this judge", sequence: null, decides: false },
    ]);
  });

  it("keeps the revisions earlier judgments were bound to: policy, item and readiness hash as they did before", () => {
    const f = fixture();
    f.judge(R1, "accept");
    const read = f.read(), item = read.items[0]!;
    const policyRevision = sha([R1, R2].sort());
    expect(read.policy).toMatchObject({ judges: [R1, R2], everyJudge: false, revision: policyRevision });
    // The scope is the slice path from the project root, as recorded on every receipt.
    expect(item.revision).toBe(sha(["missions/trial/slices/01-alpha", item.id, item.text, policyRevision]));
    expect(item.judgment).toMatchObject({ policyRevision, itemRevision: item.revision });
    // The readiness revision hashes what it always did: the per-judge view is left out.
    const { judges: _judges, ...asBefore } = item;
    expect(read.revision).toBe(sha([policyRevision, [asBefore], []]));
    // An explicit `everyJudge: false` is the default, with the same revisions.
    f.project({ judges: [R1, R2], everyJudge: false });
    expect(f.read().policy!.revision).toBe(policyRevision);
    expect(f.read().items[0]!.state).toBe("accepted");
  });

  it("an address listed twice for one seat (the 0.6.0 shape) still lets either address decide", () => {
    const alias = `${R1}@host-1`;
    const f = fixture({ judges: [R1, alias] });
    f.write(join(f.slice, "proof", `${R1}.md`), "Observed.\n");
    f.judge(R1, "accept");
    expect(f.read().state).toBe("ready");
  });
});

describe("#2765 switching a policy's mode", () => {
  it("turning everyJudge on binds the new meaning: judgments recorded before read unknown until judged again", () => {
    const f = fixture();
    f.judge(R1, "accept");
    expect(f.read().state).toBe("ready");
    f.project({ judges: [R1, R2], everyJudge: true });
    const switched = f.read();
    expect(switched.policy!.revision).not.toBe(sha([R1, R2].sort()));
    expect(switched.items[0]).toMatchObject({ state: "unknown", reason: `${R1}: Scope, item or policy changed; record a judgment on the current revision` });
    expect(switched.state).toBe("unknown");
    // Turning it off again restores the default's revision, and the earlier judgment is current again.
    f.project({ judges: [R1, R2] });
    expect(f.read().state).toBe("ready");
  });

  it("refuses an everyJudge that isn't true or false, as it refuses any other policy key", () => {
    const f = fixture({ judges: [R1, R2], everyJudge: "yes" });
    expect(f.read().issues.join("\n")).toContain("proofPolicy.everyJudge must be true or false");
    expect(f.read().state).toBe("unknown");
    const other = fixture({ judges: [R1, R2], quorum: 2 });
    expect(other.read().issues.join("\n")).toContain("proofPolicy supports judges and everyJudge only");
  });
});
