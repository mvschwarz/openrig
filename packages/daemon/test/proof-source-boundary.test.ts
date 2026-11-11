import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { watch, createProofPolicyRead, readProjectReadiness, resolveProjectRoot, proofFs } = vi.hoisted(() => ({
  watch: vi.fn(), createProofPolicyRead: vi.fn(() => vi.fn()), readProjectReadiness: vi.fn(), resolveProjectRoot: vi.fn(),
  proofFs: { exists: vi.fn(() => true), readFile: vi.fn(() => null), readBytes: vi.fn(() => null), listDir: vi.fn(() => []), isDirectory: vi.fn(() => true) },
}));
// Real-location checks see every fixture path as itself (no links in these mocked trees).
vi.mock("node:fs", () => ({ watch, existsSync: () => true, realpathSync: (p: string) => p }));
vi.mock("../src/domain/proof/judgments.js", () => ({ createProofPolicyRead, readProjectReadiness, readProjectReadinessAsync: async (...args: unknown[]) => readProjectReadiness(...args), resolveProjectRoot, proofFs }));
import { watchProofSources } from "../src/domain/proof/source-watch.js";
import type { EventBus } from "../src/domain/event-bus.js";
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); proofFs.exists.mockImplementation(() => true); });

type Io = { exists(p: string): boolean; readBytes(p: string): unknown };
/** The readiness evaluation, as the watcher sees it: the paths it reads through the supplied reader. */
function reads(paths: (missions: string) => Array<[keyof Io, string]>) {
  readProjectReadiness.mockImplementation((missions: string, _read: unknown, _root: unknown, io?: Io) => {
    for (const [method, file] of paths(missions)) io?.[method](file);
    return { missions: [] };
  });
}
const handle = () => { const close = vi.fn(); watch.mockImplementation(() => ({ on: vi.fn(), close })); return close; };

