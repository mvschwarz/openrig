import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { resolveCodexCommand } from "../src/domain/windows-provider-command.js";
import { codexDaemonSupportProbe } from "../src/domain/codex-daemon-support.js";
import { codexUsageReader } from "../src/domain/provider/codex-usage-reader.js";

describe.skipIf(process.platform !== "win32")("native npm Codex invocation", () => {
  it("runs the declared entry with literal arguments and probes help without cmd.exe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-codex-command-"));
    const pkg = path.join(root, "node_modules", "@openai", "codex");
    try {
      await mkdir(path.join(pkg, "bin"), { recursive: true });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
      await writeFile(path.join(pkg, "bin", "codex.js"), "if(process.argv[2]==='--help')console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else console.log(JSON.stringify(process.argv.slice(2)))");
      await writeFile(path.join(root, "codex.cmd"), '@echo off\r\n"node" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
      const searchPath = root + path.delimiter + path.dirname(process.execPath);
      const command = resolveCodexCommand({ PATH: searchPath }, root);
      const args = ['space value', '"quoted"', '& echo unsafe', '%PATH%', '日本語', 'line\nbreak'];
      const result = await promisify(execFile)(command.command, [...command.prefix, ...args], { encoding: "utf8" });
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(await codexDaemonSupportProbe(searchPath)(root)).toEqual({ kind: "supported" });
      await writeFile(path.join(pkg, "bin", "codex.js"), `
        let buf=''; process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { buf+=chunk; let i;
          while((i=buf.indexOf('\\n'))>=0){const msg=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
            if(msg.id)process.stdout.write(JSON.stringify({id:msg.id,result:msg.id===2?{account:null,requiresOpenaiAuth:true}:msg.id===3?{rateLimits:null}:{}})+'\\n');
          }
        }); process.stdin.on('end',()=>process.exit(0));
      `);
      const usage = await codexUsageReader({ launchPath: searchPath, home: root, codexHome: root, deadlineMs: 2000, graceMs: 100 })();
      expect(usage.ok, JSON.stringify(usage)).toBe(true);
      const missing = await codexUsageReader({ launchPath: path.join(root, "absent"), deadlineMs: 100 })();
      expect(missing).toMatchObject({ ok: false, reason: "binary_not_found" });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "../../../outside.js" } }));
      expect(() => resolveCodexCommand({ PATH: searchPath }, root)).toThrow("escapes");
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
