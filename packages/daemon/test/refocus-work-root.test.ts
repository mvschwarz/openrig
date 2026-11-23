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

// #3320: with no typed baton, the broad orientation is the seat's selected project, not workspace.root.
const NO_BATON = "no typed in-progress work (only in-progress rows are considered; a typed row that is pending or blocked is not current work)";

describe("refocus trace with no typed baton (#3320)", () => {
  it("orients from the selected project when it lives outside workspace.root", () => {
    const w = world();
    const result = w.trace(["--work-basis", NO_BATON, "--work-root", w.projectB, "--work-project", w.projectB]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${w.projectB}`);
    expect(result.stdout).toContain("FALLBACK — no current typed baton");
    expect(result.stdout).toContain("intent: ship project b");
    expect(result.stdout).not.toContain("intent: run the workspace");
  });

  it("names why no project was selected and keeps the workspace orientation", () => {
    const w = world();
    const result = w.trace(["--work-basis", NO_BATON, "--work-project-unknown", "multiple projects are declared (candidates: a, b)"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${w.workspace}`);
    expect(result.stdout).toContain("PROJECT UNSELECTED — multiple projects are declared (candidates: a, b)");
  });

  /** Work-packet mode: the hook sends the daemon's candidate evidence instead of a basis. */
  function candidates(evidence: object) {
    const file = join(root!, "candidates.json");
    writeFileSync(file, JSON.stringify(evidence));
    return file;
  }
  const HELD = { qitemId: "q-held", summary: "waiting on review", blockedOn: "review" };
  const NEXT = { qitemId: "q-next", summary: "pending follow-up" };

  it("orients work-packet mode from the selected project when nothing is in progress", () => {
    const w = world();
    const result = w.trace(["--packet", "--work-candidates", candidates({ candidates: [], held: [HELD], next: [NEXT] }),
      "--work-root", w.projectB, "--work-project", w.projectB]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("## ORIENTATION — the selected project's chain, not your work");
    expect(result.stdout).toContain(`root: ${w.projectB}`);
    expect(result.stdout).toContain("intent: ship project b");
    expect(result.stdout).not.toContain("intent: run the workspace");
    // Held and pending work stay evidence, never adopted as current work.
    expect(result.stdout).toContain("No in-progress queue row names your work");
    expect(result.stdout).toContain("HELD WORK (blocked; this is not next):");
    expect(result.stdout).toContain("POSSIBLE NEXT WORK (pending; no order implied):");
  });

  it("names why no project was selected in work-packet mode and keeps the workspace orientation", () => {
    const w = world();
    const result = w.trace(["--packet", "--work-candidates", candidates({ candidates: [] }),
      "--work-project-unknown", "workspace.yaml projects must each declare string id and root values"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PROJECT UNSELECTED — workspace.yaml projects must each declare string id and root values");
    expect(result.stdout).toContain(`root: ${w.workspace}`);
  });

  it("keeps the workspace orientation in work-packet mode while candidates are in flight", () => {
    const w = world();
    const inFlight = [{ mission: "m1", kind: "mission", source: "row q1" }, { mission: "m2", kind: "mission", source: "row q2" }];
    const result = w.trace(["--packet", "--work-candidates", candidates({ candidates: inFlight }), "--work-project", w.projectB]);
    expect(result.stdout).toContain("2 candidates are in flight");
    expect(result.stdout).toContain(`root: ${w.workspace}`);
    expect(result.stdout).not.toContain("intent: ship project b");
  });

  /** The daemon's evidence: workspace.root's listing, and the selected project's own missions beside it. */
  const projectEvidence = (w: ReturnType<typeof world>, extra: object = {}) => ({
    missionsRoot: join(w.workspace, "missions"), missionsOnHost: ["local"], missionsOnHostTruncated: false,
    projectMissions: { project: "project-b", missionsRoot: join(w.projectB, "missions"), names: ["m1"], truncated: false },
    ...extra,
  });

  it("lists the selected project's missions and names its missions root when nothing is in progress", () => {
    const w = world();
    const result = w.trace(["--packet", "--work-candidates", candidates({ candidates: [], ...projectEvidence(w) }),
      "--work-root", w.projectB, "--work-project", w.projectB]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Missions in the selected project (project-b): m1");
    expect(result.stdout).toContain(`--work-root ${w.projectB} --work-start ${join(w.projectB, "missions")}/<mission>`);
    expect(result.stdout).not.toContain("Missions on this host");
    expect(result.stdout).not.toContain(`--work-start ${join(w.workspace, "missions")}/`);
    expect(result.stdout).toContain("## ORIENTATION — the selected project's chain, not your work");
    // The printed next step is the agent's own call: run it in a fresh process, with no extra root in its environment.
    const next = result.stdout.split("\n").find((line) => line.includes("--work-start"))!.trim().replace("<mission>", "m1");
    const followed = spawnSync("/bin/sh", ["-c", next], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root!, OPENRIG_WORKSPACE_ROOT: w.workspace } });
    expect(followed.status, followed.stdout + followed.stderr).toBe(0);
    expect(followed.stdout).toContain("intent: mission one");
    expect(followed.stdout).toContain("intent: ship project b");
    expect(followed.stdout).not.toContain("TRACE GAP");
  });

  it("keeps workspace.root's listing when no project is selected, the daemon names none, or its root isn't the project's", () => {
    const w = world();
    const hostListing = (evidence: object, project: string[]) => {
      const result = w.trace(["--packet", "--work-candidates", candidates({ candidates: [], ...evidence }), ...project]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Missions on this host: local");
      expect(result.stdout).toContain(`--work-start ${join(w.workspace, "missions")}/<mission>`);
      expect(result.stdout).not.toContain("Missions in the selected project");
    };
    hostListing(projectEvidence(w), []);
    // A daemon that predates the field sends no projectMissions (JSON drops the undefined key).
    hostListing(projectEvidence(w, { projectMissions: undefined }), ["--work-root", w.projectB, "--work-project", w.projectB]);
    hostListing(projectEvidence(w, { projectMissions: { project: "other", missionsRoot: join(w.workspace, "missions"), names: ["local"] } }),
      ["--work-root", w.projectB, "--work-project", w.projectB]);
  });

  it("keeps workspace.root's listing and command while candidates are in flight, even with the project's missions", () => {
    const w = world();
    const inFlight = [{ mission: "m1", kind: "mission", source: "row q1" }, { mission: "m2", kind: "mission", source: "row q2" }];
    const result = w.trace(["--packet", "--work-candidates", candidates({ candidates: inFlight, ...projectEvidence(w) }),
      "--work-project", w.projectB]);
    expect(result.stdout).toContain(`--work-start ${join(w.workspace, "missions")}/<mission>`);
    expect(result.stdout).not.toContain("Missions in the selected project");
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
  function fireHook(sendWorkRoots: boolean, slowPythonSeconds = 0, noBaton = false) {
    const w = world();
    const workRoots = sendWorkRoots ? [w.projectB] : undefined;
    const bin = join(root!, "bin");
    mkdirSync(bin, { recursive: true });
    const whoami = noBaton ? {
      currentWork: null,
      currentWorkBasis: NO_BATON,
      role: { state: "not-declared", files: [] },
      workRoots: [w.projectB],
      workProject: { id: "project-b", root: w.projectB, selectedBy: "rig" },
    } : {
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

  it("orients from the daemon's selected project when there is no typed baton (#3320)", () => {
    const { w, out } = fireHook(true, 0, true);
    expect(out).toContain(`root: ${w.projectB}`);
    expect(out).toContain("FALLBACK — no current typed baton");
    expect(out).toContain("intent: ship project b");
  }, HOOK_TEST_TIMEOUT_MS);
});