it("watches only the missions root recursively; the project and evidence outside it get shallow, filtered watches", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")], ["readBytes", path.join(project, "build", "out", "report.md")]]);
  const close = handle();
  const instance = await watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  // Inputs at their parents, plus shallow structural anchors up to the project's parent (for replaced directories).
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([
    [missions, true], [project, false], [path.join(project, "build", "out"), false],
    [path.dirname(project), false], [path.join(project, "build"), false],
  ]);
  // Neither the project (with its sibling checkouts and build trees) nor any parent is watched recursively.
  expect(watch.mock.calls.filter(([root, options]) => options.recursive && root !== missions)).toEqual([]);
  expect(instance.observation().state).toBe("watching");

  // Setup reads once more after attaching the new watches, so nothing changed in between is missed.
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  const notifyProject = watch.mock.calls[1]![2], notifyEvidence = watch.mock.calls[2]![2];
  notifyProject("change", "unrelated.txt");
  notifyEvidence("change", Buffer.from("other.md"));
  await vi.advanceTimersByTimeAsync(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  notifyProject("rename", Buffer.from("project.yaml"));
  await vi.advanceTimersByTimeAsync(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(3);
  notifyEvidence("rename", "report.md");
  await vi.advanceTimersByTimeAsync(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(4);
  // No filename: that directory's watch is rebound (closed, reattached by path) and the read verified again.
  notifyEvidence("change", null);
  await vi.advanceTimersByTimeAsync(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(6);
  instance.close();
  expect(close).toHaveBeenCalledTimes(6);
});

it("watches the nearest existing ancestor of a missing input, filtered to the next path segment", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  proofFs.exists.mockImplementation((p: string) => !p.startsWith(path.join(project, "build")));
  reads(() => [["readBytes", path.join(project, "build", "out", "report.md")]]);
  handle();
  const instance = await watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([[missions, true], [project, false], [path.dirname(project), false]]);
  const notify = watch.mock.calls[1]![2];
  notify("rename", "unrelated");
  await vi.advanceTimersByTimeAsync(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  notify("rename", "build");
  await vi.advanceTimersByTimeAsync(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(3);
  instance.close();
});

it("reports unavailable and closes what it opened when a required watch fails, without a wider fallback", async () => {
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  const close = vi.fn();
  watch.mockReturnValueOnce({ on: vi.fn(), close }).mockImplementationOnce(() => { throw new Error("ENOSPC"); });
  const instance = await watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(instance.observation().state).toBe("unavailable");
  expect(close).toHaveBeenCalledOnce();
  expect(watch).toHaveBeenCalledTimes(2);
  instance.close();
  expect(close).toHaveBeenCalledOnce();
});

it("watches nothing else recursively when the evaluation reads nothing outside the missions root", async () => {
  const missions = path.resolve("fixture/missions");
  resolveProjectRoot.mockReturnValue(path.dirname(missions));
  reads((root) => [["exists", path.join(root, "m1", "mission.yaml")]]);
  const close = handle();
  const instance = await watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  // Only the missions root's structural anchors are added, shallow.
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([
    [missions, true], [path.dirname(missions), false], [path.dirname(path.dirname(missions)), false],
  ]);
  instance.close();
  expect(close).toHaveBeenCalledTimes(3);
});

it("does not report watching when the inputs keep changing past the reconciliation budget", async () => {
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  // Each read finds its evidence in a different directory (A, B, C, then C again), with the same semantic result.
  const sets = ["a", "b", "c"].map((d) => path.join(project, d, "report.md"));
  let call = 0;
  readProjectReadiness.mockImplementation((_m: string, _r: unknown, _root: unknown, io?: Io) => {
    io?.readBytes(sets[Math.min(call++, sets.length - 1)]!);
    return { missions: [] };
  });
  handle();
  const instance = await watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  const attached = new Set(watch.mock.calls.map(([root]) => root));
  // Either the final dependency set is actually watched and verified, or the monitor says it is not watching.
  const finalDir = path.dirname(sets[2]!);
  expect(instance.observation().state === "unavailable" || attached.has(finalDir)).toBe(true);
  if (instance.observation().state === "watching") expect(readProjectReadiness.mock.calls.length).toBeGreaterThan(3);
  instance.close();
});

it("tells clients when coverage is lost or regained even though the proof result is unchanged", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  // Setup reads a stable set; the next event's three reads each find a new directory (same result); then it settles.
  const stable = path.join(project, "project.yaml");
  const moving = ["a", "b", "c"].map((d) => path.join(project, d, "report.md"));
  let call = 0;
  readProjectReadiness.mockImplementation((_m: string, _r: unknown, _root: unknown, io?: Io) => {
    const n = call++;
    io?.exists(stable);
    if (n >= 2) io?.readBytes(moving[Math.min(n - 2, 2)]!);
    return { missions: [] };
  });
  handle();
  const emit = vi.fn();
  const instance = await watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  expect(instance.observation().state).toBe("watching");
  const notifyProject = watch.mock.calls[1]![2];
  notifyProject("change", "project.yaml"); await vi.advanceTimersByTimeAsync(50);
  expect(instance.observation().state).toBe("unavailable");
  expect(emit.mock.calls.map(([e]) => e.revision)).toEqual(["unavailable"]);
  notifyProject("change", "project.yaml"); await vi.advanceTimersByTimeAsync(50);
  expect(instance.observation().state).toBe("watching");
  expect(emit.mock.calls.map(([e]) => e.revision)).toEqual(["unavailable", instance.observation().revision]);
  instance.close();
});

it("after close, a queued callback neither re-reads, reopens nor emits", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  handle();
  const emit = vi.fn();
  const instance = await watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  const notifyMissions = watch.mock.calls[0]![2];
  notifyMissions("change", "x");
  instance.close();
  notifyMissions("change", "y");
  await vi.advanceTimersByTimeAsync(100);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  expect(watch).toHaveBeenCalledTimes(3);
  expect(emit).not.toHaveBeenCalled();
  expect(instance.observation().state).toBe("unavailable");
});

it.each(["changed", "unchanged"])("coalesces mid-read events and publishes only a current %s basis", async mode => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project"), missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  handle();
  const emit = vi.fn();
  const instance = await watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  let finish!: (value: { missions: Array<{ name: string; revision: string }> }) => void;
  readProjectReadiness.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const notify = watch.mock.calls[0]![2];
  notify("change", "SPEC.md");
  await vi.advanceTimersByTimeAsync(50);
  const settledRevision = instance.observation().revision;
  const calls = readProjectReadiness.mock.calls.length;
  notify("change", "SPEC.md"); notify("change", "SPEC.md");
  await vi.advanceTimersByTimeAsync(100);
  expect(readProjectReadiness).toHaveBeenCalledTimes(calls);
  finish({ missions: [{ name: "trial", revision: "superseded" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(instance.observation().revision).toBe(settledRevision);
  expect(emit).not.toHaveBeenCalled();
  readProjectReadiness.mockReturnValue({ missions: mode === "changed" ? [{ name: "trial", revision: "current" }] : [] });
  await vi.advanceTimersByTimeAsync(50);
  expect(instance.observation().state).toBe("watching");
  expect(emit).toHaveBeenCalledTimes(mode === "changed" ? 1 : 0);
  instance.close();
});

it("publishes unchanged-revision coverage recovery only after an interrupted read settles cleanly", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project"), missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  let call = 0;
  readProjectReadiness.mockImplementation((_m: string, _r: unknown, _root: unknown, io?: Io) => {
    io?.exists(path.join(project, "project.yaml"));
    io?.readBytes(path.join(project, `input-${Math.min(call++, 2)}`, "report.md"));
    return { missions: [] };
  });
  handle();
  const emit = vi.fn();
  const instance = await watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  const settled = instance.observation();
  expect(settled.state).toBe("unavailable"); // all three setup passes attached a previously unwatched dependency
  const read = readProjectReadiness.getMockImplementation()!;
  let finish!: (value: { missions: [] }) => void;
  readProjectReadiness.mockImplementationOnce((...args: unknown[]) => {
    read(...args);
    return new Promise(resolve => { finish = resolve; });
  });
  const notify = watch.mock.calls[0]![2];
  notify("change", "report.md"); await vi.advanceTimersByTimeAsync(50);
  notify("change", "report.md");
  finish({ missions: [] }); await vi.advanceTimersByTimeAsync(0);
  expect.soft(instance.observation()).toEqual(settled);
  expect(emit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(instance.observation()).toEqual({ state: "watching", revision: settled.revision });
  expect.soft(emit.mock.calls.map(([event]) => event.revision)).toEqual([settled.revision]);
  instance.close();
});

it("reports watch errors immediately while a refresh is still awaiting its read", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project"), missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  let error!: () => void;
  watch.mockImplementation(() => ({ on: (_event: string, callback: () => void) => { error = callback; }, close: vi.fn() }));
  const emit = vi.fn();
  const instance = await watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  let finish!: (value: { missions: [] }) => void;
  readProjectReadiness.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  watch.mock.calls[0]![2]("change", "report.md"); await vi.advanceTimersByTimeAsync(50);
  error();
  expect(instance.observation()).toEqual({ state: "unavailable", revision: "unavailable" });
  expect(emit.mock.calls.at(-1)![0].revision).toBe("unavailable");
  finish({ missions: [] }); await vi.advanceTimersByTimeAsync(0);
  expect(instance.observation().state).toBe("unavailable");
  expect(emit.mock.calls.every(([event]) => event.revision === "unavailable")).toBe(true);
  instance.close();
});

it("does not publish an interrupted setup candidate before a clean refresh", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project"), missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  const read = readProjectReadiness.getMockImplementation()!;
  let finish!: (value: { missions: [] }) => void;
  readProjectReadiness.mockImplementationOnce((...args: unknown[]) => {
    read(...args);
    return new Promise(resolve => { finish = resolve; });
  });
  handle();
  const emit = vi.fn(), opening = watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  watch.mock.calls[0]![2]("change", "report.md");
  finish({ missions: [] });
  const instance = await opening;
  expect(instance.observation()).toEqual({ state: "unavailable", revision: "unavailable" });
  expect(emit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(instance.observation().state).toBe("watching");
  expect(emit).toHaveBeenCalledTimes(1);
  instance.close();
});

it("does not reattach watches or publish when an in-flight read finishes after close", async () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project"), missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  handle();
  const emit = vi.fn();
  const instance = await watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  let finish!: (value: { missions: [] }) => void;
  readProjectReadiness.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  watch.mock.calls[0]![2]("change", "SPEC.md");
  await vi.advanceTimersByTimeAsync(50);
  const watches = watch.mock.calls.length;
  instance.close(); finish({ missions: [] });
  await vi.advanceTimersByTimeAsync(100);
  expect(watch).toHaveBeenCalledTimes(watches);
  expect(emit).not.toHaveBeenCalled();
  expect(instance.observation().state).toBe("unavailable");
});
