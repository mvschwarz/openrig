import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudePermissionModeCache, loadClaudePermissionModes, PermissionDriftObserver } from "../src/domain/permission-drift-observer.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";

afterEach(() => vi.unstubAllEnvs());
describe.runIf(process.platform === "win32")("native permission diagnostics", () => {
  it("finds installed command extensions on a quoted Windows PATH without executing them", () => {
    const root = mkdtempSync(join(tmpdir(), "permission-path-"));
    const db = createFullTestDb();
    try {
      vi.stubEnv("PATH", `"${root}"`);
      vi.stubEnv("PATHEXT", ".EXE;.CMD");
      const rigs = new RigRepository(db), rig = rigs.createRig("native-command-fixture");
      const observer = new PermissionDriftObserver({ db, permissionModes: new ClaudePermissionModeCache(async () => null) });
      for (const [runtime, command] of [["claude-code", "claude"], ["codex", "codex"], ["pi", "pi"], ["omp", "omp"]]) {
        const node = rigs.addNode(rig.id, command!, { runtime: runtime!, cwd: root });
        expect(observer.diagnose(node.id)?.commandPath.state).toBe("missing");
        mkdirSync(join(root, `${command}.exe`));
        expect(observer.diagnose(node.id)?.commandPath.state).toBe("missing");
        writeFileSync(join(root, `${command}.cmd`), "synthetic, never executed");
        expect(observer.diagnose(node.id)?.commandPath.state).toBe("available");
        vi.stubEnv("PATHEXT", "");
        expect(observer.diagnose(node.id)?.commandPath.state).toBe("missing");
        vi.stubEnv("PATHEXT", ".EXE;.CMD");
      }
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("loads permission choices from a recognized npm Claude through native Node", async () => {
    const root = mkdtempSync(join(tmpdir(), "permission-help-用户 &-"));
    const pkg = join(root, "node_modules/@anthropic-ai/claude-code");
    const args = join(root, "argv.json");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.cjs" } }));
    writeFileSync(join(root, "claude.cmd"), String.raw`@"%dp0%\node_modules\@anthropic-ai\claude-code\cli.cjs"`);
    writeFileSync(join(pkg, "cli.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2))); console.log('--permission-mode <mode> (choices: "default", "acceptEdits")');`);
    const env = { ...process.env, PATH: root + delimiter + dirname(process.execPath) };
    try {
      expect(await loadClaudePermissionModes(env)).toEqual(["default", "acceptEdits"]);
      expect(JSON.parse(readFileSync(args, "utf8"))).toEqual(["--help"]);
      writeFileSync(join(root, "claude.cmd"), "@echo unrecognized shim");
      expect(await loadClaudePermissionModes(env)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
