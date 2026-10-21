import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { readFrontmatter } from "../src/lib/scope/scope-fs.js";

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe("public slice creation ordinal claims", () => {
  let root: string;
  let workspace: string;
  let mission: string;
  let ownedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-slice-claims-"));
    workspace = path.join(root, "internal-docs");
    mission = path.join(workspace, "missions", "release-0.3.2");
    const home = path.join(root, "owned-home");
    fs.mkdirSync(home);
    ownedEnv = {
      PATH: process.env.PATH, HOME: home, TMPDIR: root,
      OPENRIG_HOME: path.join(home, ".openrig"),
      CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
    };
    execFileSync("git", ["-C", root, "init", "-q"], { env: ownedEnv });
    fs.mkdirSync(path.join(mission, "slices", "01-existing"), { recursive: true });
    fs.writeFileSync(path.join(mission, "README.md"), "---\nid: OPR.0.3.2\n---\n# existing mission\n");
    fs.writeFileSync(path.join(mission, "slices", "01-existing", "README.md"), "---\nid: OPR.0.3.2.1\n---\n# existing slice\n");
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  async function create(slug: string, extra: string[] = [], preload?: string): Promise<Result> {
    const args = [
      ...(preload ? ["--import", preload] : []),
      fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "scope", "slice", "create", "release-0.3.2", slug, ...extra,
      "--workspace", workspace, "--json",
    ];
    try {
      const result = await promisify(execFile)(process.execPath, args, {
        env: ownedEnv, encoding: "utf8", timeout: 15000,
      });
      return { exitCode: 0, ...result };
    } catch (error) {
      const result = error as Error & { code: unknown; stdout: string; stderr: string };
      if (typeof result.code !== "number") throw error;
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  }

  function successful(results: Result[]) {
    expect(results.map((result) => ({ code: result.exitCode, stdout: result.stdout, stderr: result.stderr })))
      .toEqual(results.map((result) => ({ code: 0, stdout: result.stdout, stderr: "" })));
    const slices = results.map((result) => JSON.parse(result.stdout).slice as {
      id: string; name: string; readmePath: string; path: string;
    });
    expect(new Set(slices.map((slice) => slice.id)).size).toBe(slices.length);
    expect(new Set(slices.map((slice) => Number(slice.name.split("-")[0]))).size).toBe(slices.length);
    for (const slice of slices) {
      expect(readFrontmatter(slice.readmePath).id).toBe(slice.id);
      expect(fs.readFileSync(path.join(slice.path, "slice.yaml"), "utf8")).toContain("kind: slice");
    }
    return slices;
  }

  it("a stale ordinal claim skips only its number and survives later creates", async () => {
    const marker = path.join(mission, "slices", ".nn-02");
    fs.writeFileSync(marker, "interrupted creator\n", { flag: "wx" });
    const first = successful([await create("after-interruption")])[0]!;
    const second = successful([await create("next")])[0]!;
    expect(first.id).toBe("OPR.0.3.2.3");
    expect(second.id).toBe("OPR.0.3.2.4");
    expect(fs.readFileSync(marker, "utf8")).toBe("interrupted creator\n");
  });

  it("four eight-process README-backed batches create unique slices without refusals", async () => {
    const original = fs.readFileSync(path.join(mission, "README.md"), "utf8");
    const results: Result[] = [];
    for (let batch = 0; batch < 4; batch++) {
      results.push(...await Promise.all(Array.from({ length: 8 }, (_, index) => create(`readme-${batch}-${index}`))));
    }
    const ids = successful(results).map((slice) => slice.id);
    expect(new Set(ids).size).toBe(32);
    expect(fs.readdirSync(path.join(mission, "slices"), { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(33);
    expect(fs.readFileSync(path.join(mission, "README.md"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(mission, ".openrig-slice-create-lock"))).toBe(false);
  }, 30000);

  it("twenty eight-process manifest-backed batches preserve the admitted concurrency contract", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const authored = { ref, order: 10, active: false };
    const manifest = path.join(mission, "mission.yaml");
    fs.writeFileSync(manifest, "# authored mission comment\n" + YAML.stringify({
      kind: "mission", composition: { slices: [authored] },
    }));
    const unrelated = path.join(mission, "slices", "02-older-unlisted");
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "slice.yaml"), "kind: slice\n");
    fs.writeFileSync(path.join(unrelated, "PROOF.md"), "# unrelated authored proof\n");
    const results: Result[] = [];
    for (let batch = 0; batch < 20; batch++) {
      results.push(...await Promise.all(Array.from({ length: 8 }, (_, index) => create(`manifest-${batch}-${index}`))));
      const slices = successful(results);
      const refs = [ref, ...slices.map((slice) => `slices/${slice.name}/slice.yaml`)];
      for (const slice of slices) {
        for (const file of ["SPEC.md", "PROGRESS.md", "slice.yaml", "PROOF.md"]) {
          expect(fs.readFileSync(path.join(slice.path, file), "utf8")).not.toBe("");
        }
        expect(fs.statSync(path.join(slice.path, "proof")).isDirectory()).toBe(true);
        const ordinal = slice.name.split("-")[0]!;
        expect(JSON.parse(fs.readFileSync(path.join(mission, "slices", `.nn-${ordinal}`), "utf8"))).toEqual({
          schema: "openrig.slice-claim/v1", ref: `slices/${slice.name}/slice.yaml`, state: "verified",
        });
      }
      const bytes = fs.readFileSync(manifest, "utf8");
      const members = (YAML.parse(bytes) as { composition: { slices: Array<{ ref: string; order: number; active: boolean }> } }).composition.slices;
      expect(members).toContainEqual(authored);
      expect(new Set(members.map((member) => member.ref)).size).toBe(members.length);
      expect(new Set(members.map((member) => member.order)).size).toBe(members.length);
      expect(members.every((member) => Number.isInteger(member.order) && typeof member.active === "boolean")).toBe(true);
      expect(members.map((member) => member.order)).toEqual([...members.map((member) => member.order)].sort((a, b) => a - b));
      expect(members.every((member) => refs.includes(member.ref) && fs.statSync(path.join(mission, member.ref)).isFile())).toBe(true);
      expect(members.filter((member) => member.ref !== ref).every((member) => member.active)).toBe(true);
      expect(bytes).toContain("# authored mission comment");
      const present = new Set(members.map((member) => member.ref));
      const omitted = slices.filter((slice) => !present.has(`slices/${slice.name}/slice.yaml`)).map((slice) => ({
        ref: `slices/${slice.name}/slice.yaml`,
        claim: JSON.parse(fs.readFileSync(path.join(mission, "slices", `.nn-${slice.name.split("-")[0]}`), "utf8")),
      }));
      if (omitted.length) console.info("Accepted stale-write membership observations:", JSON.stringify({ batch, omitted }));
    }
    expect(new Set(successful(results).map((slice) => slice.id)).size).toBe(160);
    expect(fs.readFileSync(path.join(unrelated, "PROOF.md"), "utf8")).toBe("# unrelated authored proof\n");
    expect(fs.existsSync(path.join(mission, ".openrig-slice-create-lock"))).toBe(false);
  }, 180000);

  it("a later create repairs only pending complete registrations and preserves authored membership", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    fs.writeFileSync(manifest, "# preserve authored comment\n" + YAML.stringify({
      kind: "mission", composition: { slices: [{ ref, order: 70, active: false }] },
    }));
    for (const name of ["02-complete", "03-incomplete"]) {
      fs.mkdirSync(path.join(mission, "slices", name));
      fs.writeFileSync(path.join(mission, "slices", name, "slice.yaml"), "kind: slice\n");
      fs.writeFileSync(path.join(mission, "slices", name, "SPEC.md"), "# scaffold\n");
    }
    fs.writeFileSync(path.join(mission, "slices", ".nn-02"), JSON.stringify({ schema: "openrig.slice-claim/v1", ref: "slices/02-complete/slice.yaml", state: "pending" }));
    fs.writeFileSync(path.join(mission, "slices", ".nn-03"), JSON.stringify({ schema: "openrig.slice-claim/v1", ref: "slices/03-incomplete/slice.yaml", state: "pending" }));
    const proof = path.join(mission, "slices", "02-complete", "PROOF.md");
    fs.writeFileSync(proof, "# completed evidence\n");
    const created = successful([await create("repair")])[0]!;
    const bytes = fs.readFileSync(manifest, "utf8");
    const members = YAML.parse(bytes).composition.slices;
    expect(members).toContainEqual({ ref, order: 70, active: false });
    expect(members.map((member: { ref: string }) => member.ref).sort()).toEqual([
      ref, "slices/02-complete/slice.yaml", `slices/${created.name}/slice.yaml`,
    ].sort());
    expect(bytes).toContain("# preserve authored comment");
    expect(fs.readFileSync(proof, "utf8")).toBe("# completed evidence\n");
    expect(fs.existsSync(path.join(mission, "slices", "03-incomplete", "SPEC.md"))).toBe(true);
  });

  it("verified and repaired registrations stay removed after manual membership removal", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    const authored = { ref, order: 70, active: false };
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [authored] } }));
    const first = successful([await create("registered")])[0]!;
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [authored] } }));
    const next = successful([await create("after-removal")])[0]!;
    const members = YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices;
    expect(members).toEqual([authored, { ref: `slices/${next.name}/slice.yaml`, order: 80, active: true }]);
    expect(JSON.parse(fs.readFileSync(path.join(mission, "slices", ".nn-02"), "utf8")).state).toBe("verified");
    expect(fs.existsSync(path.join(first.path, "PROOF.md"))).toBe(true);
  });

  it("older complete unlisted folders without pending evidence remain unlisted", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    const authored = { ref, order: 70, active: false };
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [authored] } }));
    for (const name of ["02-older", "03-legacy-marker", "04-verified"]) {
      fs.mkdirSync(path.join(mission, "slices", name));
      fs.writeFileSync(path.join(mission, "slices", name, "slice.yaml"), "kind: slice\n");
      fs.writeFileSync(path.join(mission, "slices", name, "PROOF.md"), "# complete\n");
    }
    fs.writeFileSync(path.join(mission, "slices", ".nn-03"), "");
    fs.writeFileSync(path.join(mission, "slices", ".nn-04"), JSON.stringify({ schema: "openrig.slice-claim/v1", ref: "slices/04-verified/slice.yaml", state: "verified" }));
    const next = successful([await create("new")])[0]!;
    expect(YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices).toEqual([
      authored, { ref: `slices/${next.name}/slice.yaml`, order: 80, active: true },
    ]);
  });

  it("bounded verify failure reports nonzero and retains a complete scaffold for the next create", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [{ ref, order: 10, active: true }] } }));
    const injected = path.join(root, "drop-own-member.mjs");
    const writes = path.join(root, "injected-write-count");
    fs.writeFileSync(injected, `
      import fs from "node:fs";
      import { createRequire } from "node:module";
      const require = createRequire(${JSON.stringify(new URL("../../../package.json", import.meta.url).href)});
      const YAML = require("yaml");
      const original = fs.renameSync.bind(fs);
      fs.renameSync = (source, target) => {
        original(source, target);
        if (String(target) !== ${JSON.stringify(manifest)}) return;
        const doc = YAML.parse(fs.readFileSync(target, "utf8"));
        doc.composition.slices = doc.composition.slices.filter((member) => !member.ref.includes("-lost/slice.yaml"));
        fs.writeFileSync(target, YAML.stringify(doc));
        fs.appendFileSync(${JSON.stringify(writes)}, "write\\n");
      };
    `);
    const result = await create("lost", [], injected);
    expect(result.exitCode).toBe(1);
    expect(result.stdout, result.stderr).not.toBe("");
    expect(JSON.parse(result.stdout).error.fact).toContain("after 10 attempts");
    expect(JSON.parse(result.stdout).error.consequence).toContain("scaffold was kept");
    expect(fs.readFileSync(writes, "utf8").trim().split("\n")).toHaveLength(10);
    const kept = path.join(mission, "slices", "02-lost");
    for (const file of ["SPEC.md", "slice.yaml", "PROGRESS.md", "PROOF.md"]) expect(fs.existsSync(path.join(kept, file))).toBe(true);
    expect(YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices.map((member: { ref: string }) => member.ref)).not.toContain("slices/02-lost/slice.yaml");
    const recovered = successful([await create("recover")])[0]!;
    expect(YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices.map((member: { ref: string }) => member.ref).sort()).toEqual([
      ref, "slices/02-lost/slice.yaml", `slices/${recovered.name}/slice.yaml`,
    ].sort());
    expect(JSON.parse(fs.readFileSync(path.join(mission, "slices", ".nn-02"), "utf8")).state).toBe("verified");
    const repairedDoc = YAML.parse(fs.readFileSync(manifest, "utf8"));
    repairedDoc.composition.slices = repairedDoc.composition.slices.filter((member: { ref: string }) => member.ref !== "slices/02-lost/slice.yaml");
    fs.writeFileSync(manifest, YAML.stringify(repairedDoc));
    successful([await create("after-repaired-removal")]);
    expect(YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices.map((member: { ref: string }) => member.ref)).not.toContain("slices/02-lost/slice.yaml");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an actual manifest EACCES preserves the complete slice for later repair", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [{ ref, order: 10, active: true }] } }));
    fs.chmodSync(mission, 0o500);
    try {
      const result = await create("write-denied");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("EACCES");
      const kept = path.join(mission, "slices", "02-write-denied");
      for (const file of ["SPEC.md", "slice.yaml", "PROOF.md"]) expect(fs.existsSync(path.join(kept, file))).toBe(true);
    } finally {
      fs.chmodSync(mission, 0o700);
    }
    successful([await create("repair-write")]);
    expect(YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices.map((member: { ref: string }) => member.ref)).toContain("slices/02-write-denied/slice.yaml");
  });

  it("a partial final PROOF write cannot be adopted by a real competing creator", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [{ ref, order: 10, active: true }] } }));
    const observed = path.join(root, "competing-manifest");
    const competitorArgs = [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "scope", "slice", "create", "release-0.3.2", "competitor", "--workspace", workspace, "--json"];
    const injected = path.join(root, "partial-proof-write.mjs");
    fs.writeFileSync(injected, `
      import fs from "node:fs";
      import { execFileSync } from "node:child_process";
      const original = fs.writeFileSync.bind(fs);
      fs.writeFileSync = (target, data, options) => {
        if (/\\/PROOF\\.md(?:\\.openrig-.*\\.tmp)?$/.test(String(target))) {
          original(target, "# partial proof", options);
          execFileSync(process.execPath, ${JSON.stringify(competitorArgs)}, { env: ${JSON.stringify(ownedEnv)}, timeout: 15000 });
          original(${JSON.stringify(observed)}, fs.readFileSync(${JSON.stringify(manifest)}, "utf8"));
          throw Object.assign(new Error("injected partial PROOF write"), { code: "EIO" });
        }
        return original(target, data, options);
      };
    `);
    const before = fs.readFileSync(path.join(mission, "README.md"), "utf8");
    const failed = await create("partial", [], injected);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout + failed.stderr).toContain("injected partial PROOF write");
    expect(fs.existsSync(path.join(mission, "slices", "02-partial"))).toBe(false);
    expect(fs.readFileSync(path.join(mission, "README.md"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(mission, "slices", ".nn-02"))).toBe(true);
    expect(YAML.parse(fs.readFileSync(observed, "utf8")).composition.slices.map((member: { ref: string }) => member.ref)).not.toContain("slices/02-partial/slice.yaml");
    expect(successful([await create("after-partial")])[0]!.id).toBe("OPR.0.3.2.4");
  });

  it.each([false, true])("an incomplete creator preserves concurrent parent edits (parent initially has ID: %s)", async (hasId) => {
    const parent = path.join(mission, "README.md");
    if (!hasId) fs.writeFileSync(parent, "---\nintent: existing mission\n---\n# existing mission\n");
    const expectedParent = path.join(root, "concurrent-parent-bytes");
    const competitorOutput = path.join(root, "competitor-output.json");
    const competitorArgs = [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "scope", "slice", "create", "release-0.3.2", "successful", "--workspace", workspace, "--json"];
    const injected = path.join(root, "fail-scaffold-after-competitor.mjs");
    fs.writeFileSync(injected, `
      import fs from "node:fs";
      import { execFileSync } from "node:child_process";
      const original = fs.writeFileSync.bind(fs);
      fs.writeFileSync = (target, data, options) => {
        if (String(target) === ${JSON.stringify(path.join(mission, "slices", "02-failed", "SPEC.md"))}) {
          const output = execFileSync(process.execPath, ${JSON.stringify(competitorArgs)}, { env: ${JSON.stringify(ownedEnv)}, encoding: "utf8", timeout: 15000 });
          original(${JSON.stringify(competitorOutput)}, output);
          const current = fs.readFileSync(${JSON.stringify(parent)}, "utf8") + "\\nA concurrent authored edit.\\n";
          original(${JSON.stringify(parent)}, current);
          original(${JSON.stringify(expectedParent)}, current);
          throw Object.assign(new Error("injected incomplete scaffold failure"), { code: "EIO" });
        }
        return original(target, data, options);
      };
    `);

    const failed = await create("failed", [], injected);

    expect(failed.exitCode).toBe(1);
    expect(failed.stdout + failed.stderr).toContain("injected incomplete scaffold failure");
    expect(fs.readFileSync(parent, "utf8")).toBe(fs.readFileSync(expectedParent, "utf8"));
    expect(readFrontmatter(parent).id).toBe("OPR.0.3.2");
    const competitor = JSON.parse(fs.readFileSync(competitorOutput, "utf8")).slice;
    expect(competitor.id).toBe("OPR.0.3.2.3");
    expect(readFrontmatter(competitor.readmePath).id).toBe(competitor.id);
    expect(fs.existsSync(path.join(competitor.path, "PROOF.md"))).toBe(true);
    expect(fs.existsSync(path.join(mission, "slices", "02-failed"))).toBe(false);
    expect(fs.existsSync(path.join(mission, "slices", ".nn-02"))).toBe(true);
    expect(successful([await create("after-failure")])[0]!.id).toBe("OPR.0.3.2.4");
  });

  it.each([false, true])("an isolated incomplete failure retains parent persistence (parent initially has ID: %s)", async (hasId) => {
    const parent = path.join(mission, "README.md");
    if (!hasId) fs.writeFileSync(parent, "---\nintent: authored mission\n---\n# existing mission\n");
    const originalParent = fs.readFileSync(parent, "utf8");
    const writtenParent = path.join(root, "persisted-parent-bytes");
    const parentWrites = path.join(root, "parent-write-count");
    const injected = path.join(root, "isolated-incomplete-failure.mjs");
    fs.writeFileSync(injected, `
      import fs from "node:fs";
      const original = fs.writeFileSync.bind(fs);
      fs.writeFileSync = (target, data, options) => {
        if (String(target) === ${JSON.stringify(parent)}) fs.appendFileSync(${JSON.stringify(parentWrites)}, "write\\n");
        if (String(target) === ${JSON.stringify(path.join(mission, "slices", "02-failed", "SPEC.md"))}) {
          original(${JSON.stringify(writtenParent)}, fs.readFileSync(${JSON.stringify(parent)}, "utf8"));
          throw Object.assign(new Error("isolated incomplete scaffold failure"), { code: "EIO" });
        }
        return original(target, data, options);
      };
    `);
    const failed = await create("failed", [], injected);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout + failed.stderr).toContain("isolated incomplete scaffold failure");
    const bytes = fs.readFileSync(parent, "utf8");
    expect(bytes).toBe(fs.readFileSync(writtenParent, "utf8"));
    const writes = fs.existsSync(parentWrites) ? fs.readFileSync(parentWrites, "utf8").trim().split("\n").length : 0;
    expect(writes).toBe(hasId ? 0 : 1);
    if (hasId) expect(bytes).toBe(originalParent);
    else {
      expect(bytes).not.toBe(originalParent);
      expect(readFrontmatter(parent).id).toEqual(expect.any(String));
      expect(readFrontmatter(parent).id).not.toBe("");
      expect(readFrontmatter(parent).intent).toBe("authored mission");
      expect(bytes).toContain("# existing mission");
    }
    expect(fs.existsSync(path.join(mission, "slices", "02-failed"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(mission, "slices", ".nn-02"), "utf8"))).toEqual({
      schema: "openrig.slice-claim/v1", ref: "slices/02-failed/slice.yaml", state: "pending",
    });
  });

  it("an old mission guard is preserved but does not block a new creator", async () => {
    const guard = path.join(mission, ".openrig-slice-create-lock");
    fs.mkdirSync(guard);
    fs.writeFileSync(path.join(guard, "inspection-required"), "interrupted guard\n");
    successful([await create("ignores-old-lock")]);
    expect(fs.readFileSync(path.join(guard, "inspection-required"), "utf8")).toBe("interrupted guard\n");
  });

  it("serial creates retain ordinary numbering and scaffold output", async () => {
    const ref = "slices/01-existing/slice.yaml";
    fs.writeFileSync(path.join(mission, ref), "kind: slice\n");
    const manifest = path.join(mission, "mission.yaml");
    const authored = { ref, order: 10, active: false };
    fs.writeFileSync(manifest, YAML.stringify({ kind: "mission", composition: { slices: [authored] } }));
    const ids: string[] = [];
    const refs = [ref];
    for (let index = 0; index < 4; index++) {
      const slice = successful([await create(`serial-${index}`)])[0]!;
      ids.push(slice.id);
      refs.push(`slices/${slice.name}/slice.yaml`);
      const members = YAML.parse(fs.readFileSync(manifest, "utf8")).composition.slices;
      expect(members.map((member: { ref: string }) => member.ref)).toEqual(refs);
      expect(members[0]).toEqual(authored);
    }
    expect(ids).toEqual(["OPR.0.3.2.2", "OPR.0.3.2.3", "OPR.0.3.2.4", "OPR.0.3.2.5"]);
  });

  it("validation failures do not claim a number or change authored bytes", async () => {
    const original = fs.readFileSync(path.join(mission, "README.md"), "utf8");
    for (const extra of [["--template", "invalid"], ["--depends-on", "other.1"], ["--depends-on", "OPR.0.3.2.2"]]) {
      expect((await create("invalid", extra)).exitCode).toBe(1);
      expect(fs.readdirSync(path.join(mission, "slices"))).toEqual(["01-existing"]);
      expect(fs.readFileSync(path.join(mission, "README.md"), "utf8")).toBe(original);
    }
    expect(successful([await create("valid")])[0]!.id).toBe("OPR.0.3.2.2");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an actual EACCES claim failure leaves no scaffold or consumed number", async () => {
    const slices = path.join(mission, "slices");
    const original = fs.readFileSync(path.join(mission, "README.md"), "utf8");
    fs.chmodSync(slices, 0o500);
    try {
      const result = await create("denied");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("EACCES");
      expect(fs.readdirSync(slices)).toEqual(["01-existing"]);
      expect(fs.readFileSync(path.join(mission, "README.md"), "utf8")).toBe(original);
    } finally {
      fs.chmodSync(slices, 0o700);
    }
    expect(successful([await create("retry")])[0]!.id).toBe("OPR.0.3.2.2");
  });
});
