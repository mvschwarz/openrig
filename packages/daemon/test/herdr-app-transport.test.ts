import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAppReply, createAppSocketExchange, createHcRunner, describeCore, hcEnv, resolveHerdrAppHome, WINDOW_DID_NOT_ANSWER } from "../src/domain/terminal/herdr-app-transport.js";

// Real exchanges, captured from a live herdr-app 0.1.13 / hc 0.1.18 in an isolated sandbox.
const CAPTURES = join(import.meta.dirname, "fixtures", "herdr-app-captures");
type Capture = { name: string; channel: string; request: { line?: string }; reply: { line?: string | null; transport_error?: string; late_line?: string | null } };
const captures: Capture[] = readdirSync(CAPTURES).filter((f) => f.endsWith(".json") && !f.startsWith("index"))
  .map((f) => JSON.parse(readFileSync(join(CAPTURES, f), "utf8")) as Capture);
const app = captures.filter((c) => c.channel === "app-socket");

describe("classifyAppReply against the captured replies", () => {
  it("covers the captured app exchanges", () => {
    expect(app.length).toBeGreaterThanOrEqual(25);
  });

  it("an answered request is ok", () => {
    for (const c of app.filter((c) => c.reply.line && !JSON.parse(c.reply.line).error)) {
      expect(classifyAppReply(c.reply.line!), c.name).toEqual({ kind: "ok", value: JSON.parse(c.reply.line!) });
    }
  });

  it("a definite error is refused: nothing was done", () => {
    const refused = app.filter((c) => c.name.startsWith("error-"));
    expect(refused.map((c) => c.name).sort()).toEqual(["error-bad-json", "error-missing-required", "error-select-unknown-child",
      "error-select-unknown-stack", "error-unknown-command", "error-unknown-pane", "error-unknown-tab"]);
    for (const c of refused) expect(classifyAppReply(c.reply.line!).kind, c.name).toBe("refused");
  });

  it("the window's own 5 s reply is unknown, never failed: the captures show the request applied afterwards", () => {
    for (const name of ["timeout-window-busy", "timeout-do-applied-later"]) {
      const c = app.find((x) => x.name === name)!;
      expect(JSON.parse(c.reply.line!).error).toBe(WINDOW_DID_NOT_ANSWER);
      expect(classifyAppReply(c.reply.line!)).toEqual({ kind: "unknown", reason: WINDOW_DID_NOT_ANSWER });
    }
  });

  it("no reply is unknown; unreadable is unknown", () => {
    const c = app.find((x) => x.name === "uncertain-no-reply")!;
    expect(c.reply.transport_error).toMatch(/no reply within/);
    expect(c.reply.late_line).toBeTruthy(); // and the request did run
    expect(classifyAppReply(null).kind).toBe("unknown");
    expect(classifyAppReply("{not json").kind).toBe("unknown");
  });
});

describe("the Rig layout's assumptions, against the captured window", () => {
  const named = (name: string) => captures.find((c) => c.name === name)! as Capture & {
    reply: { json?: unknown; text_on_disk?: string }; effect?: { status?: { layout?: string; errors?: string[] } } };

  it("layout.switch says ok even when the layout file doesn't exist: an ok reply is not proof the view is shown", () => {
    const missing = named("layout-switch-missing");
    expect(classifyAppReply(missing.reply.line!)).toMatchObject({ kind: "ok" });
    expect(missing.effect?.status?.layout).not.toBe("rig");
    // So the provider selects the view only after the strip acknowledges the written revision.
  });

  it("a stack selection is not written back into rig.json: the file keeps `active` on the person's tab block", () => {
    expect(named("layout-select-view").reply.line).toBeTruthy();
    expect(named("layout-select-written-back").reply.json).toMatchObject({ id: "rig-work", type: "stack", active: "main" });
  });

  it("a rewrite of the shown rig.json is applied; an unreadable one is reported in status and the file is left alone", () => {
    expect(named("layout-rewrite-while-shown").effect?.status).toMatchObject({ layout: "rig", errors: [] });
    const rejected = named("layout-rewrite-rejected");
    expect(rejected.effect?.status?.layout).toBe("rig");
    expect(rejected.effect?.status?.errors?.join(" ")).toMatch(/layouts\/rig\.json was not applied/);
    expect(rejected.reply.text_on_disk).toBe("{ not json\n");
  });
});

