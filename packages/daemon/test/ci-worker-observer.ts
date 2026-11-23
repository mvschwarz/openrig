// Observation only, for the macOS CI daemon job: what the running invocation had (CPU, Node, Vitest, worker settings)
// and how many test files its workers actually held at once. It prints an allowlist of facts, no environment dump,
// token or path, and never changes the run: every hook catches its own errors.
import os from "node:os";
import { performance } from "node:perf_hooks";
import type { Reporter, TestModule, Vitest } from "vitest/node";

const log = (what: string, facts: Record<string, unknown>): void => {
  try { process.stdout.write(`[openrig-ci-observe] ${what} ${JSON.stringify(facts)}\n`); } catch { /* observation only */ }
};

export default class CiWorkerObserver implements Reporter {
  private readonly started = new Map<string, number>();
  private readonly spans: Array<[number, number]> = [];

  onInit(vitest: Vitest): void {
    try {
      const cpus = os.cpus().length;
      const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : null;
      const n = available ?? cpus;
      const config = vitest.config;
      // Vitest 4.1.12's own rule (resolveMaxWorkers in its cli-api chunk): the project's maxWorkers, else the root's,
      // else max(n - 1, 1) outside watch mode. Derived here from the same inputs; the pool's own value isn't exposed.
      const derived = (projectMax: number | undefined): number =>
        projectMax || config.maxWorkers || (config.watch ? Math.max(Math.floor(n / 2), 1) : Math.max(n - 1, 1));
      log("invocation", {
        platform: os.platform(), arch: os.arch(), osRelease: os.release(), node: process.version, vitest: vitest.version,
        cpus, availableParallelism: available,
        pool: config.pool, maxWorkers: config.maxWorkers ?? null, fileParallelism: config.fileParallelism ?? null,
        watch: config.watch, vitestMaxWorkersEnv: process.env.VITEST_MAX_WORKERS ?? null,
        projects: vitest.projects.map(project => ({
          name: project.name || "(root)", pool: project.config.pool, maxWorkers: project.config.maxWorkers ?? null,
          fileParallelism: project.config.fileParallelism ?? null, derivedMaxWorkers: derived(project.config.maxWorkers),
        })),
      });
    } catch (error) {
      log("invocation-unavailable", { error: String(error).slice(0, 160) });
    }
  }

  // Vitest reports a module as queued when a worker begins it (before its import) and ended when its tests finish, so
  // the time between is a worker holding that file.
  onTestModuleQueued(testModule: TestModule): void {
    try { this.started.set(testModule.id, performance.now()); } catch { /* observation only */ }
  }

  onTestModuleEnd(testModule: TestModule): void {
    try {
      const start = this.started.get(testModule.id);
      if (start !== undefined) this.spans.push([start, performance.now()]);
    } catch { /* observation only */ }
  }

  onTestRunEnd(): void {
    try {
      const events = this.spans.flatMap(([a, b]) => [[a, 1], [b, -1]] as Array<[number, number]>)
        .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let current = 0, peak = 0, last = events[0]?.[0] ?? 0;
      const seconds: Record<number, number> = {};
      for (const [at, step] of events) {
        seconds[current] = (seconds[current] ?? 0) + (at - last) / 1000;
        last = at; current += step; peak = Math.max(peak, current);
      }
      const rounded = Object.fromEntries(Object.entries(seconds).map(([k, v]) => [k, Math.round(v)]));
      log("observed", { files: this.spans.length, peakFilesHeldAtOnce: peak, secondsAtFilesHeld: rounded });
    } catch (error) {
      log("observed-unavailable", { error: String(error).slice(0, 160) });
    }
  }
}
