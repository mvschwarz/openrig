import { composeDelivered, extractProofContract } from "../src/domain/review/compose.js";
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { evidenceAt } from "../src/domain/proof/judgments.js";
import { watchProofSources } from "../src/domain/proof/source-watch.js";
import type { EventBus } from "../src/domain/event-bus.js";
import { Hono } from "hono";
import { proofRoutes } from "../src/routes/proof.js";
import { readSliceReadiness, readMissionReadiness, readProjectReadiness, recordJudgment, type JudgeInput } from "../src/domain/proof/judgments.js";

const fixtures: string[] = [];
afterEach(() => { for (const p of fixtures.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "proof-judgment-")); fixtures.push(root);
  const missions = join(root, "missions"), mission = join(missions, "trial");
  const write = (p: string, data: string | object) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, typeof data === "string" ? data : YAML.stringify(data)); };
  write(join(root, "project.yaml"), { kind: "project", metadata: { id: "trial" }, proofPolicy: { judges: ["judge@trial"] }, missions: { root: "missions" } });
  const members = ["01-alpha", "02-beta"].map((s, i) => ({ ref: `slices/${s}/slice.yaml`, order: i + 1, active: true }));
  write(join(mission, "mission.yaml"), { kind: "mission", metadata: { name: "trial", status: "active" }, composition: { slices: members } });
  for (const [i, s] of ["01-alpha", "02-beta"].entries()) {
    const dir = join(mission, "slices", s);
    write(join(dir, "slice.yaml"), { kind: "slice", metadata: { id: s, status: "draft" }, execution: { depends_on: i ? ["01-alpha"] : [] } });
    write(join(dir, "SPEC.md"), `---\nid: ${s}\nstatus: done\n---\n# ${s}\n\n## Proof contract\n- [x] Prove ${s}.\n`);
    write(join(dir, "proof", "evidence.md"), `Observed outcome for ${s}.\n`);
  }
  const alpha = join(mission, "slices", "01-alpha"), beta = join(mission, "slices", "02-beta");
  function input(scope = "trial/slices/01-alpha", verdict: JudgeInput["verdict"] = "accept"): JudgeInput {
    const item = readSliceReadiness(join(missions, scope)).items[0]!;
    return { scope, item: item.id, verdict, reason: `Independent ${verdict} judgment`, evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: item.judgment?.id ?? null };
  }
  const judge = (v = input(), actor = "judge@trial") => recordJudgment(missions, v, actor, "transport:v1");
  return { root, missions, mission, alpha, beta, write, input, judge };
}

