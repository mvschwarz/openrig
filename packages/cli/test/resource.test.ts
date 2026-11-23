import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const source = { kind: "native", list: (rig: string) => rig === "studio"
      ? [{ id: "native-1", summary: "Managed entry", details: { state: "ready" } }] : [] };
    const run = (...args: string[]) => resourceCommand([source]).parse(args, { from: "user" });
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
    run("link", "--kind", "ticket", "--id", "internal-7");
    run("link", "D:\\work\\notes.txt", "--kind", "file", "--id", "notes-path");
    run("link", "any short label");
    run("link", "myapp:project/9", "--kind", "app");
    run("link", "--kind", "note", "--id", "decision", "--content", "first line\nsecond line");
    const textFile = join(home, "brief.txt");
    writeFileSync(textFile, "A written brief\n");
    run("link", "--kind", "note", "--id", "brief", "--content-file", textFile);
    vi.stubEnv("OPENRIG_SESSION_NAME", "reviewer@studio");
    const prs = list("--kind", "pr");
    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(pr);
    expect(prs[0].links.map((link: { ref: string }) => link.ref).sort()).toEqual(["qitem-1", "workflow-2"]);
    expect(list("--kind", "mr")).toMatchObject([{ url: mr }]);
    expect(list("--kind", "report")).toMatchObject([{ url: "https://docs.example/report" }]);
    expect(list("--kind", "ticket")).toMatchObject([{ id: "internal-7" }]);
    expect(list("--kind", "ticket")[0]).not.toHaveProperty("url");
    expect(list("--kind", "file")).toMatchObject([{ id: "notes-path", value: "D:\\work\\notes.txt" }]);
    expect(list("--kind", "value")).toMatchObject([{ id: "any short label" }]);
    expect(list("--kind", "app")).toMatchObject([{ url: "myapp:project/9" }]);
    expect(list("--kind", "note")).toMatchObject([
      { id: "brief", links: [{ content: "A written brief\n" }] },
      { id: "decision", links: [{ content: "first line\nsecond line" }] },
    ]);
    run("unlink", "--kind", "ticket", "--id", "internal-7", "--ref", "builder@studio");
    expect(list("--kind", "ticket")).toEqual([]);
    expect(list("--kind", "native")).toEqual([{ kind: "native", id: "native-1", summary: "Managed entry", details: { state: "ready" } }]);
    expect(() => run("link", "https://docs.example/report", "--kind", "native")).toThrow("read-only");
    run("unlink", pr, "--ref", "qitem-1");
    expect(list("--kind", "pr")).toMatchObject([{ links: [{ ref: "workflow-2" }] }]);
    vi.stubEnv("OPENRIG_SESSION_NAME", "reviewer@other");
    expect(list()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
