import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { probeReapWorkspace, reapWorkspacePaths } from "../src/domain/seat-reaper-workspace.js";
import { fixture } from "./seat-reaper-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository() {
  const root = mkdtempSync(join(tmpdir(), "seat-reaper-git-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root,
    env: { ...process.env, GIT_MASTER: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main"); writeFileSync(join(root, "tracked"), "one\n"); git("add", "tracked"); git("commit", "-m", "fixture");
  git("branch", "upstream"); git("config", "branch.main.remote", "."); git("config", "branch.main.merge", "refs/heads/upstream");
  return { root, git };
}

it.each(["clean", "untracked", "tracked", "unpushed", "missing-upstream"])("classifies a real git repository: %s", async scenario => {
  // Given a private repository with a local upstream reference (no network or push).
  const repo = repository();
  switch (scenario) {
    case "clean": break;
    case "untracked": writeFileSync(join(repo.root, "untracked"), "work"); break;
    case "tracked": writeFileSync(join(repo.root, "tracked"), "changed"); break;
    case "unpushed": writeFileSync(join(repo.root, "tracked"), "two\n"); repo.git("add", "tracked"); repo.git("commit", "-m", "local"); break;
    case "missing-upstream": repo.git("config", "--unset", "branch.main.remote"); break;
    default: throw Error(`unexpected scenario ${scenario}`);
  }
  // When the production git guard reads it.
  const result = await probeReapWorkspace([repo.root]);
  // Then only clean, fully upstream-contained work is safe.
  expect(result).toBe(scenario === "clean" ? "clean" : scenario === "missing-upstream" ? "defer-probe-failed" : "dirty-workspace");
});

it("skips all seats when any workspace repository is dirty", async () => {
  // Given two clean repos, then untracked work in the second repo of one rig.
  const first = repository(), second = repository(); writeFileSync(join(second.root, "untracked"), "precious work");
  const f = fixture(); f.db.prepare("UPDATE rigs SET workspace_json=?").run(JSON.stringify({ workspaceRoot: first.root,
    repos: [{ name: "first", path: first.root }, { name: "second", path: second.root }] }));
  f.db.prepare("UPDATE nodes SET cwd=?").run(first.root);
  f.db.exec(`INSERT INTO nodes(id,rig_id,logical_id,runtime,cwd) SELECT 'a2','r','other','pi',cwd FROM nodes WHERE id='a';
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b2','a2','other@test','%2');
    INSERT INTO sessions(id,node_id,session_name,status,origin,startup_status) VALUES ('s2','a2','other@test','running','launched','ready');`);
  f.deps.workspaceProbe = async () => probeReapWorkspace([first.root, second.root]);
  // When scanning the rig with the real git probe.
  await f.mature();
  // Then both seats get the rig-level refusal, not just the repo's apparent owner.
  expect(f.stops).toEqual([]);
  expect(new Set(f.events().filter(e => e.decision === "dirty-workspace").map(e => e.nodeId))).toEqual(new Set(["a", "a2"]));
});

it("includes every declared repository plus seat directories and rejects missing workspaces", async () => {
  // Given a normalized workspace block.
  const raw = JSON.stringify({ workspaceRoot: "/workspace", repos: [{ path: "/one" }, { path: "/two" }], knowledgeRoot: "/knowledge" });
  // When collecting the rig-granularity guard scope.
  const paths = reapWorkspacePaths(raw, ["/one", "/extra"]);
  // Then no repo is omitted and lack of any path is a failed probe.
  expect(paths).toEqual(["/one", "/two", "/knowledge", "/extra"]);
  expect(await probeReapWorkspace([])).toBe("defer-probe-failed");
});

// #3836 review: inherited repo-location variables (GIT_DIR/GIT_WORK_TREE/…) can point the
// probe at another clean repository, reporting a dirty workspace as clean — the destructive
// direction. The probe strips them, so it still reads the workspace it was given.
it("ignores inherited git repo-location variables when probing", async () => {
  const repo = repository();
  writeFileSync(join(repo.root, "untracked"), "work");
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(tmpdir(), "elsewhere.git");
  process.env.GIT_WORK_TREE = tmpdir();
  try {
    expect(await probeReapWorkspace([repo.root])).toBe("dirty-workspace");
  } finally {
    if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.GIT_DIR;
    if (saved.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE;
  }
});
