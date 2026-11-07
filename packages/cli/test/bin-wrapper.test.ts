import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import fs from "node:fs";
import os from "node:os";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBinEntry, resolveNodeReexecBinary, run } from "../src/bin-wrapper.js";

describe("bin-wrapper", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it.skipIf(!module.getCompileCacheDir || !module.enableCompileCache).each([
    { args: [], interactive: false, explicitCache: false, expected: false },
    { args: ["--version"], interactive: false, explicitCache: false, expected: true },
    { args: [], interactive: false, explicitCache: true, expected: true },
    { args: [], interactive: true, explicitCache: false, expected: true },
  ])("compile cache for args=$args, interactive=$interactive, explicitCache=$explicitCache", ({ args, interactive, explicitCache, expected }) => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-cache-"));
    const dist = path.join(tempDir, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(tempDir, "package.json"), '{ "type": "module" }');
    const wrapper = path.join(dist, "bin-wrapper.js");
    const source = fs.readFileSync(new URL("../src/bin-wrapper.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    fs.writeFileSync(wrapper, outputText);
    const report = `import { getCompileCacheDir } from "node:module";
export async function runProgram() { console.log(JSON.stringify({ enabled: !!getCompileCacheDir() })); }
`;
    fs.writeFileSync(path.join(dist, "index.js"), report + "export function createProgram() { return {}; }\n");
    fs.writeFileSync(path.join(dist, "lazy-program.js"), report + "export async function createLazyProgram() { return {}; }\n");
    const env = { ...process.env, TMPDIR: tempDir };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    delete env.NODE_COMPILE_CACHE;
    if (explicitCache) env.NODE_COMPILE_CACHE = path.join(tempDir, "explicit-cache");
    // Set stream flags before the wrapper loads; front-door.test.ts covers a real PTY launch.
    const nodeArgs = interactive
      ? ["--import", "data:text/javascript,process.stdin.isTTY=true;process.stdout.isTTY=true"]
      : [];
    const result = spawnSync(process.execPath, [...nodeArgs, wrapper, ...args], { env, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ enabled: expected });
  });

  it("resolves the real dist entry from a symlinked wrapper path", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const symlinkPath = path.join(tempDir, "rig");
    fs.symlinkSync(wrapperSource, symlinkPath);

    const entry = resolveBinEntry(symlinkPath, pathToFileURL(wrapperSource).href);
    expect(entry).toBe(path.resolve(path.dirname(wrapperSource), "../dist/index.js"));
  });

  it("prefers the sibling node next to the invoked rig binary when current node comes from elsewhere", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const prefixDir = path.join(tempDir, "prefix");
    const binDir = path.join(prefixDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const rigPath = path.join(binDir, "rig");
    const siblingNodePath = path.join(binDir, "node");
    fs.symlinkSync(wrapperSource, rigPath);
    fs.writeFileSync(siblingNodePath, "");

    const reexecNode = resolveNodeReexecBinary(
      "/opt/homebrew/bin/node",
      rigPath,
      {},
      (candidate) => candidate === siblingNodePath,
      (candidate) => candidate,
    );

    expect(reexecNode).toBe(siblingNodePath);
  });

  it("a command whose module cannot be loaded fails with the CLI's error shape, as JSON under --json", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const dist = path.join(tempDir, "dist");
    fs.mkdirSync(dist);
    const wrapper = path.join(dist, "bin-wrapper.js");
    fs.writeFileSync(wrapper, "");
    // Its own module type, as the package declares it: Node before 22.7 would read the fixture as CommonJS.
    fs.writeFileSync(path.join(dist, "package.json"), '{ "type": "module" }\n');
    // An install missing one command's module: the lazy program loads, the command's import fails.
    fs.writeFileSync(path.join(dist, "lazy-program.js"),
      "export async function createLazyProgram() { return (await import('./commands/queue.js')).queueCommand(); }\nexport async function runProgram() { return 0; }\n");
    const run1 = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const codes: number[] = [];
      await run(["node", wrapper, ...args], { out: (l) => out.push(l), err: (l) => err.push(l), exit: (c) => { codes.push(c); } });
      return { out, err, codes };
    };

    const json = await run1("queue", "list", "--json");
    expect(json.codes).toEqual([1]);
    expect(json.err).toEqual([]);
    expect(json.out).toHaveLength(1);
    const parsed = JSON.parse(json.out[0]!);
    expect(parsed).toEqual({ ok: false, error: { code: "ERR_MODULE_NOT_FOUND", message: expect.stringContaining("commands/queue.js") } });

    const human = await run1("queue", "list");
    expect(human.codes).toEqual([1]);
    expect(human.out).toEqual([]);
    expect(human.err).toHaveLength(2);
    expect(human.err[0]).toBe(`error: ${parsed.error.message}`);
    expect(human.err[1]).toContain("commands/queue.js");
    expect(human.err[1]).toMatch(/\n\s+at /);
  });

  it("does not re-exec when already running under the sibling node", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const prefixDir = path.join(tempDir, "prefix");
    const binDir = path.join(prefixDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const rigPath = path.join(binDir, "rig");
    const siblingNodePath = path.join(binDir, "node");
    fs.symlinkSync(wrapperSource, rigPath);
    fs.writeFileSync(siblingNodePath, "");

    const reexecNode = resolveNodeReexecBinary(
      siblingNodePath,
      rigPath,
      {},
      (candidate) => candidate === siblingNodePath,
      (candidate) => candidate,
    );

    expect(reexecNode).toBeNull();
  });
});
