import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { watch, createProofPolicyRead, readProjectReadiness, resolveProjectRoot, proofFs } = vi.hoisted(() => ({
  watch: vi.fn(), createProofPolicyRead: vi.fn(() => vi.fn()), readProjectReadiness: vi.fn(), resolveProjectRoot: vi.fn(),
  proofFs: { exists: vi.fn(() => true), readFile: vi.fn(() => null), readBytes: vi.fn(() => null), listDir: vi.fn(() => []), isDirectory: vi.fn(() => true) },
}));
// Real-location checks see every fixture path as itself (no links in these mocked trees).
vi.mock("node:fs", () => ({ watch, existsSync: () => true, realpathSync: (p: string) => p }));
vi.mock("../src/domain/proof/judgments.js", () => ({ createProofPolicyRead, readProjectReadiness, resolveProjectRoot, proofFs }));
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

it("watches only the missions root recursively; the project and evidence outside it get shallow, filtered watches", () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")], ["readBytes", path.join(project, "build", "out", "report.md")]]);
  const close = handle();
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
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
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  notifyProject("rename", Buffer.from("project.yaml"));
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(3);
  notifyEvidence("rename", "report.md");
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(4);
  // No filename: that directory's watch is rebound (closed, reattached by path) and the read verified again.
  notifyEvidence("change", null);
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(6);
  instance.close();
  expect(close).toHaveBeenCalledTimes(6);
});

it("watches the nearest existing ancestor of a missing input, filtered to the next path segment", () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  proofFs.exists.mockImplementation((p: string) => !p.startsWith(path.join(project, "build")));
  reads(() => [["readBytes", path.join(project, "build", "out", "report.md")]]);
  handle();
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([[missions, true], [project, false], [path.dirname(project), false]]);
  const notify = watch.mock.calls[1]![2];
  notify("rename", "unrelated");
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  notify("rename", "build");
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(3);
  instance.close();
});

it("reports unavailable and closes what it opened when a required watch fails, without a wider fallback", () => {
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  const close = vi.fn();
  watch.mockReturnValueOnce({ on: vi.fn(), close }).mockImplementationOnce(() => { throw new Error("ENOSPC"); });
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(instance.observation().state).toBe("unavailable");
  expect(close).toHaveBeenCalledOnce();
  expect(watch).toHaveBeenCalledTimes(2);
  instance.close();
  expect(close).toHaveBeenCalledOnce();
});

it("watches nothing else recursively when the evaluation reads nothing outside the missions root", () => {
  const missions = path.resolve("fixture/missions");
  resolveProjectRoot.mockReturnValue(path.dirname(missions));
  reads((root) => [["exists", path.join(root, "m1", "mission.yaml")]]);
  const close = handle();
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  // Only the missions root's structural anchors are added, shallow.
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([
    [missions, true], [path.dirname(missions), false], [path.dirname(path.dirname(missions)), false],
  ]);
  instance.close();
  expect(close).toHaveBeenCalledTimes(3);
});

it("does not report watching when the inputs keep changing past the reconciliation budget", () => {
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
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  const attached = new Set(watch.mock.calls.map(([root]) => root));
  // Either the final dependency set is actually watched and verified, or the monitor says it is not watching.
  const finalDir = path.dirname(sets[2]!);
  expect(instance.observation().state === "unavailable" || attached.has(finalDir)).toBe(true);
  if (instance.observation().state === "watching") expect(readProjectReadiness.mock.calls.length).toBeGreaterThan(3);
  instance.close();
});

it("tells clients when coverage is lost or regained even though the proof result is unchanged", () => {
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
  const instance = watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  expect(instance.observation().state).toBe("watching");
  const notifyProject = watch.mock.calls[1]![2];
  notifyProject("change", "project.yaml"); vi.advanceTimersByTime(50);
  expect(instance.observation().state).toBe("unavailable");
  expect(emit.mock.calls.map(([e]) => e.revision)).toEqual(["unavailable"]);
  notifyProject("change", "project.yaml"); vi.advanceTimersByTime(50);
  expect(instance.observation().state).toBe("watching");
  expect(emit.mock.calls.map(([e]) => e.revision)).toEqual(["unavailable", instance.observation().revision]);
  instance.close();
});

it("after close, a queued callback neither re-reads, reopens nor emits", () => {
  vi.useFakeTimers();
  const project = path.resolve("fixture/project");
  const missions = path.join(project, "missions");
  resolveProjectRoot.mockReturnValue(project);
  reads(() => [["exists", path.join(project, "project.yaml")]]);
  handle();
  const emit = vi.fn();
  const instance = watchProofSources(missions, vi.fn(), { emit } as unknown as EventBus);
  const notifyMissions = watch.mock.calls[0]![2];
  notifyMissions("change", "x");
  instance.close();
  notifyMissions("change", "y");
  vi.advanceTimersByTime(100);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  expect(watch).toHaveBeenCalledTimes(3);
  expect(emit).not.toHaveBeenCalled();
  expect(instance.observation().state).toBe("unavailable");
});
