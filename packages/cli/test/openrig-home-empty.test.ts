import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { terminalAuthHeaders } from "../src/client.js";

// An empty OPENRIG_HOME means unset everywhere else in the CLI (readOpenRigEnv);
// the terminal token lookup must read ~/.openrig, not a cwd-relative file.
describe("empty OPENRIG_HOME", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("terminalAuthHeaders reads the token from ~/.openrig", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-empty-home-"));
    dirs.push(home);
    fs.mkdirSync(path.join(home, ".openrig"));
    fs.writeFileSync(path.join(home, ".openrig", "terminal-token"), "tok-123\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENRIG_HOME", "");
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "");
    expect(terminalAuthHeaders()).toEqual({ Authorization: "Bearer tok-123" });
  });
});
