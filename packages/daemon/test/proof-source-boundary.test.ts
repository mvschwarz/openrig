import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { watch, readProjectReadiness, resolveProjectRoot } = vi.hoisted(() => ({
  watch: vi.fn(), readProjectReadiness: vi.fn(), resolveProjectRoot: vi.fn(),
}));
vi.mock("node:fs", () => ({ watch }));
vi.mock("../src/domain/proof/judgments.js", () => ({ readProjectReadiness, resolveProjectRoot }));
import { watchProofSources } from "../src/domain/proof/source-watch.js";
import type { EventBus } from "../src/domain/event-bus.js";
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("keeps recursive watching local and filters the ancestor policy watch", () => {
  vi.useFakeTimers();
  const missions = path.resolve("fixture/ancestor/work/initiatives");
  const project = path.resolve("fixture/ancestor");
  resolveProjectRoot.mockReturnValue(project);
  readProjectReadiness.mockReturnValue({ missions: [] });
  const close = vi.fn();
  watch.mockImplementation(() => ({ on: vi.fn(), close }));
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([
    [path.dirname(missions), true], [project, false],
  ]);
  const notifyProject = watch.mock.calls[1]![2];
  notifyProject("change", "unrelated.txt");
  notifyProject("change", Buffer.from("unrelated.txt"));
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(1);
  notifyProject("rename", Buffer.from("project.yaml"));
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  notifyProject("change", null);
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(3);
  instance.close();
  expect(close).toHaveBeenCalledTimes(2);
});

it("closes the recursive watcher when opening the extra policy watcher fails", () => {
  const missions = path.resolve("fixture/ancestor/work/initiatives");
  resolveProjectRoot.mockReturnValue(path.resolve("fixture/ancestor"));
  readProjectReadiness.mockReturnValue({ missions: [] });
  const close = vi.fn();
  watch.mockReturnValueOnce({ on: vi.fn(), close }).mockImplementationOnce(() => { throw new Error("watch unavailable"); });
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(instance.observation().state).toBe("unavailable");
  expect(close).toHaveBeenCalledOnce();
  instance.close();
  expect(close).toHaveBeenCalledOnce();
});

it("uses only the existing recursive watcher when the policy root is the same directory", () => {
  const missions = path.resolve("fixture/missions");
  resolveProjectRoot.mockReturnValue(path.dirname(missions));
  readProjectReadiness.mockReturnValue({ missions: [] });
  const close = vi.fn();
  watch.mockReturnValue({ on: vi.fn(), close });
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus);
  expect(watch).toHaveBeenCalledOnce();
  instance.close();
  expect(close).toHaveBeenCalledOnce();
});
