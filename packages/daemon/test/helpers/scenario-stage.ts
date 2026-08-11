/**
 * Slice 51-02 delta D1 — TOPOLOGY STAGING + per-seat stub-script delivery.
 *
 * The lock requires scenarios to resolve PER-SEAT stub scripts, and the shipped
 * stub reads exactly `<cwd>/.openrig/stub/script.json` (stub-runner-protocol) —
 * so distinct scripts require distinct seat CWDs. `rig up --cwd` cannot express
 * that: `resolveLaunchCwd(authored, specRoot, override)` makes the override win
 * for EVERY seat, so one shared cwd means one shared script.
 *
 * Therefore the pipeline stages the topology and authors a per-seat `cwd` in the
 * STAGED copy (no --cwd flag). Staging a lone YAML would rebase the spec root and
 * orphan the relative closure the committed fixtures rely on — `culture_file:
 * culture.md` and `agent_ref: "local:agents/worker"` both resolve relative to the
 * rig-spec directory — so the whole SOURCE DIRECTORY is copied and the staged YAML
 * is mutated inside it. The committed fixtures are never written to.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseStubScript } from "../../src/adapters/stub-script.js";

/** A staged, self-contained topology root with per-seat CWDs authored in place. */
export interface StagedTopology {
  /** The staged root directory (a copy of the source topology directory). */
  root: string;
  /** The staged rig-spec path to hand to `rig up`. */
  topologyPath: string;
  /** `<pod>-<member>` → that seat's absolute, existing staged cwd. */
  seatCwds: Record<string, string>;
}

/** Thrown when an `env.stub_scripts` key does not name exactly one stub seat. */
export class StubScriptTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubScriptTargetError";
  }
}

interface MemberIndexEntry {
  qualified: string;
  memberId: string;
  runtime: string | undefined;
}

function indexMembers(doc: unknown): MemberIndexEntry[] {
  const pods = (doc as { pods?: unknown }).pods;
  if (!Array.isArray(pods)) return [];
  const out: MemberIndexEntry[] = [];
  for (const pod of pods) {
    const podId = (pod as { id?: unknown }).id;
    const members = (pod as { members?: unknown }).members;
    if (typeof podId !== "string" || !Array.isArray(members)) continue;
    for (const m of members) {
      const memberId = (m as { id?: unknown }).id;
      if (typeof memberId !== "string") continue;
      out.push({
        qualified: `${podId}-${memberId}`,
        memberId,
        runtime: typeof (m as { runtime?: unknown }).runtime === "string" ? (m as { runtime: string }).runtime : undefined,
      });
    }
  }
  return out;
}

/**
 * Resolve every `env.stub_scripts` key to exactly ONE runtime:stub member, or
 * throw. Runs BEFORE any filesystem write or process spawn: a misspelled seat
 * must never silently fall to the default while its script lands in an unused
 * directory. Keys may be pod-qualified (`dev-alpha`) or a bare member id when
 * unambiguous. Returns key → qualified seat name.
 */
export function resolveStubScriptTargets(
  topologyDoc: unknown,
  stubScripts: Record<string, string>,
): Record<string, string> {
  const index = indexMembers(topologyDoc);
  const stubSeats = index.filter((e) => e.runtime === "stub").map((e) => e.qualified);
  const resolved: Record<string, string> = {};
  const claimedBy: Record<string, string> = {};

  for (const key of Object.keys(stubScripts)) {
    const matches = index.filter((e) => e.qualified === key || e.memberId === key);
    if (matches.length === 0) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}": no such seat in the topology — stub seats are: ${stubSeats.join(", ") || "(none)"}. ` +
          `A misspelled seat would silently run the built-in default while its script landed in an unused directory, so this fails loud.`,
      );
    }
    if (matches.length > 1) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}": ambiguous — matches ${matches.map((m) => m.qualified).join(", ")}. ` +
          `Use the pod-qualified form (<pod>-<member>).`,
      );
    }
    const hit = matches[0]!;
    if (hit.runtime !== "stub") {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}": seat ${hit.qualified} is runtime:${hit.runtime ?? "(unset)"}, not a stub — ` +
          `only a runtime:stub seat reads a delivered script, so a script here would never be read.`,
      );
    }
    const prior = claimedBy[hit.qualified];
    if (prior !== undefined) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}" and "${prior}" resolve to the SAME seat ${hit.qualified} (duplicate alias) — ` +
          `one seat reads exactly one script, so the intended one is unknowable.`,
      );
    }
    claimedBy[hit.qualified] = key;
    resolved[key] = hit.qualified;
  }
  return resolved;
}