describe("attributed proof judgments and derived readiness", () => {
  it("lifts one verdict, corrects it, preserves siblings/history, and writes no ancestor status", () => {
    const f = fixture();
    const files = [join(f.root, "project.yaml"), join(f.mission, "mission.yaml"), join(f.alpha, "SPEC.md"), join(f.beta, "SPEC.md")];
    const before = files.map(p => fs.readFileSync(p, "utf8"));
    expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("pending"); // checked/done is not accepted
    const a = f.judge();
    expect(a.readiness.items[0]).toMatchObject({ state: "accepted", judgment: { actor: "judge@trial", verdict: "accept" } });
    expect(readMissionReadiness(f.mission).slices[1]!.eligible).toBe(true);
    const b = f.judge(f.input("trial/slices/02-beta"));
    expect(readProjectReadiness(f.missions).state).toBe("ready");
    const correction = f.judge(f.input(undefined, "reject"));
    expect(correction.judgment.previous).toBe(a.judgment.id);
    expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("rejected");
    expect(readMissionReadiness(f.mission).slices[1]!.eligible).toBe(false);
    expect(readProjectReadiness(f.missions).state).toBe("not-ready");
    expect(readSliceReadiness(f.beta).revision).toBe(b.readiness.revision);
    expect(files.map(p => fs.readFileSync(p, "utf8"))).toEqual(before);
    expect(fs.readFileSync(join(f.alpha, "proof/judgments/00000001.md"), "utf8")).toContain(a.judgment.id);
  });
  it("rejects unauthorized actors, wrong revisions and missing evidence without a receipt", () => {
    const f = fixture();
    expect(() => f.judge(f.input(), "other@trial")).toThrow("not a judge");
    expect(() => f.judge({ ...f.input(), expectedRevision: "old" })).toThrow("Item or correction changed");
    expect(() => f.judge({ ...f.input(), evidence: ["missing.md"] })).toThrow("unavailable");
    expect(fs.existsSync(join(f.alpha, "proof/judgments"))).toBe(false);
  });
  it("replays lost responses exactly, refuses conflicting corrections and retains newer truth", () => {
    const f = fixture(), request = f.input();
    const first = f.judge(request);
    expect(f.judge(request).judgment).toEqual(first.judgment);
    const reject = f.input(undefined, "reject"), competing = { ...reject, verdict: "withdraw" as const };
    const rejected = f.judge(reject);
    expect(() => f.judge(competing)).toThrow("Item or correction changed");
    const replay = f.judge(request);
    expect(replay.judgment.id).toBe(first.judgment.id);
    expect(replay.readiness.items[0]!.judgment!.id).toBe(rejected.judgment.id);
    expect(replay.readiness.items[0]!.state).toBe("rejected");
    expect(() => f.judge({ ...f.input(), operationId: rejected.judgment.operationId })).toThrow("different contents");
  });
  it("withdraws without the lost evidence, invalidates item/policy changes, and allows deliberate reaffirmation", () => {
    const f = fixture(), first = f.judge();
    fs.unlinkSync(join(f.alpha, "proof/evidence.md"));
    expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("unknown");
    const withdrawn = f.judge({ ...f.input(undefined, "withdraw"), evidence: undefined });
    expect(withdrawn.readiness.items[0]!.state).toBe("withdrawn");
    f.write(join(f.alpha, "proof/evidence.md"), "Observed outcome for 01-alpha.\n");
    const restored = f.judge({ ...f.input(), replace: true });
    expect(restored.judgment.id).not.toBe(first.judgment.id);
    const spec = join(f.alpha, "SPEC.md"); f.write(spec, fs.readFileSync(spec, "utf8").replace("Prove 01-alpha.", "A materially different promise."));
    expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("pending");
    expect(readSliceReadiness(f.alpha).state).not.toBe("ready");
  });
  it("rebuilds from retained receipts, ignores incomplete unpublished temp bytes, and fails visibly on damaged receipts", () => {
    const f = fixture(), accepted = f.judge();
    f.write(join(f.alpha, "proof/judgments/.write-crashed"), "incomplete temp");
    expect(readSliceReadiness(f.alpha).revision).toBe(accepted.readiness.revision);
    const receipt = join(f.alpha, "proof/judgments/00000001.md");
    f.write(receipt, fs.readFileSync(receipt, "utf8").replace("verdict: accept", "verdict: reject"));
    const current = readSliceReadiness(f.alpha);
    expect(current.state).toBe("unknown"); expect(current.issues.join()).toContain("changed judgment");
    expect(() => f.judge()).toThrow();
  });
  it("adopts non-code and referenced patch equivalence without a synthetic commit or registry", () => {
    const f = fixture();
    const noncode = f.judge();
    expect(noncode.judgment.subject.kind).toBe("artifact");
    f.write(join(f.beta, "proof/comparison.md"), "The adopted patch has the same observed behavior; paths and actual comparison are retained here.");
    const input = { ...f.input("trial/slices/02-beta"), subject: { kind: "patch-equivalent" as const, ref: "adopted-patch" } };
    expect(() => f.judge(input)).toThrow("comparison");
    const accepted = f.judge({ ...input, subject: { ...input.subject, comparison: "proof/comparison.md" }, evidence: ["proof/evidence.md"] });
    expect(accepted.readiness.state).toBe("ready");
    expect(accepted.judgment.evidence.map(e => e.ref)).toEqual(["missions/trial/slices/02-beta/proof/evidence.md", "missions/trial/slices/02-beta/proof/comparison.md"]);
  });
  it("enforces the existing transport identity precedence through the public route", async () => {
    const f = fixture(), app = new Hono();
    app.use("*", async (c, next) => { c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: f.missions, invalidate: () => {} } as never); await next(); });
    app.route("/api/proof", proofRoutes());
    const post = (actor: string, body: unknown) => app.request("/api/proof/judge", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor }, body: JSON.stringify(body) });
    const rejected = await post("other@trial", { ...f.input(), actorSession: "judge@trial" });
    expect(rejected.status).toBe(403);
    const accepted = await post("judge@trial", { ...f.input(), actorSession: "other@trial" });
    expect(accepted.status).toBe(201);
    const receipt = await accepted.json();
    const read = await (await app.request("/api/proof?scope=trial/slices/01-alpha")).json();
    expect(read.revision).toBe(receipt.readiness.revision);
    expect(read.items[0].judgment.actor).toBe("judge@trial");
  });
});


