import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.skipIf(process.platform !== "win32")("compiles the owned bridge once per process and releases its exact helper on exit", () => {
  const directory = mkdtempSync(join(tmpdir(), "openrig-owned-helper-test-")); directories.push(directory);
  const file = join(directory, "synthetic.txt"); writeFileSync(file, "synthetic only");
  const source = new URL("../src/commands/project-jev.ts", import.meta.url).href;
  const script = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original=cp.execFileSync; let helper, compilations=0;
    cp.execFileSync=(file,args,options)=>{
      if(options?.env?.OPENRIG_OWNED_TEXT_HELPER){helper=options.env.OPENRIG_OWNED_TEXT_HELPER;compilations++;}
      return original(file,args,options);
    };
    syncBuiltinESMExports();
    const {readBounded}=await import(${JSON.stringify(source)});
    const first=readBounded(process.argv[1]),second=readBounded(process.argv[1]);
    console.log(JSON.stringify({first,second,helper,compilations}));
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", windowsHide: true, timeout: 20_000 });
  const result = JSON.parse(output) as { first: string; second: string; helper: string; compilations: number };
  expect(result).toMatchObject({ first: "synthetic only", second: "synthetic only", compilations: 1 });
  expect(result.helper).toMatch(/owned-text\.exe$/);
  expect(existsSync(result.helper)).toBe(false);
  expect(existsSync(dirname(result.helper))).toBe(false);
});
