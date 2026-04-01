import fs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  filterNodesForRigId,
  selectCurrentRigSummary,
} from "../../packages/daemon/src/domain/demo-rig-selector.js";

export interface DemoRigSummary {
  rigId: string;
  name: string;
  nodeCount?: number;
  status?: string;
}

export interface DemoNodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  nodeKind: string;
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  restoreOutcome: string | null;
  resumeType?: string | null;
  resumeToken?: string | null;
  latestError?: string | null;
  cwd?: string | null;
}

export function repoRoot(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i++;
  }
  return result;
}

export function runCommand(command: string, args: string[], cwd = repoRoot()): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function runRigged(args: string[]): string {
  return runCommand("rigged", args);
}

export function runRiggedJson<T>(args: string[]): T {
  const output = runRigged(args);
  return JSON.parse(output) as T;
}

export function runTmux(args: string[], cwd = repoRoot()): string {
  return runCommand("tmux", args, cwd);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function listRigSummaries(): DemoRigSummary[] {
  return runRiggedJson<DemoRigSummary[]>(["ps", "--json"]);
}

export function listRigNodes(rigName: string): DemoNodeEntry[] {
  const summary = selectCurrentRigSummary(listRigSummaries(), rigName);
  if (!summary) {
    return [];
  }
  return filterNodesForRigId(
    runRiggedJson<DemoNodeEntry[]>(["ps", "--nodes", "--json"]),
    summary.rigId
  );
}

export function resolveNodeCwd(cwdValue: string | null | undefined): string {
  if (!cwdValue || cwdValue === ".") return repoRoot();
  if (nodePath.isAbsolute(cwdValue)) return cwdValue;
  return nodePath.resolve(repoRoot(), cwdValue);
}

export function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function writeJson(outputPath: string, data: unknown): void {
  fs.mkdirSync(nodePath.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function isAgentRuntime(runtime: string | null): boolean {
  return runtime === "claude-code" || runtime === "codex";
}
