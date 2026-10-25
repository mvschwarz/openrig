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
    // Each watched directory's listener, by path: "a change" is delivered by the missions root's own watch.
    const listeners = new Map<string, () => void>();
    vi.spyOn(fs, "watch").mockImplementation(((root: string, _options: unknown, listener: () => void) => {
      listeners.set(root, listener);
      return { on: vi.fn(), close: vi.fn() };
    }) as unknown as typeof fs.watch);
    const invalidate = vi.fn(), emit = vi.fn();
    const watch = watchProofSources(missions, invalidate, { emit } as unknown as EventBus);
    const changed = () => listeners.get(missions)!();
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

  it("observes accepted evidence outside the missions root at its parent, never recursively, through edit and atomic replacement", () => {
    const f = fixture(), dir = f.dirs[0]!, outside = path.join(f.root, "build", "out"), evidence = path.join(outside, "report.md");
    f.write(evidence, "accepted observation");
    const item = readSliceReadiness(dir).items[0]!;
    recordJudgment(f.missions, { scope: "trial/slices/slice-0", item: item.id, verdict: "accept", reason: "observed", evidence: [evidence], expectedRevision: item.revision, expectedPrevious: null }, "judge@trial", "fixture");
    vi.useFakeTimers();
    const listeners = new Map<string, (event: string, name: string | null) => void>(), recursive = new Map<string, boolean>();
    vi.spyOn(fs, "watch").mockImplementation(((root: string, options: { recursive: boolean }, listener: (event: string, name: string | null) => void) => {
      listeners.set(root, listener); recursive.set(root, options.recursive);
      return { on: vi.fn(), close: vi.fn() };
    }) as unknown as typeof fs.watch);
    const invalidate = vi.fn();
    const watch = watchProofSources(f.missions, invalidate, { emit: vi.fn() } as unknown as EventBus);
    const oracle = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(f.missions).missions.map(m => [m.name, m.revision]))).digest("hex");
    try {
      expect(watch.observation()).toEqual({ state: "watching", revision: oracle() });
      expect(recursive.get(f.missions)).toBe(true);
      expect(recursive.get(outside)).toBe(false);
      expect([...recursive].filter(([root, deep]) => deep && root !== f.missions)).toEqual([]);
      f.write(evidence, "changed observation");
      listeners.get(outside)!("change", "report.md"); vi.advanceTimersByTime(50);
      expect(readSliceReadiness(dir).state).toBe("unknown");
      expect(watch.observation()).toEqual({ state: "watching", revision: oracle() });
      fs.writeFileSync(`${evidence}.tmp`, "accepted observation"); fs.renameSync(`${evidence}.tmp`, evidence);
      listeners.get(outside)!("rename", "report.md"); vi.advanceTimersByTime(50);
      expect(readSliceReadiness(dir).state).toBe("ready");
      expect(watch.observation()).toEqual({ state: "watching", revision: oracle() });
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally { watch.close(); }
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

describe("QA bounded adverse coverage at 8b236e06", () => {
  function adverseFixture() {
    const f = fixture(), dir = f.dirs[0]!, outside = path.join(f.root, "build", "out"), evidence = path.join(outside, "report.md");
    f.write(evidence, "accepted observation");
    const item = readSliceReadiness(dir).items[0]!;
    recordJudgment(f.missions, { scope: "trial/slices/slice-0", item: item.id, verdict: "accept", reason: "observed", evidence: [evidence], expectedRevision: item.revision, expectedPrevious: null }, "judge@trial", "fixture");
    vi.useFakeTimers();
    const handles = new Map<string, { event: (event: string, name: string | null) => void; error?: () => void }>();
    vi.spyOn(fs, "watch").mockImplementation(((root: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
      const h = { event: listener, error: undefined as (() => void) | undefined }; handles.set(root, h);
      return { on: (_kind: string, cb: () => void) => { h.error = cb; }, close: vi.fn() };
    }) as unknown as typeof fs.watch);
    const invalidate = vi.fn(), emit = vi.fn(), watch = watchProofSources(f.missions, invalidate, { emit } as unknown as EventBus);
    const oracle = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(f.missions).missions.map(m => [m.name, m.revision]))).digest("hex");
    return { f, dir, outside, evidence, handles, watch, oracle, invalidate, emit };
  }
  it("QA retains unavailable after an async required-handle error and another valid event unless coverage is replaced", () => {
    const t = adverseFixture();
    try {
      expect(t.watch.observation()).toEqual({ state: "watching", revision: t.oracle() });
      const failed = t.handles.get(t.outside)!; failed.error!();
      expect(t.watch.observation().state).toBe("unavailable");
      t.f.write(t.evidence, "changed observation");
      t.handles.get(t.f.missions)!.event("change", "trial/slices/slice-0/SPEC.md"); vi.advanceTimersByTime(50);
      expect(readSliceReadiness(t.dir).state).toBe("unknown");
      expect(t.watch.observation().revision).toBe(t.oracle());
      // A fresh semantic read is not repaired notification coverage for the errored, unreplaced handle.
      expect(t.watch.observation().state).toBe("unavailable");
    } finally { t.watch.close(); }
  });
  it("rebinds a replaced evidence parent when its structural parent reports a change without a filename", () => {
    const t = adverseFixture();
    try {
      const opened = () => vi.mocked(fs.watch).mock.calls.filter(([root]) => root === t.outside).length;
      expect(opened()).toBe(1);
      fs.renameSync(t.outside, `${t.outside}.old`); t.f.write(t.evidence, "changed observation");
      // The platform names nothing: only the structural parent of the replaced directory reports a change.
      t.handles.get(path.dirname(t.outside))!.event("rename", null); vi.advanceTimersByTime(50);
      expect(readSliceReadiness(t.dir).state).toBe("unknown");
      expect(t.watch.observation().revision).toBe(t.oracle());
      // The old same-path handle cannot certify coverage: it is replaced, or the sources are reported unobserved.
      expect(opened() === 2 || t.watch.observation().state === "unavailable").toBe(true);
    } finally { t.watch.close(); }
  });
  it("watches the real location of evidence reached through a link inside the project", () => {
    const t = adverseFixture();
    try {
      // The evidence directory becomes a link to another directory inside the project, with the same accepted bytes.
      const real = path.join(t.f.root, "real"), live = path.join(real, "live");
      t.f.write(path.join(live, "report.md"), "accepted observation");
      fs.renameSync(t.outside, `${t.outside}.old`); fs.symlinkSync(live, t.outside);
      t.handles.get(path.dirname(t.outside))!.event("rename", path.basename(t.outside)); vi.advanceTimersByTime(50);
      expect(readSliceReadiness(t.dir).state).toBe("ready");
      // Replacing the real directory is seen at its own parent, or the sources are reported unobserved.
      const watched = vi.mocked(fs.watch).mock.calls.map(([root]) => root);
      expect(watched.includes(real) || t.watch.observation().state === "unavailable").toBe(true);
      expect(watched.some((root) => !String(root).startsWith(t.f.root) && root !== path.dirname(t.f.root))).toBe(false);
    } finally { t.watch.close(); }
  });
  for (const name of ["missions", null]) it(`rebinds a linked missions root when its real directory is replaced (${name ?? "no filename"})`, () => {
    const f = fixture(), real = path.join(f.root, "real"), linked = path.join(f.root, "linked-missions");
    fs.mkdirSync(real); fs.renameSync(f.missions, path.join(real, "missions")); fs.symlinkSync(path.join(real, "missions"), linked);
    vi.useFakeTimers();
    // Each handle with its listener; a handle opened before the replacement watches the old directory and stays silent.
    const opened: Array<{ root: string; recursive: boolean; event: (event: string, name: string | null) => void }> = [];
    vi.spyOn(fs, "watch").mockImplementation(((root: string, options: { recursive: boolean }, listener: (event: string, name: string | null) => void) => {
      opened.push({ root, recursive: options.recursive, event: listener });
      return { on: vi.fn(), close: vi.fn() };
    }) as unknown as typeof fs.watch);
    const oracle = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(linked).missions.map(m => [m.name, m.revision]))).digest("hex");
    const watch = watchProofSources(linked, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
    try {
      expect(watch.observation()).toEqual({ state: "watching", revision: oracle() });
      fs.renameSync(path.join(real, "missions"), path.join(real, "missions.old"));
      fs.cpSync(path.join(real, "missions.old"), path.join(real, "missions"), { recursive: true });
      const before = opened.length;
      opened.filter((h) => h.root === real).at(-1)!.event("rename", name); vi.advanceTimersByTime(50);
      // A new mission in the replacement tree reaches clients through the live watches only.
      fs.cpSync(path.join(real, "missions", "trial"), path.join(real, "missions", "new-mission"), { recursive: true });
      for (const h of opened.slice(before)) h.event("rename", h.recursive ? "new-mission/mission.yaml" : "new-mission");
      vi.advanceTimersByTime(50);
      expect(watch.observation().state === "unavailable" || watch.observation().revision === oracle()).toBe(true);
      expect(opened.some((h) => !h.root.startsWith(f.root) && h.root !== path.dirname(f.root))).toBe(false);
    } finally { watch.close(); }
  });
  for (const start of ["outside", "inside"] as const) it(`reports unavailable while a linked missions root's real location is outside the project (starts ${start})`, () => {
    const f = fixture(), linked = path.join(f.root, "linked-missions"), inside = path.join(f.root, "real", "missions");
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "policy-reuse-other-"))); roots.push(other);
    const outside = path.join(other, "missions");
    // Another project's missions tree, readable on its own.
    fs.cpSync(f.missions, outside, { recursive: true }); fs.copyFileSync(f.projectFile, path.join(other, "project.yaml")); fs.mkdirSync(path.dirname(inside)); fs.renameSync(f.missions, inside);
    fs.symlinkSync(start === "outside" ? outside : inside, linked);
    vi.useFakeTimers();
    const opened: Array<{ root: string; event: (event: string, name: string | null) => void }> = [];
    vi.spyOn(fs, "watch").mockImplementation(((root: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
      opened.push({ root, event: listener });
      return { on: vi.fn(), close: vi.fn() };
    }) as unknown as typeof fs.watch);
    const emit = vi.fn(), watch = watchProofSources(linked, vi.fn(), { emit } as unknown as EventBus);
    try {
      if (start === "inside") {
        expect(watch.observation().state).toBe("watching");
        // The supported alias is re-pointed outside the project; the link's own parent sees it.
        fs.unlinkSync(linked); fs.symlinkSync(outside, linked);
        opened.filter((h) => h.root === f.root).at(-1)!.event("rename", "linked-missions"); vi.advanceTimersByTime(50);
        expect(emit.mock.calls.map(([e]) => e.revision)).toContain("unavailable");
      }
      expect(watch.observation().state).toBe("unavailable");
      expect(opened.some((h) => h.root.startsWith(other))).toBe(false);
    } finally { watch.close(); }
  });
  it("QA observes replacement of an external evidence parent or honestly reports unavailable", () => {
    const t = adverseFixture();
    try {
      const previous = t.watch.observation().revision;
      expect(readSliceReadiness(t.dir).state).toBe("ready");
      fs.renameSync(t.outside, `${t.outside}.old`); t.f.write(t.evidence, "changed observation");
      // Directory replacement is visible at structural parents, not as a leaf event on the old directory inode.
      for (const [root, h] of t.handles) {
        if (root === path.dirname(t.outside)) h.event("rename", path.basename(t.outside));
        if (root === t.f.root) h.event("rename", "build");
      }
      vi.advanceTimersByTime(50);
      expect(readSliceReadiness(t.dir).state).toBe("unknown");
      expect(t.oracle()).not.toBe(previous);
      expect(t.watch.observation().state === "unavailable" || t.watch.observation().revision === t.oracle()).toBe(true);
    } finally { t.watch.close(); }
  });
});
