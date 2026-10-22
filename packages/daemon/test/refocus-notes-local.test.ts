import { afterEach, expect, it } from "vitest";
import { accessSync, chmodSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveNotesFile as daemonNotes } from "../src/domain/scope/node-file.js";
import { resolveNotesFile as cliNotes } from "../../cli/src/lib/scope/scope-fs.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const trace = resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills/refocusing/scripts/trace-to-root.py");
const load = `import importlib.util, json, sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('trace',sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "local-notes-")); roots.push(root);
  const node = join(root, "custom work's root"), bin = join(root, "bin"), calls = join(root, "calls");
  mkdirSync(node); mkdirSync(bin);
  const rig = join(bin, "rig");
  // The old implementation can still resolve the same files: parity is not an exit-code test.
  writeFileSync(rig, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NOTES_CALLS"\nfor name in NOTES.md MISSION_NOTES.md; do\n if [ -f "$3/$name" ] && [ -r "$3/$name" ]; then printf '{"ok":true,"resolution":{"path":"%s","name":"%s"}}' "$3/$name" "$name"; exit 0; fi\ndone\nprintf '{"ok":true,"resolution":null}'\n`);
  chmodSync(rig, 0o755);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENRIG_"))),
    HOME: root, PATH: `${bin}:${process.env.PATH}`, NOTES_CALLS: calls };
  return { node, calls, env };
}
function python(f: ReturnType<typeof fixture>, code: string) {
  const r = spawnSync("python3", ["-B", "-c", load + code, trace, f.node], { env: f.env, encoding: "utf8", timeout: 5000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
function parity(f: ReturnType<typeof fixture>) {
  const actual = python(f, `result,error=m.resolve_notes(Path(sys.argv[2]))\nprint(json.dumps({'result':{'path':str(result[0]),'name':result[1]} if result else None,'error':error}))\n`);
  expect(actual).toEqual({ result: daemonNotes(f.node), error: null });
  expect(actual.result).toEqual(cliNotes(f.node));
}

it.each(["both", "legacy", "neither", "directory", "symlink", "dangling", "symlink-directory"])(
  "local notes match both canonical resolvers: %s", kind => {
    const f = fixture(), current = join(f.node, "NOTES.md"), legacy = join(f.node, "MISSION_NOTES.md");
    if (["both", "legacy", "directory", "dangling", "symlink-directory"].includes(kind)) writeFileSync(legacy, "legacy notes");
    if (kind === "both") writeFileSync(current, "current notes");
    if (kind === "directory") mkdirSync(current);
    if (kind === "symlink") { writeFileSync(legacy, "target notes"); symlinkSync(legacy, current); }
    if (kind === "dangling") symlinkSync(join(f.node, "absent"), current);
    if (kind === "symlink-directory") { const dir = join(f.node, "dir"); mkdirSync(dir); symlinkSync(dir, current); }
    parity(f);
  });

it.skipIf(process.getuid?.() === 0)("local notes fall through a genuinely unreadable current file", () => {
  const f = fixture(), current = join(f.node, "NOTES.md");
  writeFileSync(current, "unreadable"); writeFileSync(join(f.node, "MISSION_NOTES.md"), "readable legacy");
  chmodSync(current, 0);
  try {
    expect(() => accessSync(current, constants.R_OK)).toThrow();
    parity(f);
    expect(cliNotes(f.node)?.name).toBe("MISSION_NOTES.md");
  } finally { chmodSync(current, 0o600); }
});

it("local notes retain the later full-read race as a named gap", () => {
  const f = fixture(); writeFileSync(join(f.node, "NOTES.md"), "notes");
  writeFileSync(join(f.node, "SPEC.md"), "---\nintent: custom root intent\n---\n");
  const r = python(f, `original=m.resolve_notes\ndef raced(node):\n result,error=original(node)\n if result: result[0].unlink()\n return result,error\nm.resolve_notes=raced\nfailures=[]\ntext=m.render_work(Path(sys.argv[2]),Path(sys.argv[2]),'full',failures)\nprint(json.dumps({'text':text,'failures':failures}))\n`);
  expect(r.text).toContain("custom root intent");
  expect(r.text).toContain("NOTES RESOLUTION GAP — resolved NOTES.md became unreadable");
  expect(r.failures).toHaveLength(1);
});
