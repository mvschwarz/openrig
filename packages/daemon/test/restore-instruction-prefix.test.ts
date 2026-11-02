import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postCompactExtraSetting, withManagedRestoreReads } from "../src/domain/managed-restore-read-access.js";
import { buildPostCompactRestorePrompt } from "../src/domain/claude-compaction-enforcer.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each(["~/extra.md", "${OPENRIG_HOME}/extra.md", "$OPENRIG_HOME/extra.md", "~\\extra.md", "${OPENRIG_HOME}\\extra.md", "$OPENRIG_HOME\\extra.md"])("resolves and grants only the configured instruction file: %s", raw => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-prefix-")); roots.push(root);
  const home = path.join(root, "daemon"), userHome = path.join(root, "user");
  fs.mkdirSync(home); fs.mkdirSync(userHome);
  vi.stubEnv("HOME", userHome);
  if (process.platform === "win32") vi.stubEnv("USERPROFILE", userHome);
  const expands = raw.includes("/") || process.platform === "win32";
  const expected = expands ? path.join(raw.startsWith("~") ? userHome : home, "extra.md") : raw;
  expect(postCompactExtraSetting(`  ${raw}\n`, home)).toBe(expected);
  expect(buildPostCompactRestorePrompt({ openrigHome: home, sessionName: "owned@rig", postCompactInstructionFilePath: raw }))
    .toContain(`Additional post-compaction instruction file: ${expected}.`);
  const settings = withManagedRestoreReads([], { openrigHome: home, cwd: root, session: "owned@rig", nativeSessionId: "", extraInstructionFile: raw });
  const allow = JSON.parse(settings[1]!).permissions.allow as string[];
  const escaped = path.resolve(expected).split(path.sep).join("/").replace(/[\\*?\[\]()!{}]/g, "\\$&");
  expect(allow).toContain(`Read(/${escaped})`);
  expect(allow).not.toContain(`Read(/${path.dirname(escaped)}/*)`);
});
