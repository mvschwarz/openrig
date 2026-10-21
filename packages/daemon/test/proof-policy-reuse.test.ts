import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import YAML from "yaml";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { scopesRoutes } from "../src/routes/scopes.js";
import { createProofPolicyRead, proofFs, evidenceAt, recordJudgment, readSliceReadiness, readMissionReadiness, readProjectReadiness, type JudgeInput } from "../src/domain/proof/judgments.js";
import { watchProofSources } from "../src/domain/proof/source-watch.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { ScopeFsDeps } from "../src/domain/scope/scope-view-projection.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), watch: vi.fn(actual.watch) };
});

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "policy-reuse-"))); roots.push(root);
  const missions = path.join(root, "missions"), mission = path.join(missions, "trial");
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : YAML.stringify(value));
  };
  const projectFile = path.join(root, "project.yaml"), missionFile = path.join(mission, "mission.yaml");
  write(projectFile, { proofPolicy: { judges: ["judge@trial"] } });
  const dirs = Array.from({ length: 8 }, (_, i) => path.join(mission, "slices", `slice-${i}`));
  write(missionFile, { kind: "mission", metadata: { status: "active" }, composition: { slices: dirs.map((d, order) => ({ ref: `slices/${path.basename(d)}/slice.yaml`, order: order + 1, active: true })) } });
  for (const dir of dirs) {
    write(path.join(dir, "slice.yaml"), { metadata: { id: path.basename(dir) } });
    write(path.join(dir, "SPEC.md"), "# Outcome\n\n## Proof contract\n- [ ] Observed outcome.\n");
  }
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: missions } as never); await next(); });
  app.route("/api/scopes", scopesRoutes());
  const get = async () => {
    const response = await app.request("/api/scopes?detail=1"); expect(response.status).toBe(200);
    return (await response.json()).missions[0];
  };
  return { root, missions, mission, projectFile, missionFile, dirs, write, get };
}

