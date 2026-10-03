import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../src/domain/pod-bundle-assembler.js";

// Root bypasses POSIX write checks; Windows does not implement these mode bits.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("read-only bundle sources", () => {
  it.each([0o444, 0o555])("rewrites vendored agent YAML without modifying source permissions (%i)", mode => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "bundle-readonly-"));
    const rigRoot = path.join(root, "rig");
    const outputDir = path.join(root, "staging");
    const agentDir = path.join(rigRoot, "agents", "impl");
    const agentFile = path.join(agentDir, "agent.yaml");
    const scriptFile = path.join(agentDir, "run.sh");
    const startupFile = path.join(rigRoot, "startup.sh");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(agentFile, 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n');
    fs.writeFileSync(scriptFile, "#!/bin/sh\necho hello\n");
    fs.writeFileSync(startupFile, "#!/bin/sh\necho startup\n");
    for (const file of [agentFile, scriptFile, startupFile]) fs.chmodSync(file, mode);
    const rigSpecPath = path.join(rigRoot, "rig.yaml");
    fs.writeFileSync(rigSpecPath, `version: "0.2"
name: readonly-rig
culture_file: startup.sh
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`);
    const listFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const child = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(child).map(file => path.join(entry.name, file)) : [entry.name];
    });
    const fsOps: PodAssemblerFsOps = {
      readFile: file => fs.readFileSync(file, "utf8"),
      readFileBuffer: file => fs.readFileSync(file),
      fileMode: file => fs.statSync(file).mode & 0o777,
      realpath: file => fs.realpathSync(file),
      exists: file => fs.existsSync(file),
      mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
      writeFile: (file, content, permissions) => {
        fs.writeFileSync(file, content);
        if (permissions !== undefined) fs.chmodSync(file, permissions);
      },
      copyDir: (source, destination) => { fs.cpSync(source, destination, { recursive: true }); },
      listFiles,
    };
    try {
      const assembler = new PodBundleAssembler({ fsOps });
      assembler.assemble({ rigRoot, rigSpecPath, outputDir, bundleName: "readonly", bundleVersion: "1.0.0" });
      // Reusing staging exercises repeated writes, including already-vendored files.
      assembler.assemble({ rigRoot, rigSpecPath, outputDir, bundleName: "readonly", bundleVersion: "1.0.0" });
      for (const file of ["agent.yaml", "run.sh"]) {
        expect(fs.statSync(path.join(outputDir, "agents", "impl", file)).mode & 0o777).toBe(mode | 0o600);
        expect(fs.statSync(path.join(agentDir, file)).mode & 0o777).toBe(mode);
      }
      expect(fs.statSync(path.join(outputDir, "startup.sh")).mode & 0o777).toBe(mode | 0o600);
      expect(fs.statSync(startupFile).mode & 0o777).toBe(mode);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
