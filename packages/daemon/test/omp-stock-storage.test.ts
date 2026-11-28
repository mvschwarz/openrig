import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmpSeatLauncher } from "../src/adapters/omp-seat-launch.js";
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";
import { classifyResourceProjection } from "../src/domain/conflict-detector.js";
import { ompFiles } from "./helpers/omp-files.js";

describe("OMP managed skill writes on real storage", () => {
  let root: string;
  let skills: string;
  let source: string;
  let outside: string;
  let adapter: OmpTuiRuntimeAdapter;
  const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const binding = () => ({ tmuxSession: "worker@rig", cwd: root, seatSkillsRoot: skills });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-storage-"));
    skills = path.join(root, "state/seats/rig/worker/omp/skills");
    source = path.join(root, "source/linked"); outside = path.join(root, "outside");
    fs.mkdirSync(skills, { recursive: true }); fs.mkdirSync(outside);
    write(path.join(source, "SKILL.md"), "Same instructions");
    write(path.join(source, "helpers/run.sh"), "New helper");
    fs.chmodSync(path.join(source, "helpers/run.sh"), 0o755);
    const launcher = new OmpSeatLauncher({ fsOps: ompFiles, tmux: {} as never, stateRoot: path.join(root, "state/omp"), seatExtensionPath: "/seat.js" });
    adapter = new OmpTuiRuntimeAdapter({ fsOps: ompFiles, launcher, tmux: {} as never });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each(["skill-directory", "helper-directory", "helper-file"])("refuses %s links even when SKILL.md is a no-op", async kind => {
    const target = path.join(skills, "linked");
    write(path.join(outside, "SKILL.md"), "Same instructions");
    write(path.join(outside, "helpers/run.sh"), "Operator helper");
    fs.chmodSync(path.join(outside, "helpers/run.sh"), 0o600);
    if (kind === "skill-directory") fs.symlinkSync(outside, target);
    else {
      write(path.join(target, "SKILL.md"), "Same instructions");
      if (kind === "helper-directory") fs.symlinkSync(path.join(outside, "helpers"), path.join(target, "helpers"));
      else {
        fs.mkdirSync(path.join(target, "helpers"));
        fs.symlinkSync(path.join(outside, "helpers/run.sh"), path.join(target, "helpers/run.sh"));
      }
    }
    const classification = classifyResourceProjection(path.join(source, "SKILL.md"), path.join(target, "SKILL.md"), "skill", undefined, ompFiles, () => null);
    expect(classification).toBe("no_op");
    // Catch partial copies too: a safe new file must not be copied before discovering a bad helper path.
    write(path.join(source, "a-new-file"), "Should not be copied");
    const result = await adapter.project({ entries: [{ category: "skill", effectiveId: "linked", absolutePath: source, classification }] } as never, binding());
    expect(result.projected).toEqual([]);
    expect(result.failed).toEqual([{ effectiveId: "linked", error: expect.stringContaining("not inside this seat's storage") }]);
    expect(fs.readFileSync(path.join(outside, "helpers/run.sh"), "utf8")).toBe("Operator helper");
    expect(fs.statSync(path.join(outside, "helpers/run.sh")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(target, "a-new-file"))).toBe(false);
  });

  it("refuses a linked portable skill owner marker before copying any files", async () => {
    const plugin = path.join(root, "plugin");
    write(path.join(plugin, "skills/linked/SKILL.md"), "New instructions");
    write(path.join(skills, "linked/SKILL.md"), "Operator instructions");
    write(path.join(outside, "owner"), "portable");
    fs.symlinkSync(path.join(outside, "owner"), path.join(skills, "linked/.openrig-plugin"));
    const result = await adapter.project({ entries: [{ category: "plugin", effectiveId: "portable", absolutePath: plugin }] } as never, binding());
    expect(result.failed).toHaveLength(1);
    expect(fs.readFileSync(path.join(skills, "linked/SKILL.md"), "utf8")).toBe("Operator instructions");
    expect(fs.readFileSync(path.join(outside, "owner"), "utf8")).toBe("portable");
  });

  it.each(["folder", "symlink", "hardlink"])("refuses startup skill_install through a linked %s", async kind => {
    write(path.join(outside, "SKILL.md"), "Operator skill");
    if (kind === "folder") fs.symlinkSync(outside, path.join(skills, "linked"));
    else {
      fs.mkdirSync(path.join(skills, "linked"));
      const link = kind === "hardlink" ? fs.linkSync : fs.symlinkSync;
      link(path.join(outside, "SKILL.md"), path.join(skills, "linked/SKILL.md"));
    }
    const result = await adapter.deliverStartup([{ path: "SKILL.md", absolutePath: path.join(source, "SKILL.md"),
      ownerRoot: root, deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] }], binding());
    expect(result.failed).toHaveLength(1);
    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("Operator skill");
  });

  it("removes deselected portable skills and preserves additions and edits", async () => {
    const plugin = path.join(root, "plugin");
    for (const id of ["untouched", "edited", "extra"]) write(path.join(plugin, "skills", id, "SKILL.md"), "original");
    const selected = { entries: [{ category: "plugin", effectiveId: "portable", absolutePath: plugin }] } as never;
    expect((await adapter.project(selected, binding())).failed).toEqual([]);
    write(path.join(skills, "edited/SKILL.md"), "mine");
    write(path.join(skills, "extra/notes"), "mine too");
    await adapter.project(selected, binding());
    await adapter.project({ entries: [] } as never, binding());
    expect(fs.existsSync(path.join(skills, "untouched"))).toBe(false);
    expect(fs.readFileSync(path.join(skills, "edited/SKILL.md"), "utf8")).toBe("mine");
    expect(fs.readFileSync(path.join(skills, "extra/notes"), "utf8")).toBe("mine too");
  });

  it("keeps operator edits and the current selected supplier when two plugins provide a skill", async () => {
    const plan = (...ids: string[]) => ({ entries: ids.map(effectiveId => ({
      category: "plugin", effectiveId, absolutePath: path.join(root, effectiveId),
    })) }) as never;
    for (const id of ["first", "second"]) write(path.join(root, id, "skills/shared/SKILL.md"), id);
    const target = path.join(skills, "shared/SKILL.md");
    await adapter.project(plan("first"), binding());
    await adapter.project(plan("second", "first"), binding());
    expect(fs.readFileSync(target, "utf8")).toBe("first");
    await adapter.project(plan("second"), binding());
    expect(fs.readFileSync(target, "utf8")).toBe("second");
    write(target, "operator edit");
    await adapter.project(plan("first"), binding());
    expect(fs.readFileSync(target, "utf8")).toBe("operator edit");
  });

  it("keeps a selected supplier’s skills when its inventory fails and resumes projection after recovery", async () => {
    const plugin = path.join(root, "portable");
    const inventory = path.join(plugin, "skills");
    const entry = { category: "plugin", effectiveId: "supplier", absolutePath: plugin };
    const plan = { entries: [entry] } as never;
    write(path.join(inventory, "research/SKILL.md"), "original");
    expect((await adapter.project(plan, binding())).failed).toEqual([]);
    const list = ompFiles.listFiles;
    const spy = vi.spyOn(ompFiles, "listFiles").mockImplementation(dir => {
      if (dir === inventory) throw new Error("unreadable inventory");
      return list(dir);
    });
    try {
      expect((await adapter.project(plan, binding())).failed).toEqual([{ effectiveId: "supplier", error: "unreadable inventory" }]);
      expect(fs.readFileSync(path.join(skills, "research/SKILL.md"), "utf8")).toBe("original");
    } finally { spy.mockRestore(); }
    write(path.join(inventory, "research/SKILL.md"), "updated");
    expect((await adapter.project(plan, binding())).failed).toEqual([]);
    expect(fs.readFileSync(path.join(skills, "research/SKILL.md"), "utf8")).toBe("updated");
  });

  it("reports a broken manifest and keeps the last usable native package selected", async () => {
    const plugin = path.join(root, "native");
    write(path.join(plugin, "package.json"), JSON.stringify({ omp: { extensions: ["./index.js"] } }));
    write(path.join(plugin, "index.js"), "version one");
    const plan = { entries: [{ category: "plugin", effectiveId: "native", absolutePath: plugin }] } as never;
    expect((await adapter.project(plan, binding())).failed).toEqual([]);
    const installed = (await adapter.listInstalled(binding())).find(e => e.effectiveId === "native")!;
    write(path.join(plugin, "package.json"), "{invalid json");
    expect((await adapter.project(plan, binding())).failed).toEqual([{ effectiveId: "native", error: expect.any(String) }]);
    expect(await adapter.listInstalled(binding())).toContainEqual(installed);
    expect(fs.readFileSync(path.join(installed.installedPath, "index.js"), "utf8")).toBe("version one");
    fs.unlinkSync(path.join(plugin, "package.json"));
    expect((await adapter.project(plan, binding())).failed).toHaveLength(1);
    expect(await adapter.listInstalled(binding())).toContainEqual(installed);
    write(path.join(plugin, "package.json"), "{}");
    expect((await adapter.project(plan, binding())).failed).toEqual([]);
    expect(await adapter.listInstalled(binding())).not.toContainEqual(installed);
  });

  it("keeps distinct plugin IDs and replaces a selected package's whole tree", async () => {
    const plugin = path.join(root, "plugin");
    write(path.join(plugin, "package.json"), JSON.stringify({ omp: { extensions: ["./index.js"] } }));
    write(path.join(plugin, "index.js"), "v1");
    write(path.join(plugin, "obsolete.js"), "old helper");
    const plan = { entries: ["shared:core", "shared-core"].map(effectiveId => ({ category: "plugin", effectiveId, absolutePath: plugin })) } as never;
    expect((await adapter.project(plan, binding())).failed).toEqual([]);
    const installed = (await adapter.listInstalled(binding())).filter(e => e.category === "plugin");
    expect(installed.map(e => e.effectiveId).sort()).toEqual(["shared-core", "shared:core"]);
    expect(new Set(installed.map(e => e.installedPath)).size).toBe(2);
    fs.unlinkSync(path.join(plugin, "obsolete.js"));
    write(path.join(plugin, "index.js"), "v2");
    expect((await adapter.project(plan, binding())).failed).toEqual([]);
    for (const { installedPath } of installed) {
      expect(fs.existsSync(path.join(installedPath, "obsolete.js"))).toBe(false);
      expect(fs.readFileSync(path.join(installedPath, "index.js"), "utf8")).toBe("v2");
    }
  });

  it("refuses a hard-linked destination before changing contents or permissions", async () => {
    const target = path.join(skills, "linked/helpers/run.sh");
    write(path.join(outside, "operator"), "preserve"); fs.chmodSync(path.join(outside, "operator"), 0o600);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.linkSync(path.join(outside, "operator"), target);
    const result = await adapter.project({ entries: [{ category: "skill", effectiveId: "linked", absolutePath: source }] } as never, binding());
    expect(result.failed).toHaveLength(1);
    expect(fs.readFileSync(target, "utf8")).toBe("preserve");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("projects a portable skill without the obsolete no-extension warning", async () => {
    const plugin = path.join(root, "plugin");
    write(path.join(plugin, "skills/research/SKILL.md"), "Research instructions");
    const result = await adapter.project({ entries: [{ category: "plugin", effectiveId: "portable", absolutePath: plugin }] } as never, binding());
    expect(result).toMatchObject({ projected: ["portable"], failed: [] });
    expect(result.warnings ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(skills, "research/SKILL.md"), "utf8")).toBe("Research instructions");
  });
});
