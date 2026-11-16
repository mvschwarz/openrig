import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("installed refocus YAML fallback", () => {
  it("reads a stamp without PyYAML or yaml beside the installed script", () => {
    const dir = mkdtempSync(join(tmpdir(), "refocus-installed-"));
    try {
      const source = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/plugins/openrig-core/skills/refocusing/scripts/trace-to-root.py");
      const installed = join(dir, "trace-to-root.py");
      copyFileSync(source, installed);
      const env = { ...process.env, NODE_PATH: "", PYTHONIOENCODING: "utf-8" };
      const probe = spawnSync(process.execPath, ["-e", "require.resolve('yaml', {paths: [process.argv[1]]})", dir], { encoding: "utf8", env });
      expect(probe.status).not.toBe(0);
      const python = process.env.OPENRIG_TEST_PYTHON || "python3";
      const program = `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('trace', sys.argv[1])\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nassert m.parsed_frontmatters(['---\\ncurrent_state_updated: \"2020-01-02T03:04:05Z\"\\nprogress_rail: readme-only\\n---\\n']) == [{'current_state_updated': '2020-01-02T03:04:05Z', 'progress_rail': 'readme-only'}]\nassert m.parsed_frontmatters(['---\\nprogress_rail: invalid\\nprogress_rail: readme-only\\n---\\n']) == [None]\n`;
      const result = spawnSync(python, ["-S", "-B", "-c", program, installed], { encoding: "utf8", cwd: dir, env });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
