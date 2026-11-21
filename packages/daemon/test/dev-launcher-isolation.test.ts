/**
 * Stage 1 contract 3 extract — DEV launcher isolates HOME / CODEX / CLAUDE.
 * Not a full OS sandbox; proves controlled env for daemon + descendants,
 * including when the parent process inherited operator HOME overrides.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEV_LAUNCHER = path.join(ROOT, "scripts/dev-isolated-daemon.sh");

describe("Contract 3 — DEV launcher isolates HOME / CODEX / CLAUDE", () => {
  it("OPENRIG_HOME alone does not isolate os.homedir() (baseline bug class)", () => {
    const probe = `
      import os from "node:os";
      console.log(JSON.stringify({
        homedir: os.homedir(),
        openrigHome: process.env.OPENRIG_HOME ?? null,
        codexHome: process.env.CODEX_HOME ?? null,
      }));
    `;
    const isolatedOpenrig = fs.mkdtempSync(path.join(os.tmpdir(), "only-openrig-"));
    const realHomeProbe = fs.mkdtempSync(path.join(os.tmpdir(), "real-home-probe-"));
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: realHomeProbe,
        OPENRIG_HOME: isolatedOpenrig,
        // deliberately NO CODEX_HOME / CLAUDE_CONFIG_DIR
      },
    });
    expect(res.status).toBe(0);
    const seen = JSON.parse(res.stdout) as {
      homedir: string;
      openrigHome: string;
      codexHome: string | null;
    };
    expect(seen.openrigHome).toBe(isolatedOpenrig);
    expect(seen.homedir).toBe(realHomeProbe);
    expect(seen.homedir).not.toBe(isolatedOpenrig);
    expect(seen.codexHome).toBeNull();
    fs.rmSync(isolatedOpenrig, { recursive: true, force: true });
    fs.rmSync(realHomeProbe, { recursive: true, force: true });
  });

  it("dev-isolated-daemon.sh exports controlled HOME+CODEX+CLAUDE and preserves canary file bytes", () => {
    expect(fs.existsSync(DEV_LAUNCHER)).toBe(true);
    const src = fs.readFileSync(DEV_LAUNCHER, "utf8");
    expect(src).toMatch(/export HOME=/);
    expect(src).toMatch(/export CODEX_HOME=/);
    expect(src).toMatch(/export CLAUDE_CONFIG_DIR=/);
    expect(src).toMatch(/OPENRIG_HOME/);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-dev-launcher-"));
    const realHome = path.join(work, "real-home");
    const canaryDir = path.join(realHome, ".codex");
    const canary = path.join(canaryDir, "CANARY.txt");
    fs.mkdirSync(canaryDir, { recursive: true });
    const canaryBytes = "operator-codex-canary-immutable\n";
    fs.writeFileSync(canary, canaryBytes);

    const skillsCanary = path.join(realHome, ".claude", "skills", "CANARY.md");
    fs.mkdirSync(path.dirname(skillsCanary), { recursive: true });
    fs.writeFileSync(skillsCanary, "# skills canary\n");

    const statusPath = path.join(work, "status.txt");
    const logPath = path.join(work, "launcher.log");

    const res = spawnSync("bash", [DEV_LAUNCHER, "probe"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: realHome,
        OPENRIG_DEV_ROOT: path.join(work, "dev-root"),
        OPENRIG_DEV_STATUS: statusPath,
        OPENRIG_DEV_LOG: logPath,
        // Inherited overrides must not win — launcher re-exports controlled values.
        CODEX_HOME: path.join(realHome, ".codex"),
        CLAUDE_CONFIG_DIR: path.join(realHome, ".claude"),
      },
    });

    expect(res.status).toBe(0);
    expect(fs.existsSync(statusPath)).toBe(true);
    const status = fs.readFileSync(statusPath, "utf8");
    expect(status).toMatch(/homedir=/);
    expect(status).toMatch(/codex_home=/);
    expect(status).not.toMatch(
      new RegExp(`homedir=${realHome.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`),
    );

    expect(fs.readFileSync(canary, "utf8")).toBe(canaryBytes);
    expect(fs.readFileSync(skillsCanary, "utf8")).toBe("# skills canary\n");

    const fail = spawnSync("bash", [DEV_LAUNCHER, "fail"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: realHome,
        OPENRIG_DEV_ROOT: path.join(work, "dev-root-fail"),
        OPENRIG_DEV_STATUS: path.join(work, "fail-status.txt"),
        OPENRIG_DEV_LOG: path.join(work, "fail.log"),
      },
    });
    expect(fail.status).not.toBe(0);
    expect(fs.existsSync(path.join(work, "fail.log"))).toBe(true);
    expect(fs.readFileSync(path.join(work, "fail.log"), "utf8").length).toBeGreaterThan(0);
    expect(fs.readFileSync(canary, "utf8")).toBe(canaryBytes);

    fs.rmSync(work, { recursive: true, force: true });
  });
});
