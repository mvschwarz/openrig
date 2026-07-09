// OPR.0.4.6.MH1 FR-5/FR-6 — the daemon-side hosts-registry WRITE twin
// (arch B1 ruling, pins P1–P4).
//
// The browser surface cannot reach the CLI's fs code, so the dashboard
// add/pair path writes through THIS module — a deliberate VERBATIM MIRROR
// of packages/cli/src/host-registry.ts addHostEntry, byte-parity-pinned
// by packages/daemon/test/hosts-add-pair-routes.test.ts (same entries in
// → identical yaml bytes out; P3) and sharing the reader twin's
// validateHostRegistry (identical validation: exactly-one-bearer,
// reserved ids, duplicate ids — P3). The reader module stays READ-ONLY
// FOREVER; writes flow ONLY through the single parity-pinned write
// contract (CLI addHostEntry + this twin), reachable daemon-side solely
// via the narrow named add/pair routes (P1 — no generic registry-write
// route exists).
//
// Concurrency (P4): atomic tmp+rename, whole-file LAST-WRITE-WINS on a
// concurrent add — the ceiling is one operator-scale registry file; NO
// locking machinery by design. Two simultaneous adds may drop one entry;
// re-running the add re-converges (add-time validation = load-time
// validation, verbatim).

import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  defaultHostRegistryPath,
  loadHostRegistry,
  validateHostRegistry,
  type HostEntry,
} from "./hosts-registry-reader.js";

export type AddHostResult =
  | { ok: true; path: string; entry: HostEntry }
  | { ok: false; error: string };

export function addHostEntry(rawEntry: Record<string, unknown>, path: string = defaultHostRegistryPath()): AddHostResult {
  // Load what exists; a MISSING file is a valid starting point for `add`
  // (the verb exists so operators never hand-create the YAML), but a present-
  // but-invalid file is a loud error — never silently clobber operator state.
  let existing: HostEntry[] = [];
  if (existsSync(path)) {
    const loaded = loadHostRegistry(path);
    if (!loaded.ok) {
      return { ok: false, error: `refusing to modify an invalid registry: ${loaded.error}` };
    }
    existing = loaded.registry.hosts;
  }

  const candidate = { hosts: [...existing, rawEntry] };
  const validated = validateHostRegistry(candidate, path);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const entry = validated.registry.hosts[validated.registry.hosts.length - 1]!;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.hosts.yaml.tmp-${process.pid}`);
    writeFileSync(tmp, stringifyYaml({ hosts: validated.registry.hosts }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, error: `failed to write host registry at ${path}: ${(err as Error).message}` };
  }
  return { ok: true, path, entry };
}
