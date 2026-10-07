// The person-facing `rigs` skill lives at skills/rigs, where skills.sh finds it. The package carries one copy at
// packages/daemon/assets/skills/rigs, which the daemon installs globally under OpenRig's own version. It isn't an
// openrig-core plugin skill, so it stays out of seat loadouts and the openrig-skills index.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { createDaemon } from "../src/startup.js";
import { getDaemonVersion } from "../src/domain/daemon-version.js";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SOURCE = join(REPO_ROOT, "skills/rigs");
const PACKAGED = resolve(import.meta.dirname, "../assets/skills/rigs");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
  .sort();

describe("the rigs skill installed globally", () => {
  it("ships one packaged copy, byte-identical to skills/rigs", () => {
    expect(files(PACKAGED)).toEqual(files(SOURCE));
    for (const name of files(SOURCE)) {
      expect(readFileSync(join(PACKAGED, name)), `copy ${name} from skills/rigs to packages/daemon/assets/skills/rigs`)
        .toEqual(readFileSync(join(SOURCE, name)));
    }
  });

  it("is not an openrig-core plugin skill", () => {
    expect(existsSync(resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills/rigs"))).toBe(false);
  });

  it("startup installs it for both harnesses under OpenRig's version, and leaves a skills.sh copy alone", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "rigs-global-"));
    roots.push(root);
    const skillsSh = join(root, ".agents/skills/rigs");
    mkdirSync(skillsSh, { recursive: true });
    writeFileSync(join(skillsSh, "SKILL.md"), "# rigs, installed by skills.sh\n");
    vi.stubEnv("OPENRIG_HOME", root);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(PluginVendorService.prototype, "attemptAutoFetch").mockResolvedValue();

    const { db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxFactory: async () => { throw new Error("inert fixture"); } });
    try {
      const claude = join(root, ".claude/skills/rigs");
      expect(readFileSync(join(claude, "SKILL.md"))).toEqual(readFileSync(join(PACKAGED, "SKILL.md")));
      expect(readFileSync(join(claude, ".openrig-vendor-version"), "utf8")).toBe(`${getDaemonVersion()}\n`);
      expect(readFileSync(join(skillsSh, "SKILL.md"), "utf8")).toBe("# rigs, installed by skills.sh\n");
      expect(existsSync(join(skillsSh, ".openrig-vendor-version"))).toBe(false);
    } finally { db.close(); }
  });
});
