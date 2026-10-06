import type Database from "better-sqlite3";
import { RigRepository } from "./rig-repository.js";
import { makeRunningSessionCounter } from "./running-name-guard.js";
import { shellQuote } from "../adapters/shell-quote.js";
import fs from "node:fs";
import path from "node:path";

export interface BundleInstallContext {
  offered: { name: string; version: string | null; source: string };
  existing: Array<{ rigId: string; name: string; state: "running" | "stopped"; source: string | null; version: null }>;
  resolutions: string[];
}

/** Read the same session predicate as the import guard. A stored rig is not necessarily running. */
export function bundleInstallContext(
  db: Database.Database, rigName: string, offered: BundleInstallContext["offered"],
): BundleInstallContext {
  const running = makeRunningSessionCounter(db);
  const rigs = new RigRepository(db);
  const unarchived = new Set(rigs.findUnarchivedRigsByName(rigName).map(rig => rig.id));
  const existing = rigs.findRigsByName(rigName)
    .filter(rig => unarchived.has(rig.id) || running(rig.id) > 0)
    .map(rig => {
      // History records the source used, not immutable manifest bytes. Never infer
      // an installed version from an archive that may since have been replaced.
      const source = (db.prepare("SELECT source_ref FROM bootstrap_runs WHERE rig_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(rig.id) as { source_ref: string } | undefined)?.source_ref ?? null;
      return { rigId: rig.id, name: rig.name, state: running(rig.id) > 0 ? "running" as const : "stopped" as const, source, version: null };
    });
  const name = shellQuote(rigName);
  return {
    offered, existing,
    resolutions: existing.length === 0 ? [] : [
      `Use the existing team: rig ps --rig ${name} --nodes${existing.every(rig => rig.state === "stopped") ? `; resume it with rig up --existing ${name}` : "; send work to its existing seats"}.`,
      `${existing.some(rig => rig.state === "running") ? `Stop it with rig down ${name}, then retry` : "Retry"} this install to replace the stopped team. The earlier generation is archived; the result gives its rig unarchive command.`,
      "Cancel this install and keep the existing team. --target selects a directory; it does not rename a team.",
    ],
  };
}

/** Resolved member cwd is persisted at launch. A matching name alone owns no folder. */
export function isExistingBundleTarget(db: Database.Database, context: BundleInstallContext, target: string): boolean {
  const canonical = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const targetPath = canonical(target);
  const rigs = new RigRepository(db);
  return context.existing.some(rig => rigs.getRig(rig.rigId)?.nodes.some(node =>
    node.cwd && path.isAbsolute(node.cwd) && canonical(node.cwd) === targetPath));
}

export function bundleInstallContextLines(context: BundleInstallContext, includeChoices = true): string[] {
  return [
    ...context.existing.map(rig => `Installed team "${rig.name}" (${rig.rigId}): ${rig.state}; source: ${rig.source ?? "not recorded"}; version: not recorded.`),
    `Offered bundle "${context.offered.name}": version ${context.offered.version ?? "not recorded"}; source: ${context.offered.source}.`,
    ...(includeChoices ? context.resolutions : []),
  ];
}
