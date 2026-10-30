import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveRunnerHome } from "../src/adapters/runner-home.js";
import { resolveStubActivityEndpoint } from "../src/adapters/stub-runner.js";

it("preserves explicit instance and POSIX home selection", () => {
  expect(resolveRunnerHome({ OPENRIG_HOME: " selected instance ", HOME: "other" }, "linux")).toBe("selected instance");
  expect(resolveRunnerHome({ HOME: "/synthetic-home", USERPROFILE: "ignored" }, "linux")).toBe(join("/synthetic-home", ".openrig"));
  expect(resolveRunnerHome({}, "linux")).toBe(join(homedir(), ".openrig"));
});

it.runIf(process.platform === "win32")("reads the native profile endpoint without HOME or a cwd-relative fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-native-home-"));
  const profile = join(root, "用户 profile &");
  const home = join(profile, ".openrig"); mkdirSync(home, { recursive: true });
  const selected = { baseUrl: "http://127.0.0.1:12345", token: "synthetic-profile-token" };
  writeFileSync(join(home, "activity-endpoint.json"), JSON.stringify(selected));
  try {
    const env = { userprofile: profile };
    expect(resolveRunnerHome(env)).toBe(home);
    expect(resolveStubActivityEndpoint(env)).toEqual(selected);
    expect(resolveRunnerHome({ ...env, openrig_home: join(root, "explicit") })).toBe(join(root, "explicit"));
    expect(resolveStubActivityEndpoint({ ...env, OPENRIG_URL: "http://127.0.0.1:23456", OPENRIG_ACTIVITY_HOOK_TOKEN: "synthetic-explicit" }))
      .toEqual({ baseUrl: "http://127.0.0.1:23456", token: "synthetic-explicit" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
