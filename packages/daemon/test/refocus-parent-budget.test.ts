import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("parent trace consumes the parsed chain once and retains the rest of the work trace", () => {
  const script = resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills/refocusing/scripts/trace-to-root.py");
  const python = String.raw`
import importlib.util, json, tempfile
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('trace', sys.argv[1])
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    mission = root / 'missions' / 'child'
    mission.mkdir(parents=True)
    (mission / 'SPEC.md').write_text('---\nid: M.2\nintent: child\n---\n')
    (mission / 'mission.yaml').write_text('metadata: { "parent": M.1 }\n')
    (mission / 'NOTES.md').write_text('notes retained')
    calls = []
    def rig(*args, **kwargs):
        calls.append((args, kwargs))
        return json.dumps({'mission': {'parentChain': [{'id': 'M.1', 'path': '/parent', 'intent': 'parent goal'}], 'parentGap': None}})
    trace.rig_output = rig
    failures = []
    result = trace.render_work(mission, root, 'light', failures)
    assert len(calls) == 1 and 0 < calls[0][1]['timeout'] <= 1.8
    assert 'PARENT · M.1 · /parent' in result and 'NOTES · NOTES.md' in result
    trace.TRACE_STARTED -= 3
    result = trace.render_work(mission, root, 'light', [])
    assert len(calls) == 1 and 'PARENT TRACE GAP' in result and 'NOTES · NOTES.md' in result
`;
  const command = process.env.OPENRIG_TEST_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const result = spawnSync(command, ["-B", "-", script], { encoding: "utf8", input: python });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
