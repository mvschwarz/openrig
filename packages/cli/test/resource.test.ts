import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resourceCommand } from "../src/commands/resource.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("shares durable links within one rig and preserves other associations when unlinking", () => {
  const home = mkdtempSync(join(tmpdir(), "rig-resources-"));
  try {
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "builder@studio");
    const run = (...args: string[]) => resourceCommand().parse(args, { from: "user" });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const list = (...args: string[]) => {
      run("list", "--json", ...args);
      return JSON.parse(stdout.mock.lastCall![0]);
    };
    const pr = "https://github.com/owner/repo/pull/42";
    const mr = "https://gitlab.example/team/subgroup/repo/-/merge_requests/17";
    run("link", "https://github.com/Owner/Repo/pull/42/files#diff-1", "--ref", "qitem-1");
    run("link", pr, "--ref", "qitem-1");
    run("link", pr, "--ref", "workflow-2");
    run("link", mr);
    run("link", "https://docs.example/report", "--kind", "report");
    vi.stubEnv("OPENRIG_SESSION_NAME", "reviewer@studio");
    const prs = list("--kind", "pr");
    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(pr);
    expect(prs[0].links.map((link: { ref: string }) => link.ref).sort()).toEqual(["qitem-1", "workflow-2"]);
    expect(list("--kind", "mr")).toMatchObject([{ url: mr }]);
    expect(list("--kind", "report")).toMatchObject([{ url: "https://docs.example/report" }]);
    run("unlink", pr, "--ref", "qitem-1");
    expect(list("--kind", "pr")).toMatchObject([{ links: [{ ref: "workflow-2" }] }]);
    vi.stubEnv("OPENRIG_SESSION_NAME", "reviewer@other");
    expect(list()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
