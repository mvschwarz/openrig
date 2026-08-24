import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const REF = "packs/r5-contributing-knowledge-20260824";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function runHook(options: {
  ref?: string;
  fileContent?: string;
  rigStdout?: string;
  rigStderr?: string;
  rigStatus?: number;
}) {
  root = mkdtempSync(join(tmpdir(), "refocus-context-ref-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const argvCapture = join(root, "rig-argv.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const rig = join(bin, "rig");
  writeFileSync(rig, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RIG_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.RIG_STDOUT || "");
process.stderr.write(process.env.RIG_STDERR || "");
process.exit(Number(process.env.RIG_STATUS || 0));
`, "utf8");
  chmodSync(rig, 0o755);

  let contentFile: string | undefined;
  if (options.fileContent !== undefined) {
    contentFile = join(root, "configured.md");
    writeFileSync(contentFile, options.fileContent, "utf8");
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ""}`,
    OPENRIG_HOME: home,
    OPENRIG_SESSION_NAME: "seat@test",
    OPENRIG_REFOCUS_CONTENT_REF: options.ref,
    OPENRIG_REFOCUS_CONTENT_FILE: contentFile,
    RIG_ARGV_CAPTURE: argvCapture,
    RIG_STDOUT: options.rigStdout,
    RIG_STDERR: options.rigStderr,
    RIG_STATUS: options.rigStatus === undefined ? undefined : String(options.rigStatus),
  } as NodeJS.ProcessEnv;

  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", transcript_path: "" }),
    encoding: "utf8",
    env,
  });

  return {
    ...result,
    payload: result.stdout ? JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    } : null,
    argvCapture,
  };
}

describe("openrig-core refocus hook — context library refs", () => {
  it("REF wins over FILE and delivers the exact rig context get bytes", () => {
    const bundle = "# OpenRig Context Pack: proof v1\n\nassembled bytes\n";
    const result = runHook({ ref: REF, fileContent: "FILE MUST NOT WIN", rigStdout: bundle });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.payload?.hookSpecificOutput.additionalContext).toContain(
      `OPENRIG_REFOCUS_CONTENT_REF=${REF}`,
    );
    expect(result.payload?.hookSpecificOutput.additionalContext).not.toContain("FILE MUST NOT WIN");
    expect(result.payload?.hookSpecificOutput.additionalContext.endsWith(bundle)).toBe(true);
    expect(JSON.parse(readFileSync(result.argvCapture, "utf8"))).toEqual([
      "context", "get", REF,
    ]);
  });

  it("puts an unresolvable REF failure banner at the payload head and still delivers generic context", () => {
    const reason = `Context pack '${REF}' not found in library.`;
    const result = runHook({ ref: REF, rigStderr: `${reason}\n`, rigStatus: 1 });
    const context = result.payload?.hookSpecificOutput.additionalContext || "";

    expect(result.status).toBe(0);
    expect(context.startsWith(`REFOCUS CONTENT REF FAILED: ${REF} — ${reason}`)).toBe(true);
    expect(context).toContain("1. What is the person actually trying to get?");
    expect(context).not.toBe("1. What is the person actually trying to get?");
  });

  it("preserves FILE-only payload bytes when REF is unset", () => {
    const result = runHook({ fileContent: "configured file bytes\n" });

    expect(result.status).toBe(0);
    expect(result.payload?.hookSpecificOutput.additionalContext).toBe(
      "REFOCUS (fresh session). Answer briefly, out loud, before your next move:\n\nconfigured file bytes",
    );
  });
});
