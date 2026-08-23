import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * OPR.0.5.3.6 — shipped topology chain-file defaults (CE-v2 as product).
 *
 * A rig spec may carry a `topology/` folder of sensible-default chain files.
 * At rig-up they install under the typed `topology.root` (see
 * docs/reference/chain-file-convention.md — the SSOT), at three altitudes
 * (founder P1: the pod level is deliberately skipped):
 *
 *   <spec>/topology/instance/<NAME>.md      -> <topology.root>/<NAME>.md
 *   <spec>/topology/rig/<NAME>.md           -> <topology.root>/rigs/<rig>/<NAME>.md
 *   <spec>/topology/seats/<seat>/<NAME>.md  -> <topology.root>/rigs/<rig>/seats/<seat>/<NAME>.md
 *
 * COPY-IF-ABSENT, never overwrite: a shipped default is a starting point the
 * occupying team appends to — a later rig-up must never clobber earned
 * context. Installation is best-effort per file (a rig launch never fails on
 * a defaults copy) but every skip/install is reported so the caller can log
 * honestly rather than silently.
 */
export interface TopologyDefaultsResult {
  installed: string[];
  /** Destination existed — the shipped default did not overwrite it. */
  preserved: string[];
  /** Read/write failures, named (best-effort contract: never throws). */
  failed: Array<{ path: string; error: string }>;
  /** True when the spec ships no topology/ folder at all (a normal case). */
  none: boolean;
}

export interface TopologyDefaultsFsOps {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  listFiles(dir: string): string[];
  listDirs(dir: string): string[];
  read(path: string): string;
  write(path: string, content: string): void;
  mkdirp(dir: string): void;
}

const realFsOps: TopologyDefaultsFsOps = {
  exists: (p) => fs.existsSync(p),
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  listFiles: (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
  listDirs: (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  read: (p) => fs.readFileSync(p, "utf-8"),
  write: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  mkdirp: (d) => { fs.mkdirSync(d, { recursive: true }); },
};

export function installTopologyDefaults(input: {
  /** The rig spec's directory (rigRoot) — `topology/` is resolved beneath it. */
  specDir: string;
  rigName: string;
  topologyRoot: string;
  fsOps?: TopologyDefaultsFsOps;
}): TopologyDefaultsResult {
  const ops = input.fsOps ?? realFsOps;
  const result: TopologyDefaultsResult = { installed: [], preserved: [], failed: [], none: false };
  const topologyDir = nodePath.join(input.specDir, "topology");
  // r2 residual: the total never-throw contract has no first-line exception —
  // even the root probe failing is a NAMED failure, not a throw and not `none`.
  try {
    if (!ops.isDirectory(topologyDir)) {
      result.none = true;
      return result;
    }
  } catch (err) {
    result.failed.push({ path: topologyDir, error: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const copyIfAbsent = (src: string, dest: string): void => {
    try {
      if (ops.exists(dest)) {
        result.preserved.push(dest);
        return;
      }
      const content = ops.read(src);
      ops.mkdirp(nodePath.dirname(dest));
      ops.write(dest, content);
      result.installed.push(dest);
    } catch (err) {
      result.failed.push({ path: dest, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // r2-B2: the best-effort contract is TOTAL — enumeration failures (listFiles/
  // listDirs EACCES/EIO) are NAMED failures on the section directory, never a
  // throw, and one section's denial never starves the others. The original had
  // the for-headers outside the catch, so a directory-permission failure
  // escaped AFTER the persistence tx and turned a committed materialize into
  // materialize_error.
  const section = (dir: string, body: () => void): void => {
    try {
      body();
    } catch (err) {
      result.failed.push({ path: dir, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const instanceDir = nodePath.join(topologyDir, "instance");
  section(instanceDir, () => {
    if (!ops.isDirectory(instanceDir)) return;
    for (const name of ops.listFiles(instanceDir)) {
      copyIfAbsent(nodePath.join(instanceDir, name), nodePath.join(input.topologyRoot, name));
    }
  });

  const rigDir = nodePath.join(topologyDir, "rig");
  section(rigDir, () => {
    if (!ops.isDirectory(rigDir)) return;
    for (const name of ops.listFiles(rigDir)) {
      copyIfAbsent(nodePath.join(rigDir, name), nodePath.join(input.topologyRoot, "rigs", input.rigName, name));
    }
  });

  const seatsDir = nodePath.join(topologyDir, "seats");
  section(seatsDir, () => {
    if (!ops.isDirectory(seatsDir)) return;
    for (const seat of ops.listDirs(seatsDir)) {
      section(nodePath.join(seatsDir, seat), () => {
        for (const name of ops.listFiles(nodePath.join(seatsDir, seat))) {
          copyIfAbsent(
            nodePath.join(seatsDir, seat, name),
            nodePath.join(input.topologyRoot, "rigs", input.rigName, "seats", seat, name),
          );
        }
      });
    }
  });

  return result;
}
