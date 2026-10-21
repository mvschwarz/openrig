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
    // after a good one (an older, stale reading and a failed leg from here), seat accounts in each shape, and a Claude
    // login whose windows come from two seats' status lines that disagree on the 5-hour window.
    const a = await host("a", { rewrite: (p, b) => (p === "/api/provider/status" ? { ...(b as object), seatAccounts: SEAT_SHAPES } : b) });
    const b = await host("b", { codex: { secondaryUsed: 90 } });
    const c = await host("c", { codex: { email: "other@example.com" } });
    const off = await host("off", { usageWindows: false });
    const failing = await host("failing");
    const claude = await host("claude", { samples: [
      { seatSession: "seat-1@r", window: "five_hour", usedPercent: 85, resetsAt: "2026-10-14T02:00:00.000Z", sampledAt: "2026-10-13T23:25:00.000Z" },
      { seatSession: "seat-2@r", window: "five_hour", usedPercent: 30, resetsAt: "2026-10-14T04:00:00.000Z", sampledAt: "2026-10-13T23:24:00.000Z" },
      { seatSession: "seat-1@r", window: "weekly", usedPercent: 40, resetsAt: "2026-10-20T00:00:00.000Z", sampledAt: "2026-10-13T23:25:00.000Z" },
    ] });
    const hub = await host("hub", { registry: [a.entry(), b.entry(), c.entry(), off.entry(), failing.entry(), claude.entry()] });
    for (const h of [a, b, c, failing]) await post(h.url, "/api/provider/usage/refresh", { provider: "codex" });
    await post(claude.url, "/api/provider/usage/refresh", { provider: "claude" });
    failing.codex = { fail: { reason: "rpc_error", detail: "the app-server said no" } };
    await post(hub.url, "/api/provider/usage/hosts/refresh", { provider: "codex", hosts: ["failing"] });

    const served = JSON.parse(await run(CHECK.split(" ").slice(2), hub)) as unknown;
    const paths = fieldPaths(page);
    expect(paths.length).toBeGreaterThan(15);
    expect(paths.filter((p) => !present(served, p.split(".")))).toEqual([]);

    // The window names the page teaches are the ones served, Claude's and Codex's.
    const items = (served as { items: Array<{ observations: Array<{ row: { windows: Array<{ window: string; level: string }> } }> }> }).items;
    const windows = items.flatMap((g) => g.observations.flatMap((o) => o.row.windows));
    for (const name of ["five_hour", "weekly", "primary", "secondary"]) {
      expect(page).toContain(`\`${name}\``);
      expect(windows.map((w) => w.window)).toContain(name);
    }
    // The page's can't-tell case for a level the number can't be used with is served here: seats that disagree.
    expect(windows.some((w) => w.window === "five_hour" && w.level === "unknown")).toBe(true);
  });

  it("another login on the same Codex account: the item with the recorded key and email is found once, with a usable reading", async () => {
    expect(page).toContain("Codex: the one item with the recorded key and email is theirs even if its linkage is unknown; say the other login's\n"
      + "observations are unlinked (items[].notes).");
    // The person's login on a; the same account under another login email on c.
    const a = await host("a");
    const c = await host("c", { codex: { email: "other@example.com" } });
    const hub = await host("hub", { registry: [a.entry(), c.entry()] });
    for (const h of [a, c]) await post(h.url, "/api/provider/usage/refresh", { provider: "codex" });
    type Item = { key: string | null; linkage: string; notes: string[];
      observations: Array<{ row: { identity: { email?: string | null } | null; windows: Array<{ window: string; freshness: string; level: string }> } }> };
    const { items } = JSON.parse(await run(CHECK.split(" ").slice(2), hub)) as { items: Item[] };
    const key = "codex:account:acct-1:codex", email = "dev@example.com";
    const carries = (g: Item, e: string) => g.observations.every((o) => o.row.identity?.email === e);
    const pinned = items.filter((g) => g.key === key && carries(g, email));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.linkage).toBe("unknown");
    expect(pinned[0]!.notes.join("\n")).toContain("is also observed on c under another login email");
    expect(items.filter((g) => g.key === key && g !== pinned[0]).map((g) => carries(g, "other@example.com"))).toEqual([true]);
    const usable = pinned[0]!.observations.flatMap((o) => o.row.windows).filter((w) => w.freshness === "fresh" && w.level !== "unknown");
    expect(usable.map((w) => w.window)).toContain("secondary");
  });

  it("a field the page names by itself is the last part of a path it names in full", () => {
    const section = page.slice(page.indexOf("## A usage warning"), page.indexOf("## What not to use"));
    const tails = new Set(fieldPaths(page).map((p) => p.split(".").at(-1)!.replace("[]", "")));
    const bare = [...new Set([...section.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)].map((m) => m[1]!))];
    expect(bare.length).toBeGreaterThanOrEqual(3);
    expect(bare.filter((f) => !tails.has(f))).toEqual([]);
  });
});