/**
 * Copy the topology's SOURCE DIRECTORY into `destRoot` (self-contained: the
 * relative `culture_file` / `local:` agent closure travels with it), then author
 * an absolute, existing per-seat `cwd` into the staged YAML. Returns the staged
 * path and the seat→cwd map. The source directory is never modified.
 */
export function stageTopologyRoot(sourceTopologyPath: string, destRoot: string): StagedTopology {
  const sourceDir = dirname(resolve(sourceTopologyPath));
  const fileName = resolve(sourceTopologyPath).slice(sourceDir.length + 1);

  mkdirSync(destRoot, { recursive: true });
  cpSync(sourceDir, destRoot, { recursive: true });

  const topologyPath = join(destRoot, fileName);
  const doc = parseYaml(readFileSync(topologyPath, "utf-8")) as Record<string, unknown>;

  const seatCwds: Record<string, string> = {};
  const pods = Array.isArray(doc.pods) ? doc.pods : [];
  for (const pod of pods) {
    const podId = (pod as { id?: unknown }).id;
    const members = (pod as { members?: unknown }).members;
    if (typeof podId !== "string" || !Array.isArray(members)) continue;
    for (const m of members) {
      const memberId = (m as { id?: unknown }).id;
      if (typeof memberId !== "string") continue;
      const qualified = `${podId}-${memberId}`;
      // Own dir per seat: the stub reads <cwd>/.openrig/stub/script.json, and the
      // seat's managed writes (AGENTS.md, readiness sidecar) stay in scratch.
      const cwd = join(destRoot, "seat-cwd", qualified);
      mkdirSync(cwd, { recursive: true });
      (m as Record<string, unknown>).cwd = cwd;
      seatCwds[qualified] = cwd;
    }
  }

  writeFileSync(topologyPath, stringifyYaml(doc), "utf-8");
  return { root: destRoot, topologyPath, seatCwds };
}

/**
 * Write each mapped seat's script to ITS OWN staged cwd. An unmapped seat gets no
 * file at all, so 51-01's built-in default applies — never a neighbour's script.
 * Validates through the SHIPPED parser (stub-script.ts), so a malformed script
 * fails here rather than at seat boot.
 */
export function deliverStubScripts(
  staged: StagedTopology,
  stubScripts: Record<string, string>,
  scenarioDir: string,
): void {
  const targets = resolveStubScriptTargets(
    parseYaml(readFileSync(staged.topologyPath, "utf-8")),
    stubScripts,
  );
  for (const [key, seat] of Object.entries(targets)) {
    const rel = stubScripts[key]!;
    const scriptPath = isAbsolute(rel) ? rel : resolve(scenarioDir, rel);
    let raw: string;
    try {
      raw = readFileSync(scriptPath, "utf-8");
    } catch (err) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}": cannot read script ${scriptPath} — ${(err as Error).message}`,
      );
    }
    // Shipped-parser validation: the same contract the stub runner enforces at
    // boot (it takes the raw JSON text), applied here so an authoring error
    // surfaces before any seat launches rather than as a dead seat.
    parseStubScript(raw);
    const dir = join(staged.seatCwds[seat]!, ".openrig", "stub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "script.json"), raw, "utf-8");
  }
}