describe("createAppSocketExchange (one request per connection, as herdr-app's own client)", () => {
  const roots: string[] = [];
  const servers: net.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const serve = async (onLine: (line: string, socket: net.Socket) => void) => {
    const root = mkdtempSync(join(tmpdir(), "ha-")); roots.push(root);
    const path = join(root, "herdr-app.sock");
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => { buf += d; const nl = buf.indexOf("\n"); if (nl >= 0) onLine(buf.slice(0, nl), socket); });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return path;
  };

  it("sends exactly one JSON line and reads one back", async () => {
    const seen: string[] = [];
    const path = await serve((line, socket) => { seen.push(line); socket.end(`${JSON.stringify({ layout: "rig" })}\n`); });
    expect(await createAppSocketExchange(path)({ status: true }, 1000)).toEqual({ kind: "ok", value: { layout: "rig" } });
    expect(seen).toEqual(['{"status":true}']);
  });

  it("a request sent with no reply in time is unknown; one the window refuses is refused", async () => {
    const silent = await serve(() => {});
    expect(await createAppSocketExchange(silent)({ do: "pane.split", args: {} }, 50)).toMatchObject({ kind: "unknown" });
    const refusing = await serve((_l, socket) => socket.end('{"error":"no pane \\"p1\\""}\n'));
    expect(await createAppSocketExchange(refusing)({ do: "pane.close", args: { pane: "p1" } }, 1000)).toEqual({ kind: "refused", error: 'no pane "p1"' });
  });

  it("no window at that home is unavailable: nothing was sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ha-")); roots.push(root);
    expect(await createAppSocketExchange(join(root, "herdr-app.sock"))({ status: true }, 500)).toMatchObject({ kind: "unavailable" });
  });

  it("resolves the app home as herdr-app does", () => {
    expect(resolveHerdrAppHome({ HERDR_APP_HOME: "/a" })).toBe("/a");
    expect(resolveHerdrAppHome({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/herdr-app");
    expect(resolveHerdrAppHome({ HOME: "/h" })).toBe("/h/.config/herdr-app");
    expect(resolveHerdrAppHome({ HERDR_APP_HOME: "", HOME: "/h" })).toBe("/h/.config/herdr-app");
  });

  it("records the runner's herdr-core from the env it executes with, and describes it with or without a socket", () => {
    const clean = hcEnv({ env: { HC_SCOPE: "s-1", HC_TERMINAL_ID: "t-1", HC_TERMINAL_SOCKET: "/t.sock", HC_SESSION: "work", HC_SOCKET: "/run/w.sock" } });
    expect(clean).toEqual({ HC_SESSION: "work", HC_SOCKET: "/run/w.sock" });
    const withSocket = createHcRunner({ env: { HC_SESSION: "work", HC_SOCKET: "/run/w.sock" } });
    expect(withSocket.core).toEqual({ session: "work", socket: "/run/w.sock" });
    expect(describeCore(withSocket)).toBe('herdr-core session "work" (socket /run/w.sock)');
    const defaultCore = createHcRunner({ env: {} });
    expect(defaultCore.core).toEqual({ session: "default" });
    expect(describeCore(defaultCore)).toBe("herdr-core the default session");
    expect(describeCore(async () => ({ exit: 0, json: null, stdout: "" }))).toBe("the daemon's herdr-core");
  });
});

describe("detection cost: status() when herdr-app is absent or hung (bounded, no hc)", () => {
  it("a missing socket answers unavailable at once; a socket that never replies is cut off at the status timeout", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const net = await import("node:net");
    const { HerdrAppClient, createAppSocketExchange } = await import("../src/domain/terminal/herdr-app-transport.js");
    const dir = mkdtempSync(join(tmpdir(), "herdr-app-cost-"));
    try {
      let t0 = Date.now();
      const missing = await new HerdrAppClient(createAppSocketExchange(join(dir, "absent.sock"))).status(1_000);
      const missingMs = Date.now() - t0;
      expect(missing.kind).toBe("unavailable");
      expect(missingMs).toBeLessThan(900);
      // A socket that accepts and never answers (a wedged window).
      const hungPath = join(dir, "hung.sock");
      const server = net.createServer(() => { /* never replies */ });
      await new Promise<void>((r) => server.listen(hungPath, () => r()));
      t0 = Date.now();
      const hung = await new HerdrAppClient(createAppSocketExchange(hungPath)).status(1_000);
      const hungMs = Date.now() - t0;
      server.close();
      expect(hung.kind).toBe("unknown");
      expect(hungMs).toBeGreaterThanOrEqual(900);
      expect(hungMs).toBeLessThan(3_000);
      console.log(`herdr-app status: missing socket ${missingMs} ms; hung socket ${hungMs} ms`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