describe("request-local proof-policy reuse", () => {
  it("reads and parses each shared parent once per I/O provider in the actual scopes GET", async () => {
    const f = fixture();
    const expected = f.dirs.map(d => readSliceReadiness(d));
    const mission = readMissionReadiness(f.mission);
    expect(mission.issues).toEqual([]);
    expect(mission.slices).toHaveLength(8);
    const read = vi.spyOn(fs, "readFileSync");
    const parse = vi.spyOn(YAML, "parse");
    const result = await f.get();
    expect(result.slices.map((s: any) => s.readiness)).toEqual(expected);
    expect(result.readiness).toEqual(mission);
    expect.soft(read.mock.calls.filter(([file]) => file === f.projectFile)).toHaveLength(2);
    expect.soft(parse.mock.calls.filter(([text]) => text === "proofPolicy:\n  judges:\n    - judge@trial\n")).toHaveLength(2);
  });

  it("re-reads project/mission/slice changes, overrides, absence, invalid YAML and invalid policy on the next GET", async () => {
    const f = fixture(), sliceFile = path.join(f.dirs[0]!, "slice.yaml");
    const project = fs.readFileSync(f.projectFile, "utf8"), mission = fs.readFileSync(f.missionFile, "utf8"), slice = fs.readFileSync(sliceFile, "utf8");
    const check = async () => {
      const result = await f.get();
      expect(result.slices.map((s: any) => s.readiness)).toEqual(f.dirs.map(d => readSliceReadiness(d)));
      expect(result.readiness).toEqual(readMissionReadiness(f.mission));
      return result.slices[0].readiness;
    };
    expect((await check()).policy.judges).toEqual(["judge@trial"]);
    for (const [file, base, actor] of [[f.projectFile, project, "project-new"], [f.missionFile, mission, "mission-new"], [sliceFile, slice, "slice-new"]]) {
      f.write(file!, { ...YAML.parse(base!), proofPolicy: { judges: [actor, "z", actor] } });
      const current = await check();
      expect(current.policy.source).toBe(file); expect(current.policy.judges).toEqual([actor, "z"]);
    }
    f.write(sliceFile, slice); expect((await check()).policy.judges).toEqual(["mission-new", "z"]);
    f.write(f.missionFile, mission); expect((await check()).policy.judges).toEqual(["project-new", "z"]);
    f.write(f.projectFile, {}); expect((await check()).state).toBe("legacy");
    f.write(f.projectFile, project); expect((await check()).policy.judges).toEqual(["judge@trial"]);
    for (const bad of ["proofPolicy: [unclosed", { proofPolicy: null }, { proofPolicy: { judges: [] } }, { proofPolicy: { judges: ["judge"], extra: true } }]) {
      f.write(f.projectFile, bad); expect((await check()).state).toBe("unknown");
      f.write(f.projectFile, project); expect((await check()).policy.judges).toEqual(["judge@trial"]);
    }
    fs.unlinkSync(f.projectFile); expect((await check()).state).toBe("legacy");
    f.write(f.projectFile, project); expect((await check()).policy.judges).toEqual(["judge@trial"]);
  });

  it("preserves scopes' null-on-read-failure versus proofFs' thrown error and recovers on the next GET", async () => {
    const f = fixture(), before = await f.get();
    const original = fs.readFileSync, read = vi.spyOn(fs, "readFileSync");
    read.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (file === f.projectFile) throw Object.assign(new Error(`EACCES: ${f.projectFile}`), { code: "EACCES" });
      return (original as any)(file, ...args);
    }) as typeof fs.readFileSync);
    const failed = await f.get();
    expect(failed.slices.every((s: any) => s.readiness.state === "legacy")).toBe(true);
    expect(failed.readiness.slices.every((s: any) => s.readiness.state === "unknown" && s.readiness.issues[0] === `EACCES: ${f.projectFile}`)).toBe(true);
    read.mockImplementation(original);
    expect(await f.get()).toEqual(before);
  });

  it("keeps same-shaped projects and distinct I/O providers separate, with private policy objects", () => {
    const a = fixture(), b = fixture(), readPolicy = createProofPolicyRead();
    b.write(b.projectFile, { proofPolicy: { judges: ["other-project"] } });
    const first = readSliceReadiness(a.dirs[0]!, proofFs, readPolicy);
    first.policy!.judges.push("injected"); first.policy!.source = "changed by caller";
    expect(readSliceReadiness(a.dirs[1]!, proofFs, readPolicy).policy!.judges).toEqual(["judge@trial"]);
    expect(readSliceReadiness(b.dirs[0]!, proofFs, readPolicy).policy!.judges).toEqual(["other-project"]);
    const virtual: ScopeFsDeps = { ...proofFs, readFile: file => file === a.projectFile ? "proofPolicy: { judges: [virtual] }" : proofFs.readFile(file) };
    expect(readSliceReadiness(a.dirs[0]!, virtual, readPolicy).policy!.judges).toEqual(["virtual"]);
    expect(readSliceReadiness(a.dirs[0]!, proofFs, readPolicy).policy!.source).toBe(a.projectFile);
    const throwing: ScopeFsDeps = { ...proofFs, readFile: file => { if (file === a.projectFile) throw new Error(`denied ${file}`); return proofFs.readFile(file); } };
    expect(readSliceReadiness(a.dirs[0]!, throwing, readPolicy).issues).toEqual([`denied ${a.projectFile}`]);
    const missing: ScopeFsDeps = { ...proofFs, readFile: file => file === a.projectFile ? null : proofFs.readFile(file) };
    expect(readSliceReadiness(a.dirs[0]!, missing, readPolicy).state).toBe("legacy");
  });

  it("retains the nearest project boundary, and only observes absence for the current read", () => {
    const f = fixture(), dir = f.dirs[0]!, file = path.join(dir, "slice.yaml");
    const readPolicy = createProofPolicyRead();
    expect(readSliceReadiness(dir, proofFs, readPolicy).policy!.source).toBe(f.projectFile);
    f.write(file, { proofPolicy: { judges: ["child"] } });
    expect(readSliceReadiness(dir, proofFs, readPolicy).policy!.source).toBe(f.projectFile);
    expect(readSliceReadiness(dir).policy!.source).toBe(file);
    f.write(path.join(dir, "project.yaml"), {}); f.write(file, {});
    expect(readSliceReadiness(dir, proofFs, createProofPolicyRead()).state).toBe("legacy");
  });

  it("never carries reused policy through judgment preconditions, evidence checks, post-write read or replay", () => {
    const f = fixture(), dir = f.dirs[0]!, readPolicy = createProofPolicyRead();
    const original = readSliceReadiness(dir, proofFs, readPolicy);
    const evidence = path.join(dir, "proof/evidence.md"); f.write(evidence, "actual observation");
    const input: JudgeInput = { scope: "trial/slices/slice-0", item: original.items[0]!.id, verdict: "accept", reason: "observed", evidence: ["proof/evidence.md"], expectedRevision: original.items[0]!.revision, expectedPrevious: null };
    const judge = (i = input, actor = "judge@trial") => recordJudgment(f.missions, i, actor, "test");
    f.write(f.projectFile, { proofPolicy: { judges: ["new"] } });
    expect(() => judge()).toThrow("not a judge");
    expect(() => judge(input, "new")).toThrow("Item or correction changed");
    const fresh = readSliceReadiness(dir), prepared = [evidenceAt(f.root, dir, "proof/evidence.md")];
    f.write(evidence, "changed observation");
    const next = { ...input, expectedRevision: fresh.items[0]!.revision };
    expect(() => judge({ ...next, expectedEvidence: prepared }, "new")).toThrow("Evidence changed since preparation");
    expect(fs.existsSync(path.join(dir, "proof/judgments"))).toBe(false);
    const accepted = judge(next, "new");
    expect(accepted.readiness.state).toBe("ready");
    expect(accepted.readiness).toEqual(readSliceReadiness(dir));
    expect(judge(next, "new")).toMatchObject({ replayed: true, judgment: accepted.judgment, readiness: accepted.readiness });
    f.write(f.projectFile, { proofPolicy: { judges: ["new", "second"] } });
    const replay = judge(next, "new");
    expect(replay.replayed).toBe(true); expect(replay.readiness.state).toBe("unknown");
    expect(replay.readiness).toEqual(readSliceReadiness(dir));
    expect(fs.readdirSync(path.join(dir, "proof/judgments"))).toEqual(["00000001.md"]);
  });
});

