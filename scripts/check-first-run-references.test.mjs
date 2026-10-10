import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { checkReferences, commandReference, formatReference, readSurface, references, SCOPE } from "./check-first-run-references.mjs";

function program() {
  const root = new Command("rig").option("--json").option("-o, --output <format>");
  root.addCommand(new Command("up").argument("<spec>"));
  root.addCommand(new Command("send").argument("<seat>").argument("<body>"));
  root.addCommand(new Command("queue").addCommand(new Command("list").alias("ls")));
  root.addCommand(new Command("specs").addCommand(new Command("preview").argument("<name>")));
  return root;
}

function fixture(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-refs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/start.md"), text);
  const teams = new Map([["starter", { seats: ["dev-build", "dev-review"], source: "specs/starter/rig.yaml" }]]);
  return { root, authority: { program: program(), skills: new Map([["good-skill", "skills/good-skill/SKILL.md"]]), team: async (name) => teams.get(name) }, scope: [{ file: "docs/start.md", team: "starter" }] };
}

test("literal nested commands use the real tree shape and aliases; leaf operands are not verbs", () => {
  assert.equal(commandReference("rig queue ls --json", program()).verbs, "rig queue list");
  assert.equal(commandReference("rig queue lsst", program()).error, "unknown verb rig queue lsst");
  assert.equal(commandReference("rig gone", program()).error, "unknown verb rig gone");
  assert.equal(commandReference("rig --json queue lsst", program()).error, "unknown verb rig queue lsst");
  assert.equal(commandReference("rig -o json queue ls", program()).verbs, "rig queue list");
  assert.deepEqual(commandReference("rig send dev-build@starter 'fix the queue'", program()).args, ["dev-build@starter", "fix the queue"]);
});

test("prose starting with rig is not a shell example; fenced examples still are", () => {
  const text = 'Do not erase the\nrig or start a duplicate.\n```sh\nrig queue gone\n```';
  assert.deepEqual(references(text).filter((r) => r.kind === "command").map((r) => [r.value,r.line]), [["rig queue gone",4]]);
});

test("printed prose after a command's default action is not another verb", () => {
  const p = program();
  const tui = new Command("tui").option("--shared").action(() => { throw new Error("must not execute"); });
  tui.addCommand(new Command("commands")); p.addCommand(tui);
  assert.equal(commandReference("rig tui --shared joins the existing view",p,{prose:true}).verbs,"rig tui");
  assert.equal(commandReference("rig tui opens an independent view",p,{prose:true}).verbs,"rig tui");
  assert.equal(commandReference("rig tui commands",p).verbs,"rig tui commands");
  assert.match(commandReference("rig tui commnads",p).error,/unknown verb/);
  assert.match(commandReference("rig queue lsst",p,{prose:true}).error,/unknown verb/);
});

test("reports every reference category with original file, line and authority", async (t) => {
  const f = fixture(t, ["# First run", "`rig queue gone`", "`rig up missing-team`", "`dev-owner@starter`", "Use the `missing-skill` skill.", "[guide](missing.md)", "`packages/no-file.ts`"].join("\n"));
  const report = await checkReferences(f.root, f.scope, f.authority);
  assert.deepEqual(report.failures.map((r) => [r.kind, r.line]), [["command", 2], ["team", 3], ["seat", 4], ["skill", 5], ["link", 6], ["path", 7]]);
  for (const r of report.failures) {
    assert.match(formatReference(r), /^docs\/start.md:\d+: .*checked against .+/);
  }
});

test("known references pass, and moving a referenced file makes the check fail", async (t) => {
  const f = fixture(t, "`rig up starter`\n`dev-build@starter`\nUse the `good-skill` skill.\n[guide](guide.md#start)");
  fs.writeFileSync(path.join(f.root, "docs/guide.md"), "# Start\n");
  assert.equal((await checkReferences(f.root, f.scope, f.authority)).failures.length, 0);
  fs.renameSync(path.join(f.root, "docs/guide.md"), path.join(f.root, "docs/moved.md"));
  assert.equal((await checkReferences(f.root, f.scope, f.authority)).failures[0].value, "guide.md");
});

test("template addresses and user paths do not masquerade as concrete references", async (t) => {
  const f = fixture(t, '`rig up <team>` `rig up ./my-team/rig.yaml` `dev-build@<team>` `dev-build@$team` `~/.codex/config.toml`');
  const result = await checkReferences(f.root, f.scope, f.authority);
  assert.equal(result.failures.length, 0);
  assert.equal(result.checked.filter((r) => r.kind === "seat").length, 0);
});

test("external workshop is explicitly unchecked, while unknown teams fail", async (t) => {
  const f = fixture(t, '`rig up workshop` `orch-lead@workshop` `rig up workshopp`');
  const result = await checkReferences(f.root, f.scope, f.authority);
  assert.equal(result.unchecked.length, 2);
  assert.equal(result.failures.length, 1);
  assert.match(result.unchecked[0].against, /openrig-world/);
});

