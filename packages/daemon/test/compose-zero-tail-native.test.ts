import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";

const execute = promisify(execFile);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32").each([0, 25, undefined])("preserves explicit zero log tail in native argument dispatch: %s", async (tail) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-tail-argv-"));
  dirs.push(dir);
  // Controlled executable records real shell arguments; it never contacts Docker.
  fs.writeFileSync(path.join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const adapter = new ComposeServicesAdapter(async (command) => {
    const { stdout } = await execute("/bin/sh", ["-c", command], { env: { PATH: dir } });
    return stdout;
  });
  const result = await adapter.logs({
    composeFile: path.join(dir, "services.yaml"),
    projectName: "owned-fixture",
    service: "api",
    tail,
  });
  expect(result.ok).toBe(true);
  const args = result.output.trim().split("\n");
  if (tail === undefined) {
    expect(args).not.toContain("--tail");
  } else {
    const tailIndex = args.indexOf("--tail");
    expect(args.slice(tailIndex, tailIndex + 2)).toEqual(["--tail", String(tail)]);
  }
  expect(args.at(-1)).toBe("api");
});