describe("retained authority negative controls", () => {
  it("invalidates policy and new children while preserving sibling and publication history", () => {
    const f = fixture(); f.judge(); f.judge(f.input("trial/slices/02-beta"));
    const history = join(f.mission, "publication-receipt.md"); f.write(history, "Published historical cut, unchanged.\n");
    const sibling = readSliceReadiness(f.beta);
    f.write(join(f.alpha, "slice.yaml"), { proofPolicy: { judges: ["new-judge@trial"] } });
    expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("unknown");
    expect(readSliceReadiness(f.beta).revision).toBe(sibling.revision);
    expect(() => f.judge()).toThrow("not a judge");
    const doc = YAML.parse(fs.readFileSync(join(f.mission, "mission.yaml"), "utf8"));
    doc.composition.slices.push({ ref: "slices/03-new/slice.yaml", order: 3, active: true });
    f.write(join(f.mission, "slices/03-new/slice.yaml"), { metadata: { id: "03-new" } });
    f.write(join(f.mission, "slices/03-new/SPEC.md"), "## Proof contract\n- [x] New outcome.\n");
    f.write(join(f.mission, "mission.yaml"), doc);
    const current = readMissionReadiness(f.mission);
    expect(current.slices.find(s => s.scope === "03-new")!.readiness.items[0]!.state).toBe("pending");
    expect(current.state).not.toBe("ready");
    expect(fs.readFileSync(history, "utf8")).toBe("Published historical cut, unchanged.\n");
    f.write(join(f.alpha, "slice.yaml"), { proofPolicy: { judges: "malformed" } });
    expect(readSliceReadiness(f.alpha)).toMatchObject({ configured: true, state: "unknown" });
  });
  it("propagates transitive eligibility and detects a cycle beyond a pending edge", () => {
    const f = fixture(); f.judge(f.input("trial/slices/02-beta"));
    const doc = YAML.parse(fs.readFileSync(join(f.mission, "mission.yaml"), "utf8"));
    doc.composition.slices.push({ ref: "slices/03-new/slice.yaml", order: 3, active: true });
    f.write(join(f.mission, "slices/03-new/slice.yaml"), { execution: { depends_on: ["02-beta"] } });
    f.write(join(f.mission, "slices/03-new/SPEC.md"), "## Proof contract\n- [ ] New outcome.\n");
    f.write(join(f.mission, "mission.yaml"), doc);
    expect(readMissionReadiness(f.mission).slices.find(s => s.scope === "03-new")!.eligible).toBe(false);
    f.write(join(f.beta, "slice.yaml"), { execution: { depends_on: ["01-alpha", "03-new"] } });
    const cycle = readMissionReadiness(f.mission);
    expect(cycle.state).toBe("unknown"); expect(cycle.issues.join()).toContain("Cycle");
  });
  it("binds binary/addressed bytes and refuses changed preparation or nonexistent sections", () => {
    const f = fixture(); fs.writeFileSync(join(f.alpha, "proof/binary.bin"), Buffer.from([0xff, 0x00, 0x80]));
    const refs = ["proof/binary.bin"], prepared = refs.map(ref => evidenceAt(f.root, f.alpha, ref));
    expect(f.judge({ ...f.input(), evidence: refs, expectedEvidence: prepared }).readiness.state).toBe("ready");
    fs.writeFileSync(join(f.alpha, "proof/binary.bin"), Buffer.from([0xff, 0x01, 0x80]));
    expect(() => f.judge({ ...f.input(), evidence: refs, expectedEvidence: prepared })).toThrow("changed since preparation");
    expect(readSliceReadiness(f.alpha).state).toBe("unknown");
    f.write(join(f.alpha, "proof/sections.md"), "## Actual\nObserved comparison.\n");
    expect(() => f.judge({ ...f.input(), evidence: ["proof/sections.md#invented"] })).toThrow("matches no header");
    expect(f.judge({ ...f.input(), evidence: ["proof/sections.md#actual"] }).readiness.state).toBe("ready");
  });
  it("invalidates the changed addressed evidence without invalidating an unrelated section's acceptance", () => {
    const f = fixture(), shared = join(f.root, "shared.md");
    f.write(shared, "## Alpha\nFirst outcome.\n## Beta\nSecond outcome.\n");
    f.judge({ ...f.input(), evidence: [`${shared}#alpha`] });
    const beta = f.judge({ ...f.input("trial/slices/02-beta"), evidence: [`${shared}#beta`] });
    f.write(shared, "## Alpha\nChanged first outcome.\n## Beta\nSecond outcome.\n");
    expect(readSliceReadiness(f.alpha).state).toBe("unknown");
    expect(readSliceReadiness(f.beta).revision).toBe(beta.readiness.revision);
  });
  it("preserves explicit identity across edits without accepting the changed promise", () => {
    const f = fixture(), spec = join(f.alpha, "SPEC.md");
    f.write(spec, "## Proof contract\n- [ ] First promise. <!-- proof-item: stable -->\n");
    const first = f.judge();
    f.write(spec, "## Proof contract\n- [ ] Changed promise. <!-- proof-item: stable -->\n");
    const item = readSliceReadiness(f.alpha).items[0]!;
    expect(item.id).toBe("stable"); expect(item.state).toBe("unknown"); expect(item.judgment!.id).toBe(first.judgment.id);
    expect(f.judge().judgment.previous).toBe(first.judgment.id);
  });
  it("refuses escaped scope/evidence paths before publishing a receipt", () => {
    const f = fixture(), outside = fs.mkdtempSync(join(tmpdir(), "proof-outside-")); fixtures.push(outside);
    fs.writeFileSync(join(outside, "evidence.md"), "outside boundary");
    fs.symlinkSync(outside, join(f.alpha, "proof/outside"));
    expect(() => f.judge({ ...f.input(), evidence: ["proof/outside/evidence.md"] })).toThrow("escapes");
    expect(() => f.judge({ ...f.input(), scope: "../../" })).toThrow("within");
    expect(fs.existsSync(join(f.alpha, "proof/judgments"))).toBe(false);
  });
  it("does not adopt a copied receipt as judgment on another scope with the same promise", () => {
    const f = fixture();
    f.write(join(f.beta, "SPEC.md"), fs.readFileSync(join(f.alpha, "SPEC.md"), "utf8"));
    f.judge();
    f.write(join(f.beta, "proof/judgments/00000001.md"), fs.readFileSync(join(f.alpha, "proof/judgments/00000001.md"), "utf8"));
    expect(readSliceReadiness(f.beta).items[0]!.state).toBe("unknown");
  });
  /**
   * Verifies that mission readiness resolves composition slices when metadata is omitted (#72),
   * while rejecting malformed metadata values.
   */
  it("tolerates mission without metadata and resolves composition slices (#72)", () => {
    const f = fixture();
    const members = ["01-alpha", "02-beta"].map((s, i) => ({ ref: `slices/${s}/slice.yaml`, order: i + 1, active: true }));
    f.write(join(f.mission, "mission.yaml"), { kind: "mission", composition: { slices: members } });
    const readiness = readMissionReadiness(f.mission);
    expect(readiness.issues).toEqual([]);
    expect(readiness.slices.map(s => s.id)).toEqual(["01-alpha", "02-beta"]);
    expect(readiness.historicalStatus).toBeNull();
    f.write(join(f.mission, "mission.yaml"), { kind: "mission", metadata: "not-a-mapping", composition: { slices: members } });
    const invalid = readMissionReadiness(f.mission);
    expect(invalid.issues).toContain("mission metadata: expected a mapping");
  });
  it("invalidates proof sources when only mission status changes", async () => {
    const f = fixture();
    const manifest = join(f.mission, "mission.yaml");
    const original = fs.readFileSync(manifest, "utf8");
    const before = readMissionReadiness(f.mission);
    const sliceRevision = readSliceReadiness(f.alpha).revision;
    const events: Array<{ type: string; revision: string }> = [];
    let invalidated = 0;
    const watch = watchProofSources(f.missions, () => { invalidated++; }, {
      emit: (event: { type: string; revision: string }) => events.push(event),
    } as unknown as EventBus);
    try {
      f.write(manifest, original.replace("status: active", "status: draft"));
      const after = readMissionReadiness(f.mission);
      expect(after.historicalStatus).toBe("draft");
      expect(after.revision).not.toBe(before.revision);
      await expect.poll(() => events.length, { timeout: 5000 }).toBe(1);
      expect(events[0]!.type).toBe("proof.sources_changed");
      expect(invalidated).toBe(1);
      expect(readSliceReadiness(f.alpha).revision).toBe(sliceRevision);
      const changed = watch.observation().revision;
      fs.writeFileSync(manifest, fs.readFileSync(manifest));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events).toHaveLength(1);
      expect(watch.observation().revision).toBe(changed);
    } finally { watch.close(); }
  });
  it("pushes changed source truth, keeps sibling basis, and ignores unchanged source bytes", async () => {
    const f = fixture(); f.judge(); const sibling = readSliceReadiness(f.beta).revision;
    const events: Array<{ type: string; revision: string }> = []; let invalidated = 0;
    const watch = watchProofSources(f.missions, () => { invalidated++; }, { emit: (e: { type: string; revision: string }) => events.push(e) } as unknown as EventBus);
    try {
      const file = join(f.alpha, "proof/evidence.md"); fs.writeFileSync(file, fs.readFileSync(file));
      await new Promise(r => setTimeout(r, 100)); expect(events).toEqual([]);
      fs.writeFileSync(file, "Measured outcome changed.\n");
      await expect.poll(() => events.length, { timeout: 5000 }).toBe(1);
      expect(events[0]!.type).toBe("proof.sources_changed"); expect(invalidated).toBe(1);
      expect(readSliceReadiness(f.alpha).state).toBe("unknown"); expect(readSliceReadiness(f.beta).revision).toBe(sibling);
    } finally { watch.close(); }
  });
});