test("team table names and team bullets are references, not their runtimes or model names", () => {
  const text = '| Choice | Starter name | Runtime |\n| --- | --- | --- |\n| Two agents | `starter` | Both `codex`, model `model-x` |\n- `factory`: seven agents\nThe `pm` team on the shelf.';
  assert.deepEqual(references(text).filter((r) => r.kind === "team").map((r) => r.value), ["starter", "factory", "pm"]);
});

test("new team-first tables, prose lists and printed choices also bind names", () => {
  assert.deepEqual(references('| Team | For |\n| --- | --- |\n| `starter` | Work |\nteams `code-review`, `research` and `pm`.').filter((r) => r.kind === "team").map((r) => r.value), ["starter", "code-review", "research", "pm"]);
  assert.deepEqual(references('Teams: starter (two), workshop (bundle) or factory (seven)', {printed:true}).filter((r) => r.kind === "team").map((r) => r.value), ["starter", "workshop", "factory"]);
});

test("multi-line command and skill references preserve source line", () => {
  const text = '# Start\nUse the `good-skill`\n  skill.\n`rig specs\n preview starter`\nIts skills (`one`,\n`two`) are listed.';
  const refs = references(text);
  assert.deepEqual(refs.filter((r) => r.kind === "skill").map((r) => [r.value, r.line]), [["good-skill", 2], ["one", 6], ["two", 7]]);
  assert.equal(refs.find((r) => r.kind === "command").line, 4);
});

test("unqualified seats bind to their lead's team", async (t) => {
  const f = fixture(t, "You build it and `dev-review` checks it; `dev-reveiw` is a typo.");
  const report = await checkReferences(f.root, f.scope, f.authority);
  assert.deepEqual(report.failures.map((r) => r.value), ["dev-reveiw"]);
});

test("setup scan is only the printed function, not unrelated tests or code", (t) => {
  const f = fixture(t, "");
  fs.writeFileSync(path.join(f.root, "setup.ts"), ['const ignored = "rig typo";', 'export function goldenPathNextSteps(): string[] {', '  return ["rig queue list", "rig up missing"];', '}'].join("\n"));
  assert.deepEqual(readSurface(f.root, { file: "setup.ts", function: "goldenPathNextSteps" }), [
    { text: "rig queue list", line: 3 }, { text: "rig up missing", line: 3 },
  ]);
  assert.throws(() => readSurface(f.root, { file: "setup.ts", function: "renamed" }), /missing printed-text/);
});

test("zero files, absent declared files, and empty surfaces cannot pass", async (t) => {
  const f = fixture(t, "");
  await assert.rejects(checkReferences(f.root, [], f.authority), /zero files/);
  assert.match((await checkReferences(f.root, f.scope, f.authority)).failures[0].reason, /empty/);
  const result = await checkReferences(f.root, [{ file: "gone.md" }], f.authority);
  assert.equal(result.failures[0].against, "explicit SCOPE");
  assert.equal(SCOPE.length, new Set(SCOPE.map((s) => s.file)).size);
});

test("installed documentation and spec paths map back to their shipped source", async (t) => {
  const f = fixture(t, '`daemon/docs/reference/start.md`\n`specs/rigs/launch/starter/rig.yaml`');
  fs.mkdirSync(path.join(f.root, "docs/reference"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "docs/reference/start.md"), "guide");
  const report = await checkReferences(f.root, f.scope, f.authority);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].against, "packages/daemon/specs/rigs/launch/starter/rig.yaml");
});

test("skill paths preserve their directory, and may refer to shipped helper files", async (t) => {
  const f = fixture(t, '`skills/good-skill/SKILL.md` `skills/good-skill/helper.sh` `skills/wrong/good-skill/SKILL.md`');
  const dir = path.join(f.root,"packages/daemon/assets/plugins/openrig-core/skills/good-skill");
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"SKILL.md"),"# Skill");
  fs.writeFileSync(path.join(dir,"helper.sh"),"echo helper");
  const report = await checkReferences(f.root,f.scope,f.authority);
  assert.deepEqual(report.failures.map((r) => r.value),["skills/wrong/good-skill/SKILL.md"]);
});

test("repository skills/ paths and the daemon's global skills are real homes; a missing skill still fails", async (t) => {
  const f = fixture(t, '`skills/rigs/SKILL.md` [rigs](../skills/rigs/SKILL.md) `skills/global-only/SKILL.md` `skills/nowhere/SKILL.md`');
  for (const dir of ["skills/rigs", "packages/daemon/assets/skills/global-only"]) {
    fs.mkdirSync(path.join(f.root, dir), { recursive: true });
    fs.writeFileSync(path.join(f.root, dir, "SKILL.md"), "# Skill");
  }
  const report = await checkReferences(f.root, f.scope, f.authority);
  assert.deepEqual(report.failures.map((r) => r.value), ["skills/nowhere/SKILL.md"]);
  assert.deepEqual(report.checked.map((r) => [r.kind, r.against]), [
    ["path", "skills/rigs/SKILL.md"], ["path", "packages/daemon/assets/skills/global-only/SKILL.md"], ["link", "skills/rigs/SKILL.md"],
  ]);
});
