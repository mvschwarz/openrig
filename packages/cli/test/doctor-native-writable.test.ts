import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDoctorChecks } from "../src/commands/doctor.js";
import { denyWindowsDirectoryCreation } from "../../daemon/test/helpers/directory-permissions.js";

it.runIf(process.platform === "win32")("doctor's default writable check observes the directory DACL and leaves no probe", () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-native-writable-"));
  const restore = denyWindowsDirectoryCreation(home);
  const deps = {
    exists: () => false, baseDir: home, readFile: () => null, exec: () => "",
    checkPort: async () => true, platform: "win32" as const,
    configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: join(home, "db.sqlite") }, transcripts: { enabled: true, path: home } }) },
  };
  try {
    expect(runDoctorChecks(deps, []).checks.find(check => check.name === "writable_home")).toMatchObject({ status: "fail" });
    expect(readdirSync(home)).toEqual([]);
    restore();
    expect(runDoctorChecks(deps, []).checks.find(check => check.name === "writable_home")).toMatchObject({ status: "pass" });
    expect(readdirSync(home)).toEqual([]);
  } finally { restore(); rmSync(home, { recursive: true, force: true }); }
});