describe("watch-local proof-policy reuse", () => {
  function observe(missions: string) {
    vi.useFakeTimers();
    let changed!: () => void;
    vi.spyOn(fs, "watch").mockImplementation(((_root: unknown, _options: unknown, listener: () => void) => {
      changed = listener;
      return { on: vi.fn(), close: vi.fn() };
    }) as typeof fs.watch);
    const invalidate = vi.fn(), emit = vi.fn();
    const watch = watchProofSources(missions, invalidate, { emit } as unknown as EventBus);
    const oracle = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(missions).missions.map(m => [m.name, m.revision]))).digest("hex");
    const event = () => {
      const previous = watch.observation().revision, calls = invalidate.mock.calls.length;
      const expected = oracle();
      changed(); vi.advanceTimersByTime(50);
      expect(watch.observation()).toEqual({ state: "watching", revision: expected });
      expect(invalidate).toHaveBeenCalledTimes(calls + Number(previous !== expected));
      expect(emit).toHaveBeenCalledTimes(invalidate.mock.calls.length);
    };
    return { watch, changed, event, oracle, invalidate };
  }

  it("reads/parses shared policy once in each real watch callback, preserving the uncached revision", () => {
    const f = fixture();
    fs.cpSync(f.mission, path.join(f.missions, "second"), { recursive: true });
    const o = observe(f.missions), read = vi.spyOn(fs, "readFileSync"), parse = vi.spyOn(YAML, "parse");
    const policy = fs.readFileSync(f.projectFile, "utf8");
    try {
      for (const text of ["changed outcome", "second outcome"]) {
        f.write(path.join(f.dirs[0]!, "SPEC.md"), `# Outcome\n\n## Proof contract\n- [ ] ${text}.\n`);
        const expected = o.oracle();
        read.mockClear(); parse.mockClear();
        o.changed(); vi.advanceTimersByTime(50);
        expect(o.watch.observation()).toEqual({ state: "watching", revision: expected });
        expect.soft(read.mock.calls.filter(([file]) => file === f.projectFile)).toHaveLength(1);
        expect.soft(parse.mock.calls.filter(([text]) => text === policy)).toHaveLength(1);
        // Mission manifests are also read once each for composition, separately
        // from the one policy input read per mission in this evaluation.
        expect.soft(read.mock.calls.filter(([file]) => file === f.missionFile)).toHaveLength(2);
      }
      expect(o.invalidate).toHaveBeenCalledTimes(2);
      o.event(); expect(o.invalidate).toHaveBeenCalledTimes(2);
    } finally { o.watch.close(); }
  });

  it("observes changed, missing, overridden, malformed and unreadable policy on the next event", () => {
    const f = fixture(), sliceFile = path.join(f.dirs[0]!, "slice.yaml");
    const project = fs.readFileSync(f.projectFile, "utf8"), mission = fs.readFileSync(f.missionFile, "utf8"), slice = fs.readFileSync(sliceFile, "utf8");
    const o = observe(f.missions);
    try {
      for (const [file, base, actor] of [[f.projectFile, project, "new-project"], [f.missionFile, mission, "new-mission"], [sliceFile, slice, "new-slice"]]) {
        f.write(file!, { ...YAML.parse(base!), proofPolicy: { judges: [actor] } });
        o.event(); expect(readSliceReadiness(f.dirs[0]!).policy!.judges).toEqual([actor]);
      }
      f.write(sliceFile, slice); f.write(f.missionFile, mission); o.event();
      fs.unlinkSync(f.projectFile); o.event(); expect(readSliceReadiness(f.dirs[0]!).state).toBe("legacy");
      f.write(f.projectFile, project); o.event();
      for (const bad of ["proofPolicy: [unclosed", { proofPolicy: { judges: [] } }]) {
        f.write(f.projectFile, bad); o.event(); expect(readSliceReadiness(f.dirs[0]!).state).toBe("unknown");
        f.write(f.projectFile, project); o.event(); expect(readSliceReadiness(f.dirs[0]!).policy!.judges).toEqual(["judge@trial"]);
      }
      const original = fs.readFileSync, read = vi.spyOn(fs, "readFileSync");
      read.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
        if (file === f.projectFile) throw Object.assign(new Error("policy denied"), { code: "EACCES" });
        return (original as any)(file, ...args);
      }) as typeof fs.readFileSync);
      o.event(); expect(readSliceReadiness(f.dirs[0]!).state).toBe("unknown");
      read.mockImplementation(original); o.event(); expect(readSliceReadiness(f.dirs[0]!).policy!.judges).toEqual(["judge@trial"]);
    } finally { o.watch.close(); }
  });

  it("rechecks accepted evidence between events without reusing judgment inputs", () => {
    const f = fixture(), dir = f.dirs[0]!, evidence = path.join(dir, "proof/evidence.md");
    f.write(evidence, "accepted observation");
    const item = readSliceReadiness(dir).items[0]!;
    recordJudgment(f.missions, { scope: "trial/slices/slice-0", item: item.id, verdict: "accept", reason: "observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null }, "judge@trial", "fixture");
    const o = observe(f.missions);
    try {
      expect(readSliceReadiness(dir).state).toBe("ready");
      f.write(evidence, "changed observation"); o.event(); expect(readSliceReadiness(dir).state).toBe("unknown");
      f.write(evidence, "accepted observation"); o.event(); expect(readSliceReadiness(dir).state).toBe("ready");
      expect(o.invalidate).toHaveBeenCalledTimes(2);
    } finally { o.watch.close(); }
  });
});
