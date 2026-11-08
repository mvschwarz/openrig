import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// #2693: a catalogued project can live outside workspace.root. The trace takes extra work
// roots from --work-root or OPENRIG_REFOCUS_WORK_ROOT (refocus-only, unlike
// OPENRIG_WORKSPACE_ROOT, which the CLI config store also reads) and ascends from the
// deepest known root that contains the node.
const HERE = dirname(fileURLToPath(import.meta.url));
const TRACE = resolve(HERE, "../assets/plugins/openrig-core/skills/refocusing/scripts/trace-to-root.py");

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A workspace, plus a catalogued project (project-b) and its mission outside it. */
function world() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "refocus-work-root-")));
  const workspace = join(root, "workspace");
  const projectB = join(root, "project-b");
  const mission = join(projectB, "missions/m1");
  const local = join(workspace, "missions/local");
  for (const dir of [mission, local]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, "SPEC.md"), "---\nintent: run the workspace\n---\n# Workspace\n");
  writeFileSync(join(local, "SPEC.md"), "---\nintent: local mission\n---\n# Local\n");
  writeFileSync(join(projectB, "SPEC.md"), "---\nintent: ship project b\n---\n# Project B\n");
  writeFileSync(join(mission, "SPEC.md"), "---\nintent: mission one\n---\n# Mission 1\n");
  // No `rig` on PATH: the script must not need the daemon for any of this.
  const env = { PATH: "/usr/bin:/bin", HOME: root, OPENRIG_WORKSPACE_ROOT: workspace };
  const trace = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("python3", [TRACE, "--trees", "work", "--check", ...args], { encoding: "utf8", env: { ...env, ...extra } });
  return { workspace, projectB, mission, local, trace };
}

describe("refocus trace work roots (#2693)", () => {
  it("still reports a node outside every known root as a gap", () => {
    const w = world();
    const result = w.trace(["--work-start", w.mission]);
    expect(result.stdout).toContain(`TRACE GAP — start is outside configured root: ${w.mission}`);
    expect(result.status).toBe(1);
  });

  it("traces a catalogued project outside workspace.root from --work-root", () => {
    const w = world();
    const result = w.trace(["--work-start", w.mission, "--work-root", w.projectB]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${w.projectB}`);
    expect(result.stdout).toContain("intent: ship project b");
    expect(result.stdout).toContain("intent: mission one");
    expect(result.stdout).not.toContain("TRACE GAP");
  });

  it("takes extra roots from OPENRIG_REFOCUS_WORK_ROOT without changing workspace.root", () => {
    const w = world();
    const other = join(root!, "elsewhere");
    mkdirSync(other);
    const result = w.trace(["--work-start", w.mission], { OPENRIG_REFOCUS_WORK_ROOT: [other, w.projectB].join(delimiter) });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${w.projectB}`);
  });

  it("keeps workspace.root for a node inside it, even with extra roots set", () => {
    const w = world();
    const result = w.trace(["--work-start", w.local, "--work-root", w.projectB]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${w.workspace}`);
    expect(result.stdout).toContain("intent: run the workspace");
  });

  it("uses the deepest root when known roots nest", () => {
    const w = world();
    const nested = join(w.workspace, "nested");
    const node = join(nested, "missions/n1");
    mkdirSync(node, { recursive: true });
    writeFileSync(join(nested, "SPEC.md"), "---\nintent: nested project\n---\n");
    writeFileSync(join(node, "SPEC.md"), "---\nintent: nested mission\n---\n");
    const result = w.trace(["--work-start", node, "--work-root", nested]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${nested}`);
    expect(result.stdout).not.toContain("intent: run the workspace");
  });
});

describe("refocus hook forwards the daemon's catalogued work roots (#2693)", () => {
  const HOOK = resolve(HERE, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");

  // The hook gives each lookup, the python3 trace included, a 2 s cap by default. A loaded CI runner can take longer
  // than that to run python3 (#2744 and #2751 failed so), so these runs select the documented largest budget, which
  // gives each lookup up to about 23 s, and allow the test time to match.
  const HOOK_BUDGET_MS = "52000";
  const HOOK_TEST_TIMEOUT_MS = 60_000;

  /** Runs the shipped hook with a stub `rig` whose `queue whoami` names a node in project-b; `slowPythonSeconds`
   *  puts a python3 that waits that long first on the hook's PATH, as a slow runner would. */
  function fireHook(sendWorkRoots: boolean, slowPythonSeconds = 0) {
    const w = world();
    const workRoots = sendWorkRoots ? [w.projectB] : undefined;
    const bin = join(root!, "bin");
    mkdirSync(bin, { recursive: true });
    const whoami = {
      currentWork: { mission: "m1", slice: "", workNodePath: w.mission, basis: "one typed in-progress work node" },
      currentWorkBasis: "one typed in-progress work node",
      role: { state: "not-declared", files: [] },
      ...(workRoots ? { workRoots } : {}),
    };
    writeFileSync(join(bin, "rig"), `#!/bin/sh
if [ "$1 $2" = "queue whoami" ]; then printf '%s' "$RIG_QUEUE_WHOAMI_STDOUT"; exit 0; fi
if [ "$1 $2" = "config --json" ]; then printf '{}'; exit 0; fi
exit 1
`, { mode: 0o755 });
    if (slowPythonSeconds > 0) {
      writeFileSync(join(bin, "python3"), `#!/bin/sh\nsleep ${slowPythonSeconds}\nPATH=/usr/bin:/bin exec python3 "$@"\n`, { mode: 0o755 });
    }
    const home = join(root!, "home");
    mkdirSync(home, { recursive: true });
    const result = spawnSync(process.execPath, [HOOK, "--runtime", "claude"], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "work-root-fixture", transcript_path: "" }),
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "builder@demo",
        OPENRIG_WORKSPACE_ROOT: w.workspace, OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_TREES: "work", OPENRIG_REFOCUS_BUDGET_MS: HOOK_BUDGET_MS,
        OPENRIG_REFOCUS_WORK_PACKET: "0", OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "",
        RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify(whoami),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return { w, out: result.stdout };
  }

  it("traces a catalogued project's node with no --work-root or OPENRIG_REFOCUS_WORK_ROOT set", () => {
    const { w, out } = fireHook(true);
    expect(out).toContain(`root: ${w.projectB}`);
    expect(out).toContain("intent: mission one");
    expect(out).not.toContain("outside configured root");
  }, HOOK_TEST_TIMEOUT_MS);

  it("still reports the gap when the daemon names no work roots (an older daemon)", () => {
    const { out } = fireHook(false);
    expect(out).toContain("outside configured root");
  }, HOOK_TEST_TIMEOUT_MS);

  it("still traces when python3 is slower than the default 2 s lookup cap, as on a loaded runner", () => {
    const { w, out } = fireHook(true, 3);
    expect(out).not.toContain("ETIMEDOUT");
    expect(out).toContain(`root: ${w.projectB}`);
  }, HOOK_TEST_TIMEOUT_MS);
});
