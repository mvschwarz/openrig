import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const scripts = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
const { spawnPython } = createRequire(import.meta.url)(path.join(scripts, "python-command.cjs"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "win32")("refocus Windows Python trace", () => {
  it("honors an explicit interpreter and does not fall through after its failure", () => {
    const args = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "Ω & %PATH% O'Brien"];
    const result = spawnPython(args, { env: { ...process.env, PYTHON: process.execPath }, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([args[2]]);
    const failed = spawnPython(["-e", "process.exit(7)"], { env: { ...process.env, PYTHON: process.execPath }, encoding: "utf8", timeout: 5000 });
    expect(failed.status).toBe(7);
    const missing = spawnPython([], { env: { ...process.env, PYTHON: "Z:/missing-owned-interpreter.exe" }, timeout: 5000 });
    expect(missing.error?.code).toBe("ENOENT");
  });

  it("executes the actual Python trace and its Windows npm CLI bridge with Unicode notes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "refocus trace O'Brien Ω ")); roots.push(root);
    const bin = path.join(root, "bin & tools"), pkg = path.join(bin, "node_modules", "@openrig", "cli");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/probe.cjs" } }));
    fs.writeFileSync(path.join(bin, "rig.cmd"), '"%dp0%\\node_modules\\@openrig\\cli\\dist\\probe.cjs" %*');
    const log = path.join(root, "calls.jsonl");
    fs.writeFileSync(path.join(pkg, "dist", "probe.cjs"), [
      `const fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');`,
      `if(args[0]==='config')process.stdout.write(${JSON.stringify(root)});else process.exit(2);`,
    ].join("\n"));
    const work = path.join(root, "missions", "owned Ω"); fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(root, "NOTES.md"), "---\nintent: 根目标 Ω\n---\nRoot notes\n");
    fs.writeFileSync(path.join(work, "NOTES.md"), "---\nintent: 保留原始内容 Ω\n---\nOwned notes\n");
    fs.writeFileSync(path.join(root, "SPEC.md"), "---\nintent: 根目标 Ω\n---\n");
    fs.writeFileSync(path.join(work, "SPEC.md"), "---\nintent: 保留原始内容 Ω\n---\n");
    const trace = path.resolve(scripts, "../../skills/refocusing/scripts/trace-to-root.py");
    // The isolated test HOME has no per-user launcher defaults. Select an actually
    // installed runtime without restoring the person's HOME or running installers.
    const listing = spawnSync("py", ["--list-paths"], { encoding: "utf8", timeout: 5000 });
    const installed = (listing.stdout + listing.stderr).split(/\r?\n/)
      .map(line => /-V:(\d+\.\d+)\s+\*?\s*(.+)$/.exec(line))
      .find(match => match && fs.existsSync(match[2]!.trim()));
    expect(installed, "native trace test requires an installed Python 3 runtime").toBeTruthy();
    const env = { ...process.env, PATH: bin + path.delimiter + (process.env.PATH ?? ""), PYTHON: undefined,
      PY_PYTHON3: installed![1], OPENRIG_NODE: process.execPath, OPENRIG_WORKSPACE_ROOT: "", PYTHONIOENCODING: "utf-8" };
    const result = spawnPython([trace, "--trees", "work", "--work-start", work, "--check"], { env, encoding: "utf8", timeout: 10000 });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout).toContain("保留原始内容 Ω");
    expect(JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]!)).toEqual(["config", "get", "workspace.root"]);

    const hook = spawnSync(process.execPath, [path.join(scripts, "refocus.cjs"), "--runtime", "claude"], {
      encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "owned-python" }),
      env: { ...env, OPENRIG_HOME: root, OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_REFOCUS_NOW: "1",
        OPENRIG_REFOCUS_TREES: "work", OPENRIG_REFOCUS_WORK_PACKET: "0", OPENRIG_REFOCUS_WORK_NODE: work,
        OPENRIG_WORKSPACE_ROOT: root, OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "",
        OPENRIG_REFOCUS_BUDGET_MS: "20000", OPENRIG_SEAT_PROJECT_DIR: "" },
    });
    expect(hook.status, hook.stderr).toBe(0);
    const content = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
    expect(content).toContain("保留原始内容 Ω");
    expect(content).not.toContain("TRACE GAP");
  });
});
