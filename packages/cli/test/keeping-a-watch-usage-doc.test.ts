// OPR.0.7.0.3 with slice 01: keeping-a-watch.md's usage warning names a check command and the served fields an operator
// reads. This runs that command against loopback daemons (usage-hosts-harness.ts: the daemon's real provider and config
// routes, scripted native readers) and checks that every field path the page names is in the served answer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { SEAT_SHAPES, UsageHost, type UsageHostOptions } from "../../daemon/test/helpers/usage-hosts-harness.js";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/reference/keeping-a-watch.md");
const CHECK = "rig provider status --all-hosts --json";
const NOW = "2026-10-13T23:30:00.000Z";

function deps(url: string): StatusDeps {
  const port = Number(new URL(url).port);
  const lifecycleDeps = {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "t", startedAt: "x" }) : null)),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  } as unknown as LifecycleDeps;
  return { lifecycleDeps, clientFactory: (u) => new DaemonClient(u) };
}

async function run(args: string[], hub: UsageHost): Promise<string> {
  const out: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  try {
    await providerCommand(deps(hub.url)).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
  }
  process.exitCode = undefined;
  return out.join("\n");
}

const open: UsageHost[] = [];
async function host(id: string, opts: UsageHostOptions = {}): Promise<UsageHost> {
  const h = await UsageHost.start(id, { now: () => NOW, routes: { usageAcrossHosts: { now: () => NOW, refreshDeadlineMs: { codex: 300 } } }, ...opts });
  open.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function post(url: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

/** Field paths the page names, rooted at the answer's top-level keys: `items[].observations[].row.windows[].remainingPercent`. */
function fieldPaths(markdown: string): string[] {
  const paths = [...markdown.matchAll(/`((?:items|hosts|seatAccounts)\[\][A-Za-z.[\]]*)`/g)].map((m) => m[1]!);
  return [...new Set(paths)];
}

/** Whether some element of the answer has a value (not undefined) at this path. */
function present(value: unknown, path: string[]): boolean {
  if (path.length === 0) return value !== undefined;
  const [head, ...rest] = path;
  const many = head!.endsWith("[]");
  const key = many ? head!.slice(0, -2) : head!;
  if (typeof value !== "object" || value === null) return false;
  const next = (value as Record<string, unknown>)[key];
  if (!many) return present(next, rest);
  return Array.isArray(next) && next.some((v) => present(v, rest));
}

describe("keeping-a-watch: the usage warning", () => {
  const page = readFileSync(PAGE, "utf8");

  it("names the served check, and never puts --refresh in it", () => {
    expect(page).toContain(`**The check is \`${CHECK}\`.**`);
    expect(page).toContain(`Check: \`${CHECK}\` (served readings only; never --refresh).`);
  });

  it("every field path the page names is in what that command serves", async () => {
    // Two machines with one login, one with another login's same account, a switched-off one, one whose read failed
    // after a good one (an older, stale reading and a failed leg from here), and seat accounts in each shape.
    const a = await host("a", { rewrite: (p, b) => (p === "/api/provider/status" ? { ...(b as object), seatAccounts: SEAT_SHAPES } : b) });
    const b = await host("b", { codex: { secondaryUsed: 90 } });
    const c = await host("c", { codex: { email: "other@example.com" } });
    const off = await host("off", { usageWindows: false });
    const failing = await host("failing");
    const hub = await host("hub", { registry: [a.entry(), b.entry(), c.entry(), off.entry(), failing.entry()] });
    for (const h of [a, b, c, failing]) await post(h.url, "/api/provider/usage/refresh", { provider: "codex" });
    failing.codex = { fail: { reason: "rpc_error", detail: "the app-server said no" } };
    await post(hub.url, "/api/provider/usage/hosts/refresh", { provider: "codex", hosts: ["failing"] });

    const served = JSON.parse(await run(CHECK.split(" ").slice(2), hub)) as unknown;
    const paths = fieldPaths(page);
    expect(paths.length).toBeGreaterThan(15);
    expect(paths.filter((p) => !present(served, p.split(".")))).toEqual([]);
  });

  it("a field the page names by itself is the last part of a path it names in full", () => {
    const section = page.slice(page.indexOf("## A usage warning"), page.indexOf("## What not to use"));
    const tails = new Set(fieldPaths(page).map((p) => p.split(".").at(-1)!.replace("[]", "")));
    const bare = [...new Set([...section.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)].map((m) => m[1]!))];
    expect(bare.length).toBeGreaterThanOrEqual(3);
    expect(bare.filter((f) => !tails.has(f))).toEqual([]);
  });
});
