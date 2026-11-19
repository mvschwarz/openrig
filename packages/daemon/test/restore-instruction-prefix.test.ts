import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postCompactExtraSetting, restoreSessionUserHome, withManagedRestoreReads } from "../src/domain/managed-restore-read-access.js";
import { buildPostCompactRestorePrompt } from "../src/domain/claude-compaction-enforcer.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each(["~/extra.md", "${OPENRIG_HOME}/extra.md", "$OPENRIG_HOME/extra.md", "~\\extra.md", "${OPENRIG_HOME}\\extra.md", "$OPENRIG_HOME\\extra.md"])("resolves and grants only the configured instruction file: %s", async raw => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-prefix-")); roots.push(root);
  const home = path.join(root, "daemon"), userHome = path.join(root, "user");
  const daemonUserHome = path.join(root, "daemon-user");
  fs.mkdirSync(home); fs.mkdirSync(userHome); fs.mkdirSync(daemonUserHome);
  vi.stubEnv("HOME", daemonUserHome);
  if (process.platform === "win32") vi.stubEnv("USERPROFILE", daemonUserHome);
  const getSessionEnv = vi.fn(async () => userHome);
  const selectedHome = await restoreSessionUserHome({ getSessionEnv }, "owned@rig");
  expect(selectedHome).toBe(userHome);
  expect(getSessionEnv.mock.calls).toEqual([["owned@rig", process.platform === "win32" ? "USERPROFILE" : "HOME"]]);
  const expands = raw.includes("/") || process.platform === "win32";
  const expected = expands ? path.join(raw.startsWith("~") ? userHome : home, "extra.md") : raw;
  expect(postCompactExtraSetting(`  ${raw}\n`, home, selectedHome)).toBe(expected);
  expect(buildPostCompactRestorePrompt({ openrigHome: home, sessionName: "owned@rig", postCompactInstructionFilePath: raw, userHome: selectedHome }))
    .toContain(`Additional post-compaction instruction file: ${expected}.`);
  const settings = withManagedRestoreReads([], { openrigHome: home, cwd: root, session: "owned@rig", nativeSessionId: "", extraInstructionFile: raw, userHome: selectedHome });
  const allow = JSON.parse(settings[1]!).permissions.allow as string[];
  const escaped = path.resolve(expected).split(path.sep).join("/").replace(/[\\*?\[\]()!{}]/g, "\\$&");
  expect(allow).toContain(`Read(/${escaped})`);
  expect(allow).not.toContain(`Read(/${path.dirname(escaped)}/*)`);
});

it.each([undefined, "relative-home", "bad\0home", "bad\rhome", "bad\nhome"])("does not adopt an invalid or missing session user home: %s", async value => {
  expect(await restoreSessionUserHome({ getSessionEnv: async () => value }, "owned@rig")).toBeUndefined();
});

it("retains the legacy default when the home observation is unavailable", async () => {
  expect(await restoreSessionUserHome({}, "owned@rig")).toBeUndefined();
  expect(await restoreSessionUserHome({ getSessionEnv: async () => { throw new Error("unavailable"); } }, "owned@rig")).toBeUndefined();
});
