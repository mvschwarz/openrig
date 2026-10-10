import fs from "node:fs";
import path from "node:path";
import { parseSessionName } from "./session-name.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** The existing pod state scope; malformed and legacy names do not invent a pod. */
export function codexQueueStateRoot(sessionName: string, sharedDocsRoot: string): string | undefined {
  const parsed = parseSessionName(sessionName.trim());
  if (parsed.kind !== "canonical") return undefined;
  const separator = parsed.member.indexOf("-");
  if (separator <= 0 || separator === parsed.member.length - 1) return undefined;
  const pod = parsed.member.slice(0, separator), member = parsed.member.slice(separator + 1);
  if (![pod, member, parsed.rig].every(s => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))) return undefined;
  return path.join(sharedDocsRoot, "rigs", parsed.rig, "state", pod);
}

/** Only called for the derived team default. No permission/config files are written. */
export function prepareCodexTeamWorkspace(
  sessionName: string, workspaceRoot: string, sharedDocsRoot: string, home: string,
): string[] {
  const roots = [workspaceRoot, codexQueueStateRoot(sessionName, sharedDocsRoot)].filter((p): p is string => !!p);
  const homePath = fs.realpathSync(home);
  return [...new Set(roots)].flatMap(root => {
    try {
      if (!path.isAbsolute(root)) throw new Error("workspace path must be absolute");
      // Codex cannot create missing ancestors outside its writable roots. Prepare exactly
      // the selected roots before it starts, including the previously missing pod state leaf.
      fs.mkdirSync(root, { recursive: true });
      const resolved = fs.realpathSync(root);
      const relativeHome = path.relative(resolved, homePath);
      if (!relativeHome || (!relativeHome.startsWith(`..${path.sep}`) && relativeHome !== ".." && !path.isAbsolute(relativeHome))) {
        throw new Error("team default does not grant the home directory or its ancestors");
      }
      return [root];
    } catch (error) {
      console.warn(`[openrig] Codex team workspace not added (${root}): ${(error as Error).message}`);
      return [];
    }
  });
}

export type PrepareCodexTeamWorkspace = (sessionName: string) => string[];

/** A failed optional scope preparation leaves the existing launch available, with a warning. */
export function codexTeamWorkspaceArg(prepare: PrepareCodexTeamWorkspace | undefined, sessionName: string): string {
  if (!prepare) return "";
  try { return prepare(sessionName).map(root => ` --add-dir ${shellQuote(root)}`).join(""); }
  catch (error) {
    console.warn(`[openrig] Codex team workspace unavailable: ${(error as Error).message}`);
    return "";
  }
}
