import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { AttentionRead } from "@openrig/daemon/attention";
import { sgrClick } from "../src/input.js";
import { renderScreen, type RenderOptions } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { columns } from "../src/visual-layout.js";

const snap = emptySnapshot();
const state = createViewState({ instanceId: "command-caret" }).get();

it.each([
  { name: "Feed", view: { ...state, section: "needs" as const }, options: {} },
  { name: "Pulse", view: { ...state, viewTab: "pulse" as const }, options: {} },
  { name: "recovery", view: state, options: { unavailable: "fixture prerequisite unavailable" } },
] satisfies { name: string; view: typeof state; options: RenderOptions }[])(
  "shows the wide draft's tail and caret in $name",
  ({ view, options }) => {
    const draft = `reply ${"old text ".repeat(10)}${"x".repeat(27)} tail`;
    const screen = renderScreen(view, snap, { ...options, cols: 40, nowMs: 2000 }, draft);
    expect(screen.lines[0]).toBe(`cmd ▸ …${"x".repeat(27)} tail▊`);
  },
);

it("scrolls with a mid-draft caret instead of showing the tail", () => {
  const before = "a".repeat(36) + "bcde";
  const draft = before + "f".repeat(40) + "tail";
  const options = { cols: 24, nowMs: 0, commandCaret: before.length };
  const middle = renderScreen(state, snap, options, draft);
  const start = renderScreen(state, snap, { ...options, commandCaret: 0 }, draft);
  const edge = renderScreen(state, snap, { ...options, commandCaret: 17 }, draft);
  expect(middle.lines[0]).toBe("cmd ▸ …aaaabcde▊fffffff…");
  expect(start.lines[0]).toBe(`cmd ▸ ▊${"a".repeat(16)}…`);
  expect(edge.lines[0]).toBe(`cmd ▸ ${"a".repeat(17)}▊`);
});

it("preserves short and exactly fitting command rows", () => {
  expect(renderScreen(state, snap, { cols: 20, nowMs: 0 }, "reply ok").lines[0]).toBe("cmd ▸ reply ok▊     ");
  expect(renderScreen(state, snap, { cols: 15, nowMs: 0 }, "reply ok").lines[0]).toBe("cmd ▸ reply ok▊");
});

it("clips at whole graphemes within the terminal column budget", () => {
  const draft = `${"界".repeat(20)}👩🏽‍💻e\u0301`;
  const line = renderScreen(state, snap, { cols: 15, nowMs: 0 }, draft).lines[0] ?? "";
  expect(line).toBe("cmd ▸ …界界👩🏽‍💻e\u0301▊");
  expect(columns(line)).toBe(15);
});

it("sends the full reply on Enter after drawing a clipped draft", async () => {
  const home = await mkdtemp(join(tmpdir(), "tui-reply-"));
  const helper = join(home, "rig.mjs");
  await writeFile(helper, `console.log(process.argv[2] === "config" ? '{"value":"UTC"}' : '{"state":"up"}');`);
  const item = {
    id: "queue:fixture", kind: "action", summary: "Composer fixture request", unblocks: null,
    urgency: "routine", at: "2026-10-23T19:00:00Z", scope: "instance", project: null,
    source: "/api/queue/fixture", recipient: "human@fixture", answer: { verb: "resolve", actorSession: "human@fixture" },
  } as const;
  const posts: unknown[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-type", "application/json");
    if (path.pathname === "/api/attention") {
      res.end(JSON.stringify({ scope: "instance", readAt: item.at, items: [item], sources: [], detailError: null,
        detail: path.searchParams.get("item") === item.id ? { item, lines: ["Composer fixture detail"], files: [] } : null,
      } satisfies AttentionRead));
    } else if (path.pathname === "/api/queue/human-updates") {
      res.end(JSON.stringify({ items: [], limit: 20, truncated: false }));
    } else if (path.pathname === "/api/files/roots") {
      res.end(JSON.stringify({ roots: [] }));
    } else if (req.method === "POST" && path.pathname === "/api/mission-control/action") {
      let body = "";
      req.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => {
        posts.push(JSON.parse(body));
        res.end(JSON.stringify({ verb: "resolve", qitemId: "fixture", closedQitem: {} }));
      });
    } else {
      res.end(JSON.stringify(path.pathname === "/api/review/fleet" ? { needsYou: { items: [] }, hosts: [] } : []));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Reply fixture did not bind TCP");
  const loader = new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENRIG_|RIGGED_)/.test(key)));
  Object.assign(env, { HOME: home, OPENRIG_HOME: home, OPENRIG_TUI_CLI_ENTRY: helper });
  const child = spawn(process.execPath, ["--import", loader, main, "--no-color", "--url", `http://127.0.0.1:${address.port}`],
    { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const frame = () => (stdout.split("\x1b[H").at(-1) ?? "").split("\r\n");
  const waitFor = (check: () => void) => vi.waitFor(() => {
    expect(child.exitCode, stderr).toBeNull();
    check();
  }, { timeout: 8000 });
  try {
    await waitFor(() => expect(stdout).toContain("no rigs served"));
    child.stdin.write("feed\r");
    const requestRow = () => frame().findIndex(row => row.includes("[routine] Composer fixture request")) + 1;
    await waitFor(() => expect(requestRow(), frame().join("\n")).toBeGreaterThan(0));
    child.stdin.write(sgrClick(40, requestRow()));
    await waitFor(() => expect(frame().join("\n")).toContain("Composer fixture detail"));
    const decision = `Keep the beginning. ${"Repeat this  twice. ".repeat(8)}Keep the tail too.`;
    child.stdin.write(`reply ${decision}`);
    await waitFor(() => expect(frame()[0]).toMatch(/cmd ▸ ….*Keep the tail too\.▊/));
    expect(posts).toHaveLength(0);
    child.stdin.write("\r");
    await waitFor(() => expect(posts).toEqual([{
      qitemId: "fixture", verb: "resolve", actorSession: "human@fixture", authority: "primary-user", decision,
    }]));
  } finally {
    child.kill("SIGTERM");
    await closed;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 35_000);
