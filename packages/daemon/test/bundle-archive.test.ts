import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as tar from "tar";
import { pack, unpack, verifyArchiveDigest, unsafeArchiveEntryReason, collectUnsafeArchiveEntries } from "../src/domain/bundle-archive.js";
// TODO: AS-T12 — migrate to pod-aware bundle types
import { serializeLegacyBundleManifest as serializeBundleManifest, type LegacyBundleManifest as BundleManifest } from "../src/domain/bundle-types.js";
import { computeIntegrity, writeIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";
import { existingArchive, MARKER } from "./helpers/bundle-login-fixture.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function realIntegrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const results: string[] = [];
      function walk(d: string, prefix: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          else results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
      walk(dir, "");
      return results;
    },
  };
}

describe("Bundle archive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-archive-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createStaging(): string {
    const staging = path.join(tmpDir, "staging");
    fs.mkdirSync(path.join(staging, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(staging, "rig.yaml"), "schema_version: 1\nname: test\nversion: '1.0'\nnodes:\n  - id: dev\n    runtime: claude-code\nedges: []");
    fs.writeFileSync(path.join(staging, "packages/pkg/SKILL.md"), "# Skill");

    const manifest: BundleManifest = {
      schemaVersion: 1, name: "test-bundle", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializeBundleManifest(manifest));

    // Add integrity
    const integrity = computeIntegrity(staging, realIntegrityFsOps());
    writeIntegrity(staging, integrity, realIntegrityFsOps());

    return staging;
  }

  // Isolate the process-wide umask from Vitest and restore it even on rejection.
  function runUnpackUnderUmask(archive: string, destination: string, umask: number, failChmodFor = "", failMode = 0o700, aliases: string[] = []) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import path from "node:path";
      import * as tar from "tar";
      import { unpack } from ${JSON.stringify(new URL("../src/domain/bundle-archive.ts", import.meta.url).href)};
      // A caller-owned destination must stay traversable when testing a mask
      // that strips owner execute. Prepare only directories before that mask;
      // all file creation, modes, bytes and verification still use real unpack.
      if (Number(process.argv[1]) & 0o100) {
        fs.mkdirSync(process.argv[3], { recursive: true, mode: 0o700 });
        await tar.list({ file: process.argv[2], onReadEntry: entry => {
          const file = path.join(process.argv[3], entry.path);
          fs.mkdirSync(entry.type === "Directory" ? file : path.dirname(file), { recursive: true, mode: 0o700 });
        } });
      }
      const previous = process.umask(Number(process.argv[1]));
      let injected = false;
      const chmod = fs.chmodSync;
      const lstat = fs.lstatSync;
      const aliases = JSON.parse(process.argv[6]);
      // Simulate only final filesystem identity and chmod alias resolution.
      // Tar extraction and content verification remain real on this filesystem.
      fs.lstatSync = (file, options) => lstat(aliases.includes(file) ? aliases[0] : file, options);
      const repairs = [];
      fs.chmodSync = (file, mode) => {
        repairs.push({ file, mode });
        if (file === process.argv[4] && mode === Number(process.argv[5])) {
          injected = true;
          throw Object.assign(new Error("synthetic mode repair failure"), { code: "EPERM" });
        }
        return chmod(aliases.includes(file) ? aliases[0] : file, mode);
      };
      try { console.log(JSON.stringify({ result: await unpack(process.argv[2], process.argv[3]) ?? null, injected, repairs })); }
      catch (error) {
        console.log(JSON.stringify({ error: { message: error.message, code: error.code ?? null }, injected, repairs }));
        process.exitCode = 1;
      }
      finally { process.umask(previous); }
    `, String(umask), archive, destination, failChmodFor, String(failMode), JSON.stringify(aliases)], { encoding: "utf8", timeout: 10_000 });
    expect(child.error, child.stderr || String(child.error ?? "Child failed to complete")).toBeUndefined();
    return { status: child.status, stderr: child.stderr, data: JSON.parse(child.stdout) as {
      result?: { warnings: string[] } | null; error?: { message: string; code: string | null }; injected: boolean; repairs: Array<{ file: string; mode: number }>;
    } };
  }

  function unpackUnderUmask(archive: string, destination: string, umask: number) {
    const child = runUnpackUnderUmask(archive, destination, umask);
    expect(child.status, child.stderr || JSON.stringify(child.data.error)).toBe(0);
    return child.data.result!;
  }

  function writeArchiveDigest(archive: string) {
    fs.writeFileSync(archive + ".sha256", createHash("sha256").update(fs.readFileSync(archive)).digest("hex"));
  }

  it.skipIf(process.platform === "win32").each([
    { label: "0077", umask: 0o077, expected: [0o700, 0o600, 0o600, 0o600] },
    { label: "0022", umask: 0o022, expected: [0o755, 0o644, 0o640, 0o600] },
    { label: "0177 strips owner execute", umask: 0o177, expected: [0o700, 0o600, 0o600, 0o600] },
  ])("restores owner modes and preserves masked group/other access under umask $label", async ({ umask, expected }) => {
    const staging = createStaging();
    const files = [["tool.sh", 0o755], ["shared.txt", 0o644], ["group.txt", 0o640], ["private.txt", 0o600]] as const;
    for (const [name, mode] of files) {
      const file = path.join(staging, name);
      fs.writeFileSync(file, name);
      fs.chmodSync(file, mode); // Set the producer's declared mode, never repair extracted output in the fixture.
    }
    writeIntegrity(staging, computeIntegrity(staging, realIntegrityFsOps()), realIntegrityFsOps());
    const archive = path.join(tmpDir, "modes.rigbundle");
    await pack(staging, archive);
    const declared = new Map<string, number>();
    await tar.list({ file: archive, onReadEntry: entry => { declared.set(entry.path, entry.mode ?? 0); } });
    for (const [name, mode] of files) expect(declared.get(name)! & 0o777).toBe(mode);
    const output = path.join(tmpDir, "modes-extracted");
    expect(unpackUnderUmask(archive, output, umask)).toBeNull();
    for (const [index, [name]] of files.entries()) {
      expect(fs.readFileSync(path.join(output, name), "utf8")).toBe(name);
      expect(fs.statSync(path.join(output, name)).mode & 0o777, name).toBe(expected[index]);
    }
  });

  it.skipIf(process.platform === "win32")("keeps accepted file-to-directory transitions while repairing child file modes", async () => {
    const staging = createStaging();
    fs.mkdirSync(path.join(staging, "shared"));
    fs.chmodSync(path.join(staging, "shared"), 0o700);
    fs.writeFileSync(path.join(staging, "shared/tool.sh"), "#!/bin/sh\necho fixture\n");
    fs.chmodSync(path.join(staging, "shared/tool.sh"), 0o755);
    writeIntegrity(staging, computeIntegrity(staging, realIntegrityFsOps()), realIntegrityFsOps());
    const earlier = path.join(tmpDir, "earlier"); fs.mkdirSync(earlier);
    fs.writeFileSync(path.join(earlier, "shared"), "obsolete regular file");
    fs.chmodSync(path.join(earlier, "shared"), 0o644);
    await tar.create({ file: path.join(tmpDir, "earlier.tar"), cwd: earlier }, ["./shared"]);
    await tar.create({ file: path.join(tmpDir, "current.tar"), cwd: staging }, ["bundle.yaml", "rig.yaml", "packages", "shared"]);
    const archive = path.join(tmpDir, "transition.rigbundle");
    await tar.create({ file: archive, cwd: tmpDir, gzip: true }, ["@earlier.tar", "@current.tar"]);
    writeArchiveDigest(archive);
    const directories: Array<{ path: string; type: string; mode: number }> = [];
    await tar.list({ file: archive, onReadEntry: entry => {
      if (entry.path === "shared/") directories.push({ path: entry.path, type: entry.type, mode: entry.mode! & 0o7777 });
    } });
    expect(directories).toEqual([{ path: "shared/", type: "Directory", mode: 0o700 }]);
    const output = path.join(tmpDir, "transition-extracted");
    expect(unpackUnderUmask(archive, output, 0o077)).toBeNull();
    expect(fs.statSync(path.join(output, "shared")).isDirectory()).toBe(true);
    // Directory handling remains tar's existing policy, not the earlier file's mode.
    expect(fs.statSync(path.join(output, "shared")).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(output, "shared/tool.sh"), "utf8")).toBe("#!/bin/sh\necho fixture\n");
    expect(fs.statSync(path.join(output, "shared/tool.sh")).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32").each([
    { label: "Codex 0644", login: ".codex/auth.json", archived: 0o644, expected: 0o600 },
    { label: "Claude 0400", login: ".claude/.credentials.json", archived: 0o400, expected: 0o400 },
    { label: "Pi 0600", login: ".pi/agent/auth.json", archived: 0o600, expected: 0o600 },
    { label: "Codex 0755", login: ".codex/auth.json", archived: 0o755, expected: 0o600 },
  ])("caps known login-file modes before returning a successful credential warning: $label", async ({ login, archived, expected }) => {
    // Synthetic login fixture only: no real account files or credentials.
    const paths = [`agents/worker/${login}`];
    const f = await existingArchive(tmpDir, paths, paths);
    fs.chmodSync(path.join(f.staging, "rig.yaml"), 0o644);
    fs.chmodSync(path.join(f.staging, paths[0]!), archived);
    // Nonportable headers retain a stricter owner-only mode too.
    await tar.create({ file: f.archive, cwd: f.staging, gzip: true, portable: false }, realIntegrityFsOps().walkFiles(f.staging));
    writeArchiveDigest(f.archive);
    let loginHeaderMode: number | undefined;
    await tar.list({ file: f.archive, onReadEntry: entry => { if (entry.path === paths[0]) loginHeaderMode = entry.mode; } });
    expect(loginHeaderMode! & 0o7777).toBe(archived);
    const output = path.join(tmpDir, "warning-extracted");
    const result = unpackUnderUmask(f.archive, output, 0o077);
    expect(result?.warnings).toHaveLength(1);
    expect(result?.warnings[0]).toContain("Credential-bearing bundle includes");
    expect(result?.warnings[0]).not.toContain(MARKER);
    expect(fs.statSync(path.join(output, "rig.yaml")).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(path.join(output, paths[0]!)).mode & 0o7777).toBe(expected);
    expect(fs.readFileSync(path.join(output, paths[0]!), "utf8")).toBe(MARKER);
  });

  it.skipIf(process.platform === "win32").each([
    { label: "0666 to 0644", archived: 0o666, expected: 0o644 },
    { label: "0777 to 0755", archived: 0o777, expected: 0o755 },
  ])("normalizes external group/other-write headers: $label", async ({ archived, expected }) => {
    const staging = createStaging();
    fs.writeFileSync(path.join(staging, "external.txt"), "external archive fixture");
    fs.chmodSync(path.join(staging, "external.txt"), archived);
    writeIntegrity(staging, computeIntegrity(staging, realIntegrityFsOps()), realIntegrityFsOps());
    const archive = path.join(tmpDir, "external.rigbundle");
    await tar.create({ file: archive, cwd: staging, gzip: true, portable: false }, realIntegrityFsOps().walkFiles(staging));
    writeArchiveDigest(archive);
    const headers: Array<{ type: string; mode: number }> = [];
    await tar.list({ file: archive, onReadEntry: entry => {
      if (entry.path === "external.txt") headers.push({ type: entry.type, mode: entry.mode! & 0o7777 });
    } });
    expect(headers).toEqual([{ type: "File", mode: archived }]);
    const output = path.join(tmpDir, "external-extracted");
    expect(unpackUnderUmask(archive, output, 0o022)).toBeNull();
    expect(fs.readFileSync(path.join(output, "external.txt"), "utf8")).toBe("external archive fixture");
    expect(fs.statSync(path.join(output, "external.txt")).mode & 0o7777).toBe(expected);
  });

  it.skipIf(process.platform === "win32").each([
    { label: "0600 to 0755", first: 0o600, last: 0o755 },
    { label: "0755 to 0600", first: 0o755, last: 0o600 },
  ])("uses the last duplicate regular-file content and mode: $label", async ({ first, last }) => {
    const staging = createStaging();
    fs.writeFileSync(path.join(staging, "repeat.txt"), "last verified content");
    fs.chmodSync(path.join(staging, "repeat.txt"), last);
    writeIntegrity(staging, computeIntegrity(staging, realIntegrityFsOps()), realIntegrityFsOps());
    const earlier = path.join(tmpDir, "earlier"); fs.mkdirSync(earlier);
    fs.writeFileSync(path.join(earlier, "repeat.txt"), "earlier content");
    fs.chmodSync(path.join(earlier, "repeat.txt"), first);
    await tar.create({ file: path.join(tmpDir, "earlier.tar"), cwd: earlier }, ["repeat.txt"]);
    await tar.create({ file: path.join(tmpDir, "last.tar"), cwd: staging }, realIntegrityFsOps().walkFiles(staging));
    const archive = path.join(tmpDir, "duplicates.rigbundle");
    await tar.create({ file: archive, cwd: tmpDir, gzip: true }, ["@earlier.tar", "@last.tar"]);
    writeArchiveDigest(archive);
    const headers: Array<{ type: string; mode: number }> = [];
    await tar.list({ file: archive, onReadEntry: entry => {
      if (entry.path === "repeat.txt") headers.push({ type: entry.type, mode: entry.mode! & 0o7777 });
    } });
    expect(headers).toEqual([{ type: "File", mode: first }, { type: "File", mode: last }]);
    const output = path.join(tmpDir, "duplicates-extracted");
    expect(unpackUnderUmask(archive, output, 0o077)).toBeNull();
    expect(fs.readFileSync(path.join(output, "repeat.txt"), "utf8")).toBe("last verified content");
    expect(fs.statSync(path.join(output, "repeat.txt")).mode & 0o7777).toBe(last === 0o755 ? 0o700 : 0o600);
  });

  it.skipIf(process.platform === "win32")("removes special bits from a synthetic verified regular-file header", async () => {
    const staging = createStaging();
    const content = Buffer.from("synthetic data, never executed");
    fs.writeFileSync(path.join(staging, "special.txt"), content);
    writeIntegrity(staging, computeIntegrity(staging, realIntegrityFsOps()), realIntegrityFsOps());
    const header = new tar.Header({ path: "special.txt", type: "File", mode: 0o4755, size: content.length });
    const block = Buffer.alloc(512); header.encode(block);
    fs.writeFileSync(path.join(tmpDir, "special.tar"), Buffer.concat([block, content, Buffer.alloc(512 - content.length + 1024)]));
    await tar.create({ file: path.join(tmpDir, "rest.tar"), cwd: staging }, realIntegrityFsOps().walkFiles(staging).filter(file => file !== "special.txt"));
    const archive = path.join(tmpDir, "special.rigbundle");
    await tar.create({ file: archive, cwd: tmpDir, gzip: true }, ["@special.tar", "@rest.tar"]);
    writeArchiveDigest(archive);
    let specialMode: number | undefined;
    await tar.list({ file: archive, onReadEntry: entry => { if (entry.path === "special.txt") specialMode = entry.mode; } });
    expect(specialMode! & 0o7777).toBe(0o4755);
    const output = path.join(tmpDir, "special-extracted");
    expect(unpackUnderUmask(archive, output, 0o022)).toBeNull();
    expect(fs.readFileSync(path.join(output, "special.txt"))).toEqual(content);
    expect(fs.statSync(path.join(output, "special.txt")).mode & 0o7777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32")("does not repair modes when content verification fails despite a valid archive digest", async () => {
    const staging = createStaging();
    fs.writeFileSync(path.join(staging, "rig.yaml"), "changed after content hashing");
    fs.chmodSync(path.join(staging, "rig.yaml"), 0o644);
    const archive = path.join(tmpDir, "content-mismatch.rigbundle");
    await pack(staging, archive);
    expect(verifyArchiveDigest(archive).valid).toBe(true);
    const output = path.join(tmpDir, "mismatch-extracted");
    const child = runUnpackUnderUmask(archive, output, 0o077);
    expect(child.status).toBe(1);
    expect(child.data.error?.message).toContain("Content integrity verification failed: tampered: rig.yaml");
    expect(child.data.injected).toBe(false);
    expect(fs.readFileSync(path.join(output, "rig.yaml"), "utf8")).toBe("changed after content hashing");
    expect(fs.statSync(path.join(output, "rig.yaml")).mode & 0o7777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32").each([
    { label: "ordinary", failed: "a-tool.sh", later: "z-tool.sh", mask: 0o177, target: 0o700, observed: 0o600 },
    { label: "login", failed: "agents/worker/.codex/auth.json", later: "agents/worker/.pi/agent/auth.json", mask: 0o022, target: 0o600, observed: 0o755 },
  ])("warns and repairs later files after a $label chmod failure", async ({ label, failed, later, mask, target, observed }) => {
    const login = "agents/worker/.codex/auth.json";
    const paths = [...new Set([failed, later, login])];
    const f = await existingArchive(tmpDir, paths, paths.filter(file => file.includes("/auth.json")));
    for (const file of paths) fs.chmodSync(path.join(f.staging, file), 0o755);
    await pack(f.staging, f.archive);
    const output = path.join(tmpDir, "chmod-failure-extracted");
    const child = runUnpackUnderUmask(f.archive, output, mask, path.join(output, failed), target);
    expect(child.status, JSON.stringify(child.data)).toBe(0);
    expect(child.data.injected).toBe(true);
    expect(child.data.error).toBeUndefined();
    const warnings = child.data.result!.warnings;
    expect(warnings.some(w => w.includes("Credential-bearing bundle includes"))).toBe(true);
    const repairs = warnings.filter(w => w.startsWith("Bundle mode repair warning:"));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain(`chmod failed for '${failed}'`);
    expect(repairs[0]).toContain(`observed mode ${observed.toString(8).padStart(4, "0")}`);
    expect(repairs[0]).toContain("private folder on a filesystem that supports permissions");
    expect(repairs[0]!.includes("owner-only login cap could not be applied")).toBe(label === "login");
    expect(warnings.join("\n")).not.toContain(MARKER);
    expect(fs.readFileSync(path.join(output, failed), "utf8")).toBe(MARKER);
    expect(fs.statSync(path.join(output, failed)).mode & 0o7777).toBe(observed);
    expect(fs.statSync(path.join(output, later)).mode & 0o7777).toBe(target);
    expect(child.data.repairs.findIndex(r => r.file === path.join(output, later)))
      .toBeGreaterThan(child.data.repairs.findIndex(r => r.file === path.join(output, failed)));
  });

  it.skipIf(process.platform === "win32").each([
    { label: "interleaved ordinary duplicates", lower: "alias.txt", upper: "ALIAS.TXT", modes: [0o600, 0o400, 0o755], expected: 0o700 },
    { label: "login then executable alias", lower: "agents/worker/.codex/auth.json", upper: "agents/worker/.codex/AUTH.JSON", modes: [0o400, 0o755], expected: 0o600 },
    { label: "interleaved login duplicates", lower: "agents/worker/.codex/auth.json", upper: "agents/worker/.codex/AUTH.JSON", modes: [0o600, 0o755, 0o400], expected: 0o400 },
  ])("makes one final mode decision for simulated physical aliases: $label", async ({ lower, upper, modes, expected }) => {
    const f = await existingArchive(tmpDir, [lower, upper], lower.includes(".codex/") ? [lower] : undefined);
    const parts: string[] = [];
    for (const [i, mode] of modes.entries()) {
      const name = i % 2 === 0 ? lower : upper;
      fs.chmodSync(path.join(f.staging, name), mode);
      const part = `part-${i}.tar`;
      await tar.create({ file: path.join(tmpDir, part), cwd: f.staging }, [name]);
      parts.push("@" + part);
    }
    await tar.create({ file: path.join(tmpDir, "rest.tar"), cwd: f.staging }, realIntegrityFsOps().walkFiles(f.staging).filter(file => file !== lower && file !== upper));
    await tar.create({ file: f.archive, cwd: tmpDir, gzip: true }, [...parts, "@rest.tar"]);
    writeArchiveDigest(f.archive);
    const output = path.join(tmpDir, "aliases-extracted");
    const aliases = [lower, upper].map(file => path.join(output, file));
    const child = runUnpackUnderUmask(f.archive, output, 0o177, "", 0o700, aliases);
    expect(child.status, JSON.stringify(child.data)).toBe(0);
    expect(fs.readFileSync(aliases[0]!, "utf8")).toBe(MARKER);
    expect(fs.statSync(aliases[0]!).mode & 0o7777).toBe(expected);
    expect(child.data.repairs.filter(r => aliases.includes(r.file))).toHaveLength(1);
    if (lower.includes(".codex/")) expect(child.data.result?.warnings.join("\n")).toContain("Credential-bearing bundle includes");
  });

  it.skipIf(process.platform === "win32")("keeps distinct case-sensitive files independent", async ({ skip }) => {
    const f = await existingArchive(tmpDir, ["alias.txt", "ALIAS.TXT"]);
    const lower = path.join(f.staging, "alias.txt"), upper = path.join(f.staging, "ALIAS.TXT");
    if (fs.statSync(lower).ino === fs.statSync(upper).ino) { skip(); return; } // This boundary needs a case-sensitive volume.
    fs.chmodSync(lower, 0o755); fs.chmodSync(upper, 0o400);
    await tar.create({ file: f.archive, cwd: f.staging, gzip: true, portable: false }, realIntegrityFsOps().walkFiles(f.staging));
    writeArchiveDigest(f.archive);
    const output = path.join(tmpDir, "distinct-extracted");
    expect(unpackUnderUmask(f.archive, output, 0o177)).toBeNull();
    expect(fs.readFileSync(path.join(output, "alias.txt"), "utf8")).toBe(MARKER);
    expect(fs.readFileSync(path.join(output, "ALIAS.TXT"), "utf8")).toBe(MARKER);
    expect(fs.statSync(path.join(output, "alias.txt")).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(path.join(output, "ALIAS.TXT")).mode & 0o7777).toBe(0o400);
  });

  it("pack creates parent directory if it does not exist", async () => {
    const staging = createStaging();
    const nestedOut = path.join(tmpDir, "missing", "sub", "test.rigbundle");

    const hash = await pack(staging, nestedOut);

    expect(fs.existsSync(nestedOut)).toBe(true);
    expect(fs.existsSync(`${nestedOut}.sha256`)).toBe(true);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  // T1: Pack creates valid tar.gz
  it("pack creates valid tar.gz file", async () => {
    const staging = createStaging();
    const outputPath = path.join(tmpDir, "test.rigbundle");

    const hash = await pack(staging, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("preserves executable file modes through pack and unpack", async () => {
    const staging = createStaging();
    const scriptPath = path.join(staging, "packages/pkg/bin/hello.sh");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    fs.chmodSync(scriptPath, 0o755);
    writeIntegrity(staging, computeIntegrity(staging, realIntegrityFsOps()), realIntegrityFsOps());

    const archivePath = path.join(tmpDir, "executable.rigbundle");
    await pack(staging, archivePath);
    let archivedMode: number | undefined;
    await tar.list({ file: archivePath, onReadEntry: (entry) => {
      if (entry.path === "packages/pkg/bin/hello.sh") archivedMode = entry.mode;
    } });
    expect((archivedMode ?? 0) & 0o111).toBeGreaterThan(0);

    const extractDir = path.join(tmpDir, "executable-extracted");
    await unpack(archivePath, extractDir);
    expect(fs.statSync(path.join(extractDir, "packages/pkg/bin/hello.sh")).mode & 0o111).toBeGreaterThan(0);
  });

  // T2: Unpack extracts to correct structure
  it("unpack extracts to correct directory structure", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    expect(fs.existsSync(path.join(extractDir, "bundle.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "rig.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "packages/pkg/SKILL.md"))).toBe(true);
  });

  // T3: Round-trip
  it("round-trip: pack -> unpack -> files match", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    const origSkill = fs.readFileSync(path.join(staging, "packages/pkg/SKILL.md"), "utf-8");
    const extractedSkill = fs.readFileSync(path.join(extractDir, "packages/pkg/SKILL.md"), "utf-8");
    expect(extractedSkill).toBe(origSkill);
  });

  // T4: Path traversal rejected — create archive with ../ via low-level tar pack
  it("path traversal in archive entry rejected during extraction", async () => {
    // Create a staging dir with a file, then manually pack with a ../ prefix
    const malDir = path.join(tmpDir, "mal-staging");
    fs.mkdirSync(malDir, { recursive: true });
    fs.writeFileSync(path.join(malDir, "evil.txt"), "escape!");

    const malArchive = path.join(tmpDir, "mal.rigbundle");
    // Use tar.create with prefix to inject ../ into entry names
    await tar.create(
      { gzip: true, file: malArchive, cwd: malDir, prefix: "../escape" },
      ["evil.txt"],
    );

    // Write a valid .sha256 digest so we get past the digest check
    const archiveHash = createHash("sha256").update(fs.readFileSync(malArchive)).digest("hex");
    fs.writeFileSync(`${malArchive}.sha256`, archiveHash);

    await expect(unpack(malArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|path traversal/i);
  });

  it("backslash path traversal in archive entry rejected during extraction", async () => {
    const malDir = path.join(tmpDir, "mal-win-staging");
    fs.mkdirSync(malDir, { recursive: true });
    fs.writeFileSync(path.join(malDir, "evil.txt"), "escape!");

    const malArchive = path.join(tmpDir, "mal-win.rigbundle");
    await tar.create(
      { gzip: true, file: malArchive, cwd: malDir, prefix: "..\\escape" },
      ["evil.txt"],
    );

    const archiveHash = createHash("sha256").update(fs.readFileSync(malArchive)).digest("hex");
    fs.writeFileSync(`${malArchive}.sha256`, archiveHash);

    await expect(unpack(malArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|path traversal/i);
  });

  it("windows drive letter in archive entry rejected during extraction", async () => {
    const malDir = path.join(tmpDir, "mal-drive-staging");
    fs.mkdirSync(malDir, { recursive: true });
    fs.writeFileSync(path.join(malDir, "evil.txt"), "escape!");

    const malArchive = path.join(tmpDir, "mal-drive.rigbundle");
    await tar.create(
      { gzip: true, file: malArchive, cwd: malDir, prefix: "C:\\windows\\temp" },
      ["evil.txt"],
    );

    const archiveHash = createHash("sha256").update(fs.readFileSync(malArchive)).digest("hex");
    fs.writeFileSync(`${malArchive}.sha256`, archiveHash);

    await expect(unpack(malArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|absolute path/i);
  });

  // T4b: Symlink entry rejection
  it("symlink in archive rejected during extraction", async () => {
    // Create an archive that includes a symlink entry
    const symlinkDir = path.join(tmpDir, "sym-staging");
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.writeFileSync(path.join(symlinkDir, "real.txt"), "real content");
    fs.symlinkSync("/etc/passwd", path.join(symlinkDir, "escape-link"));

    const symArchive = path.join(tmpDir, "sym.rigbundle");
    await tar.create(
      { gzip: true, file: symArchive, cwd: symlinkDir, follow: false },
      ["real.txt", "escape-link"],
    );

    const archiveHash = createHash("sha256").update(fs.readFileSync(symArchive)).digest("hex");
    fs.writeFileSync(`${symArchive}.sha256`, archiveHash);

    await expect(unpack(symArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|SymbolicLink/i);
  });

  // T5: Corrupted archive -> error
  it("corrupted archive throws on unpack", async () => {
    const archivePath = path.join(tmpDir, "corrupt.rigbundle");
    fs.writeFileSync(archivePath, "not a real tar.gz");
    fs.writeFileSync(`${archivePath}.sha256`, sha256("not a real tar.gz"));

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow();
  });

  // T6: Content integrity verified after unpack
  it("content integrity verified after extraction", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Unpack should succeed (integrity passes)
    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);
    // No error = integrity passed
  });

  // T7: Tampered file detected post-unpack
  it("tampered file in archive detected after extraction", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Extract first
    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    // Tamper a file
    fs.writeFileSync(path.join(extractDir, "rig.yaml"), "tampered!");

    // Re-verification would fail (but unpack already verified — this tests the verify function)
    const { verifyIntegrity: vi2 } = await import("../src/domain/bundle-integrity.js");
    // TODO: AS-T12 — migrate to pod-aware bundle types
    const { parseLegacyBundleManifest: parseBundleManifest, normalizeLegacyBundleManifest: normalizeBundleManifest } = await import("../src/domain/bundle-types.js");
    const manifestYaml = fs.readFileSync(path.join(extractDir, "bundle.yaml"), "utf-8");
    const manifest = normalizeBundleManifest(parseBundleManifest(manifestYaml));
    const result = vi2(extractDir, manifest, realIntegrityFsOps());
    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("rig.yaml");
  });

  // T8: .rigbundle extension enforced
  it(".rigbundle extension enforced on output path", async () => {
    const staging = createStaging();
    await expect(pack(staging, path.join(tmpDir, "test.tar.gz")))
      .rejects.toThrow(/\.rigbundle/);
  });

  // T9: .sha256 sibling written during pack
  it(".sha256 sibling file written during pack", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    const hash = await pack(staging, archivePath);

    const digestPath = `${archivePath}.sha256`;
    expect(fs.existsSync(digestPath)).toBe(true);
    expect(fs.readFileSync(digestPath, "utf-8").trim()).toBe(hash);
  });

  // T10: Missing .sha256 -> unpack throws
  it("missing .sha256 throws on unpack", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Remove the digest file
    fs.unlinkSync(`${archivePath}.sha256`);

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/digest file required/);
  });

  // T11: Digest mismatch -> unpack throws
  it("archive digest mismatch throws on unpack", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Tamper the digest
    fs.writeFileSync(`${archivePath}.sha256`, "0000000000000000000000000000000000000000000000000000000000000000");

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/integrity check failed/);
  });

  // T12b: Missing integrity section in bundle.yaml -> unpack rejects
  it("unpack rejects archive whose bundle.yaml lacks integrity section", async () => {
    // Create staging without integrity
    const staging = path.join(tmpDir, "no-integ-staging");
    fs.mkdirSync(path.join(staging, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(staging, "rig.yaml"), "schema_version: 1\nname: test\nversion: '1.0'\nnodes:\n  - id: dev\n    runtime: claude-code\nedges: []");
    fs.writeFileSync(path.join(staging, "packages/pkg/SKILL.md"), "# Skill");

    const manifest: BundleManifest = {
      schemaVersion: 1, name: "no-integ", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "" }],
      // No integrity section
    };
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializeBundleManifest(manifest));

    const archivePath = path.join(tmpDir, "no-integ.rigbundle");
    await pack(staging, archivePath);

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/missing integrity section/);
  });

  // T12: Deterministic output
  it("pack same content twice produces identical archives", async () => {
    const staging = createStaging();
    const out1 = path.join(tmpDir, "a.rigbundle");
    const out2 = path.join(tmpDir, "b.rigbundle");

    const hash1 = await pack(staging, out1);
    const hash2 = await pack(staging, out2);

    expect(hash1).toBe(hash2);
    expect(fs.readFileSync(out1).equals(fs.readFileSync(out2))).toBe(true);
  });

  // S1: the shared unsafe-entry verdict used by both unpack() and /inspect.
  describe("unsafeArchiveEntryReason (shared safety verdict)", () => {
    it("rejects a POSIX absolute path", () => {
      expect(unsafeArchiveEntryReason("/etc/passwd")).toMatch(/absolute path/);
    });
    it("rejects a Windows drive-letter path", () => {
      expect(unsafeArchiveEntryReason("C:\\windows\\temp")).toMatch(/absolute path/);
    });
    it("rejects forward-slash traversal", () => {
      expect(unsafeArchiveEntryReason("../../escape")).toMatch(/path traversal/);
    });
    it("rejects backslash traversal", () => {
      expect(unsafeArchiveEntryReason("..\\escape")).toMatch(/path traversal/);
    });
    it("rejects symlink and hardlink entries", () => {
      expect(unsafeArchiveEntryReason("link", "SymbolicLink")).toMatch(/SymbolicLink/);
      expect(unsafeArchiveEntryReason("link", "Link")).toMatch(/Link/);
    });
    it("accepts an ordinary in-tree path", () => {
      expect(unsafeArchiveEntryReason("packages/pkg/SKILL.md")).toBeNull();
      // A filename that merely contains dots is not a traversal segment.
      expect(unsafeArchiveEntryReason("packages/pkg/foo..bar.md")).toBeNull();
    });
  });

  it("collectUnsafeArchiveEntries flags a backslash-traversal archive", async () => {
    const malDir = path.join(tmpDir, "mal-scan-staging");
    fs.mkdirSync(malDir, { recursive: true });
    fs.writeFileSync(path.join(malDir, "evil.txt"), "escape!");
    const malArchive = path.join(tmpDir, "mal-scan.rigbundle");
    await tar.create({ gzip: true, file: malArchive, cwd: malDir, prefix: "..\\escape" }, ["evil.txt"]);
    const entries = await collectUnsafeArchiveEntries(malArchive);
    expect(entries.some((e) => /path traversal/.test(e))).toBe(true);
  });
});
