import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";

let recorder: SlowOperationInstrumentation | undefined;

export function configureSyncSiteRecorder(next: SlowOperationInstrumentation | undefined): void {
  recorder = next;
}

export function runSyncSite<T>(site: string, fn: () => T): T {
  return recorder?.runSync ? recorder.runSync(site, fn) : fn();
}