async function worker(f: ReturnType<typeof fixture>, input: JudgeInput, crash: "before" | "after" | "stale-read" | null = null) {
  const module = new URL("../src/domain/proof/judgments.ts", import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const crash = ${JSON.stringify(crash)}, original = fs.linkSync;
    if (crash === "stale-read") {
      let reads = 0; const originalRead = fs.readdirSync;
      fs.readdirSync = (...args) => {
        if (String(args[0]).endsWith("/proof/judgments") && ++reads === 2) { process.send({ stopped: crash }); process.kill(process.pid, "SIGSTOP"); }
        return originalRead(...args);
      }; syncBuiltinESMExports();
    }
    if (crash === "before" || crash === "after") { fs.linkSync = (...args) => {
      if (crash === 'after') original(...args);
      process.send({ stopped: crash }); process.kill(process.pid, 'SIGSTOP');
    }; syncBuiltinESMExports(); }
    const { recordJudgment } = await import(${JSON.stringify(module)});
    process.on('message', () => {
      try { process.send({ result: recordJudgment(${JSON.stringify(f.missions)}, ${JSON.stringify(input)}, 'judge@trial', 'test-worker') }); }
      catch(e) { process.send({ error: e.code, message: e.message }); }
      if (!crash) process.disconnect();
    }); process.send({ ready: true });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  await once(child, "message"); return child;
}
async function request(child: ChildProcess) {
  const reply = once(child, "message"); child.send!("go"); return (await reply)[0];
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
describe("real process publication and recovery", () => {
  it("publishes one concurrent correction and replays duplicate acceptance safely", async () => {
    const f = fixture(), first = f.judge(), a = await worker(f, f.input(undefined, "reject")), b = await worker(f, f.input(undefined, "withdraw"));
    try {
      const replies = await Promise.all([request(a), request(b)]), winner = replies.find(r => r.result)!.result;
      expect(replies.find(r => r.error)!.error).toBe("revision_conflict");
      expect(winner.judgment.previous).toBe(first.judgment.id);
      expect(readSliceReadiness(f.alpha).items[0]!.judgment!.id).toBe(winner.judgment.id);
      const input = { ...f.input(), replace: true }, c = await worker(f, input), d = await worker(f, input);
      try {
        const duplicates = await Promise.all([request(c), request(d)]), receipt = duplicates.find(r => r.result)!.result.judgment;
        expect(f.judge(input).judgment.id).toBe(receipt.id);
        expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("accepted");
        for (const reply of duplicates) if (reply.result) expect(reply.result.judgment.id).toBe(receipt.id); else expect(reply.error).toBe("revision_conflict");
      } finally { await kill(c); await kill(d); }
    } finally { await kill(a); await kill(b); }
  });
  it("refuses a correction that races between the initial view and the publication scan", async () => {
    const f = fixture(); f.judge();
    const child = await worker(f, f.input(undefined, "reject"), "stale-read");
    try {
      expect(await request(child)).toEqual({ stopped: "stale-read" });
      const intervening = f.judge(f.input(undefined, "withdraw"));
      const reply = once(child, "message"); child.kill("SIGCONT");
      expect((await reply)[0].error).toBe("revision_conflict");
      expect(readSliceReadiness(f.alpha).items[0]!.judgment!.id).toBe(intervening.judgment.id);
      expect(readSliceReadiness(f.alpha).items[0]!.state).toBe("withdrawn");
    } finally { await kill(child); }
  });
  for (const crash of ["before", "after"] as const) it(`recovers SIGKILL ${crash} immutable publication in a fresh process`, async () => {
    const f = fixture(), input = f.input(), child = await worker(f, input, crash);
    expect(await request(child)).toEqual({ stopped: crash }); await kill(child);
    const prior = readSliceReadiness(f.alpha);
    expect(prior.items[0]!.state).toBe(crash === "before" ? "pending" : "accepted");
    const restarted = await worker(f, input);
    try {
      const reply = await request(restarted);
      expect(reply.result.replayed).toBe(crash === "after"); expect(reply.result.readiness.items[0].state).toBe("accepted");
      if (crash === "after") expect(reply.result.readiness.revision).toBe(prior.revision);
    } finally { await kill(restarted); }
  });
});


describe("selected proof identity across readers", () => {
  it("keeps same-worded IDs independent through acceptance, correction and reorder", () => {
    const f = fixture();
    const rows = ["- [ ] Repeated outcome. <!-- proof-item: a -->", "- [ ] Repeated outcome. <!-- proof-item: b -->"];
    f.write(join(f.alpha, "SPEC.md"), "## Proof contract\n" + rows.join("\n") + "\n");
    const act = (id: string, verdict: "accept" | "reject") => {
      const item = readSliceReadiness(f.alpha).items.find(i => i.id === id)!;
      return f.judge({ ...f.input(), item: id, expectedRevision: item.revision, expectedPrevious: item.judgment?.id ?? null, verdict, reason: `${id} ${verdict}` });
    };
    const view = () => composeDelivered(extractProofContract(fs.readFileSync(join(f.alpha, "SPEC.md"), "utf8")), [], readSliceReadiness(f.alpha)).items;
    act("a", "accept");
    expect(view().map(i => i.verified)).toEqual(["verified", "missing"]);
    expect(view()[1]!.note).not.toContain("a accept");
    act("b", "accept");
    expect(view().map(i => i.verified)).toEqual(["verified", "verified"]);
    act("a", "reject");
    expect(view().map(i => i.verified)).toEqual(["unverified", "verified"]);
    expect(view()[1]!.note).toContain("b accept");
    f.write(join(f.alpha, "SPEC.md"), "## Proof contract\n" + rows.reverse().join("\n") + "\n");
    expect(view().map(i => i.verified)).toEqual(["verified", "unverified"]);
  });
});
