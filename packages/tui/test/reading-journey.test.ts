import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes } from "../../daemon/src/routes/files.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { resolveEscapeAction } from "../src/input.js";
import { fileLines, referenceAction } from "../src/reading.js";
import type { Action, FleetSnapshot, ViewStateStore } from "../src/types.js";

let home: string, root: string, snap: FleetSnapshot, view: ViewStateStore, client: DaemonClient;
let requests: string[], failRead: boolean;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "s02-reading-")));
  root = join(home, "project"); mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "story.yaml"), "summary: |\n  Understand the manuscript.\n  Read [chapter](docs/chapter.md#second-act).\n");
  writeFileSync(join(root, "docs/chapter.md"), "# First act\nOriginal disk sentence.\n" + "A manuscript paragraph.\n".repeat(35) + "## Second act\nThe second act is current.\n[Back to outline](../outline.md)\n[External](https://example.org/reading)\n");
  writeFileSync(join(root, "outline.md"), "# Outline\nCurrent outline.\n");
  writeFileSync(join(home, "outside.md"), "not readable through project root\n");
  symlinkSync(join(home, "outside.md"), join(root, "escape.md"));
  symlinkSync(join(root, "docs/chapter.md"), join(root, "alias.md"));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("filesAllowlist" as never, [{ name: "project", canonicalPath: root }]); await next(); });
  app.route("/api/files", filesRoutes());
  app.get("/api/specs/library", (c) => c.json([{ id: "story", name: "story", kind: "rig", sourceType: "user_file", sourcePath: join(root, "story.yaml"), version: "1" }]));
  app.get("/api/specs/library/story/review", (c) => c.json({ kind: "rig", format: "pod_aware", sourceState: "library_item", raw: readFileSync(join(root, "story.yaml"), "utf8"), pods: [], edges: [] }));
  app.get("/healthz", (c) => c.json({ selfHostId: "reading-fixture" }));
  requests = []; failRead = false;
  client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url)); requests.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (failRead && u.pathname === "/api/files/read") throw new Error("fixture disconnected");
    return app.request(u.pathname + u.search, init);
  }) as typeof fetch });
  snap = emptySnapshot(); view = createViewState({ instanceId: "reader", getSnapshot: () => snap });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
async function refresh() { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); }
function draw(cols = 80, rows = 24) {
  const screen = renderScreen(view.get(), snap, { cols, rows });
  view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
  return renderScreen(view.get(), snap, { cols, rows });
}
function back() { view.dispatch(resolveEscapeAction({ type: "key", key: "escape" }, view.get())!); }
function open(target: { root: string; path: string; anchor?: string }) { view.dispatch({ type: "file-open", target }); }

