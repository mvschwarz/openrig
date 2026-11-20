import { describe, expect, it } from "vitest";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("installed refocus YAML fallback", () => {
  it("uses the installed CLI parser for canonical, flow and nested metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "refocus-installed-"));
    try {
      const source = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/plugins/openrig-core/skills/refocusing/scripts/trace-to-root.py");
      const installed = join(dir, "trace-to-root.py");
      copyFileSync(source, installed);
      const bin = join(dir, "bin");
      const cli = join(bin, "node_modules", "@openrig", "cli");
      mkdirSync(join(cli, "node_modules"), { recursive: true });
      const require = createRequire(import.meta.url);
      cpSync(dirname(require.resolve("yaml/package.json")), join(cli, "node_modules", "yaml"), { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "rig.cmd" : "rig"), "", { mode: 0o755 });
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, NODE_PATH: "", PATH: [bin, process.env.PATH].join(delimiter), PYTHONIOENCODING: "utf-8" };
      const python = process.env.OPENRIG_TEST_PYTHON || "python3";
      const program = `import importlib.util, pathlib, sys\nspec = importlib.util.spec_from_file_location('trace', sys.argv[1])\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\ncanonical = '---\\ncurrent_state_updated: \"2020-01-02T03:04:05Z\"\\nprogress_rail: readme-only\\n---\\n'\nflow = '---\\n{progress_rail: readme-only, current_state_updated: \"2020-01-02T03:04:05Z\"}\\n---\\n'\nnested = '---\\nnotes: |\\n  current_state_updated: 2020-01-02T03:04:05Z\\n  progress_rail: readme-only\\n---\\n'\na, b, c = m.parsed_frontmatters([canonical, flow, nested])\nassert a == b == {'current_state_updated': '2020-01-02T03:04:05Z', 'progress_rail': 'readme-only'}\nassert 'current_state_updated' not in c and 'progress_rail' not in c\nroot = pathlib.Path(sys.argv[2]); (root / 'README.md').write_text(flow + '\\n## Current state\\nReady\\n')\nout = m.render_work(root, root, 'light', [], packet=True)\nassert 'PROGRESS · README.md' in out and 'Ready' in out and '2020-01-02' in out\ndef unavailable(*args, **kwargs): raise FileNotFoundError()\nm.subprocess.run = unavailable\na, c = m.parsed_frontmatters([canonical, nested])\nassert a['progress_rail'] == 'readme-only' and 'current_state_updated' not in c and 'progress_rail' not in c\nassert m.parsed_frontmatters(['---\\nprogress_rail: invalid\\nprogress_rail: readme-only\\n---\\n']) == [None]\n`;
      const continued = `\nassert m.parsed_frontmatters(['---\\ncurrent_state_updated: 2020-01-02T03:04:05Z\\n  pending\\n---\\n']) == [{}]\nassert m.parsed_frontmatters(['---\\nprogress_rail: readme-only#draft\\n---\\n']) == [{}]\nassert m.parsed_frontmatters(['---\\nprogress_rail: readme-only # comment\\n---\\n']) == [{'progress_rail': 'readme-only'}]\n`;
      const result = spawnSync(python, ["-E", "-S", "-B", "-c", program + continued, installed, dir], { encoding: "utf8", cwd: dir, env });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