describe("current-file reading through real routes and TUI state", () => {
  it.each([[140, 42], [80, 24]])("previews actual purpose, opens detail/source and preserves the caller at %ix%i", async (cols, rows) => {
    view.dispatch({ type: "jump", section: "specs" }); await refresh();
    view.dispatch({ type: "filter", text: "story" });
    const index = computeExplorerRows(view.get(), snap).findIndex((r) => r.key === "spec:rig:story");
    view.dispatch({ type: "select", index });
    let screen = draw(cols, rows);
    expect(screen.lines.join("\n")).toContain("Understand the manuscript.");
    expect(screen.lines.join("\n")).toContain("View current source");
    expect(screen.lines.every((line) => !/[\r\n]/.test(line) && line.length <= cols)).toBe(true);
    const caller = view.get(); view.dispatch({ type: "activate" }); await refresh(); screen = draw(cols, rows);
    if (cols === 80) expect(screen.explorerWidth).toBe(0);
    const action = screen.contentTargets.find((t) => t.action.type === "file-open")!.action;
    view.dispatch(action); await refresh(); screen = draw(cols, rows);
    expect(screen.lines.join("\n")).toContain("summary: |");
    expect(screen.lines.join("\n")).toContain("Read from disk");
    back(); draw(cols, rows); await refresh(); back();
    expect(view.get()).toMatchObject({ selection: caller.selection, contentOffset: caller.contentOffset, filter: "story", drill: [] });
    expect(requests.every((r) => /GET \/(?:healthz|api\/(?:specs\/library|files\/))/.test(r))).toBe(true);
    expect(requests.some((r) => r.includes("review/fleet"))).toBe(false);
  });
  it("re-reads current bytes, follows relative files and anchors, and restores scroll through an in-flight Back", async () => {
    open({ root: "project", path: "docs/chapter.md" }); await refresh(); draw();
    view.dispatch({ type: "content-scroll", delta: 25 }); draw();
    const caller = view.get();
    view.dispatch({ type: "time-setting", timeZone: "Europe/London", timeZoneWarning: null });
    expect(view.get()).toMatchObject({ file: caller.file, contentOffset: caller.contentOffset, history: caller.history, timeZone: "Europe/London" });
    view.dispatch(referenceAction(caller.file!, "../outline.md")); await refresh();
    expect(draw().lines.join("\n")).toContain("Current outline.");
    back(); draw(); // previous file response must not clamp the restored bookmark
    expect(view.get().contentOffset).toBe(caller.contentOffset);
    await refresh(); draw(); expect(view.get().contentOffset).toBe(caller.contentOffset);
    view.dispatch(referenceAction(view.get().file!, "#second-act")); await refresh();
    expect(draw().lines.join("\n")).toContain("The second act is current.");
    expect(draw().lines.join("\n")).toContain("Showing from #second-act");
    writeFileSync(join(root, "docs/chapter.md"), "## Second act\nCHANGED ON DISK\n"); await refresh();
    expect(draw().lines.join("\n")).toContain("CHANGED ON DISK");
    expect(draw().lines.join("\n")).not.toContain("The second act is current.");
    failRead = true; await refresh();
    expect(draw().lines.join("\n")).toContain("read_unavailable");
    expect(draw().lines.join("\n")).not.toContain("CHANGED ON DISK");
  });
  it("resolves links from an internal symlink's actual source, never an unrelated root", async () => {
    open({ root: "project", path: "alias.md", anchor: "second-act" }); await refresh();
    const result = snap.fileRead!.result;
    expect(result).toHaveProperty("resolvedPath", "docs/chapter.md");
    const link = fileLines(result, view.get().file!, 100).find((line) => line.text.includes("Back to outline") && line.action)?.action;
    expect(link).toEqual({ type: "file-open", target: { root: "project", path: "outline.md" } });
  });
  it.each([['missing.md', 'stat_failed'], ['escape.md', 'path_escape'], ['../outside.md', 'path_escape']])("shows the actual reader refusal for %s", async (path, error) => {
    open({ root: "project", path }); await refresh();
    expect(draw().lines.join("\n")).toContain(error);
    expect(draw().lines.join("\n")).not.toContain("not readable through project root");
  });
  it("labels binary and truncated content without presenting them as complete text", async () => {
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 255]));
    open({ root: "project", path: "binary.dat" }); await refresh(); expect(draw().lines.join("\n")).toContain("Binary / non-UTF-8");
    writeFileSync(join(root, "non-utf8.dat"), Buffer.from([255, 128, 42]));
    open({ root: "project", path: "non-utf8.dat" }); await refresh();
    expect(snap.fileRead!.result).toHaveProperty("binary", true);
    expect(draw().lines.join("\n")).toContain("Binary / non-UTF-8");
    writeFileSync(join(root, "large.md"), "A paragraph.\n".repeat(100000));
    open({ root: "project", path: "large.md", anchor: "beyond-prefix" }); await refresh();
    const lines = fileLines(snap.fileRead!.result, view.get().file!, 100).map((line) => line.text).join("\n");
    expect(lines).toContain("TRUNCATED at 1048576 bytes");
    expect(lines).toContain("Heading not found: #beyond-prefix in the returned prefix");
  });
  it.each([[140, 42], [80, 24]])("reads a capped long line and line-broken control, then returns at %ix%i", async (cols, rows) => {
    view.dispatch({ type: "jump", section: "specs" }); await refresh();
    view.dispatch({ type: "filter", text: "story" });
    const index = computeExplorerRows(view.get(), snap).findIndex((r) => r.key === "spec:rig:story");
    view.dispatch({ type: "select", index }); draw(cols, rows);
    const caller = view.get();
    for (const content of ["x".repeat(1048600), ("x".repeat(79) + "\n").repeat(13110)]) {
      writeFileSync(join(root, "large.md"), content + "\n# After limit\n");
      open({ root: "project", path: "large.md", anchor: "after-limit" }); await refresh();
      const result = snap.fileRead!.result;
      expect(result).toMatchObject({ truncated: true, truncatedAtBytes: 1048576, totalBytes: content.length + 15, binary: false });
      const lines = fileLines(result, view.get().file!, cols - 2);
      expect(lines.every((line) => line.text.length <= cols - 2)).toBe(true);
      expect(lines.filter((line) => /^\s*x+$/.test(line.text)).map((line) => line.text.trimStart()).join("")).toBe(content.slice(0, 1048576).replace(/\n/g, ""));
      const screen = draw(cols, rows).lines.join("\n");
      expect(screen).toContain("Read from disk");
      expect(screen).toContain("TRUNCATED at 1048576 bytes");
      expect(screen).toContain("Heading not found: #after-limit in the returned prefix");
      view.dispatch({ type: "content-scroll", delta: 10 }); draw(cols, rows);
      back(); await refresh(); draw(cols, rows);
      expect(view.get()).toMatchObject({ file: null, filter: caller.filter, selection: caller.selection, contentOffset: caller.contentOffset });
    }
  });
  it("keeps missing anchors and HTTP destinations visible with no browser or fetch effect", async () => {
    open({ root: "project", path: "outline.md", anchor: "missing" }); await refresh();
    expect(draw().lines.join("\n")).toContain("Heading not found: #missing");
    const before = requests.length;
    view.dispatch(referenceAction(view.get().file!, "https://example.org/story")); await refresh();
    expect(draw().lines.join("\n")).toContain("No browser opened");
    expect(draw().lines.join("\n")).toContain("https://example.org/story");
    expect(requests).toHaveLength(before);
    back(); expect(view.get().file?.anchor).toBe("missing");
  });
});
