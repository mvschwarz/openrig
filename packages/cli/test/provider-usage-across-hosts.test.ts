// Slice 01 (OPR.0.7.0.1) — `rig provider status --all-hosts | --hosts` against a loopback hub daemon that joins
// loopback hosts (the daemon's real provider and config routes, scripted native readers; usage-hosts-harness.ts).
// The human view prints every served fact verbatim; --json prints the served body; a refresh across hosts reports
// each failed leg and keeps the view.
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { closedPortUrl, UsageHost, type UsageHostOptions } from "../../daemon/test/helpers/usage-hosts-harness.js";

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

async function run(args: string[], hub: UsageHost): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [], err: string[] = [];
  const origLog = console.log, origErr = console.error;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    await providerCommand(deps(hub.url)).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

const open: UsageHost[] = [];
async function host(id: string, opts: UsageHostOptions = {}): Promise<UsageHost> {
  const h = await UsageHost.start(id, { now: () => NOW, routes: { usageAcrossHosts: { now: () => NOW } }, ...opts });
  open.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function refreshDirect(h: UsageHost): Promise<void> {
  const res = await fetch(`${h.url}/api/provider/usage/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex" }) });
  expect(res.status).toBe(200);
}

/** The served facts a person must see: identities, hosts, times, levels and freshness with reasons, notes, failures. */
function facts(view: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === "string" && v.length > 0) out.push(v); };
  for (const h of view["hosts"] as Array<Record<string, unknown>>) {
    for (const k of ["hostId", "error", "usageReason", "readAt"]) add(h[k]);
    for (const leg of Object.values((h["lastRefresh"] ?? {}) as Record<string, Record<string, unknown>>)) for (const k of ["at", "reason", "detail"]) add(leg[k]);
  }
  for (const s of view["skipped"] as Array<Record<string, unknown>>) { add(s["hostId"]); add(s["reason"]); }
  for (const g of view["items"] as Array<Record<string, unknown>>) {
    for (const n of g["notes"] as string[]) add(n);
    for (const o of g["observations"] as Array<Record<string, unknown>>) {
      add(o["hostId"]);
      add(o["readAt"]);
      const row = o["row"] as Record<string, unknown>;
      const id = (row["identity"] ?? {}) as Record<string, unknown>;
      for (const k of ["accountId", "workspaceId", "limitId", "email", "orgId"]) add(id[k]);
      add(row["unavailableReason"]);
      for (const w of row["windows"] as Array<Record<string, unknown>>) for (const k of ["window", "resetsAt", "observedAt", "level", "levelReason", "freshness", "freshnessReason"]) add(w[k]);
      const last = row["lastRefresh"] as Record<string, unknown> | null;
      if (last?.["outcome"] === "failed") for (const k of ["at", "reason", "detail"]) add(last[k]);
    }
  }
  return [...new Set(out)];
}

describe("rig provider status --all-hosts", () => {
  it("prints every served fact verbatim: one entry per allowance with each host's observation, and every host's status", async () => {
    const a = await host("a");
    const b = await host("b", { codex: { secondaryUsed: 90, secondaryResetsAt: "2026-10-20T04:00:00.000Z" } });
    const c = await host("c", { codex: { email: "other@example.com" } });
    const off = await host("off", { usageWindows: false });
    const down = await closedPortUrl();
    const hub = await host("hub", { registry: [a.entry(), b.entry(), c.entry(), off.entry(), { id: "down", transport: "http", url: down }] });
    for (const h of [a, b, c]) await refreshDirect(h);

    const served = await (await fetch(`${hub.url}/api/provider/usage/hosts`)).json() as Record<string, unknown>;
    const { out, exitCode } = await run(["status", "--all-hosts"], hub);
    expect(exitCode).toBeUndefined();
    const missing = facts(served).filter((f) => !out.includes(f));
    expect(missing).toEqual([]);
    expect(facts(served).length).toBeGreaterThan(20);
    // One entry for the shared login on a and b (disagreeing), one for c's other login, never a sum.
    expect(out).toContain("codex  account acct-1 · bucket codex  [the same allowance on 2 hosts, disagreeing: a, b]");
    expect(out).toContain("codex  account acct-1 · bucket codex  [linkage unknown; observed on c]");
    expect(out).toContain("  down  unreachable (");
    expect(out).toContain("  off  answered · usage off: usage windows are off on this host (provider.usage_windows = false)");
  });

  it("waits for a view that takes the daemon longer than 5 s: a switched-off host answering its status and settings after 4.5 s each", async () => {
    const slow = await host("slow", { usageWindows: false, slowReadMs: 4_500 });
    const hub = await host("hub", { registry: [slow.entry()] });
    const started = Date.now();
    const got = await run(["status", "--all-hosts"], hub);
    expect(Date.now() - started).toBeGreaterThan(5_000);
    expect([got.exitCode, got.err]).toEqual([undefined, ""]);
    expect(got.out).toContain("  slow  answered · usage off: usage windows are off on this host (provider.usage_windows = false)");
    expect(slow.requests.map((r) => r.path)).toEqual(["/api/provider/status", "/api/config?view=browser"]);
  }, 20_000);

  it("--json prints the served body", async () => {
    const a = await host("a");
    const hub = await host("hub", { registry: [a.entry()] });
    await refreshDirect(a);
    const served = await (await fetch(`${hub.url}/api/provider/usage/hosts`)).json();
    const { out } = await run(["status", "--all-hosts", "--json"], hub);
    expect(JSON.parse(out)).toEqual(served);
  });

  it("--hosts narrows to those hosts (this host always included)", async () => {
    const a = await host("a");
    const b = await host("b");
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    const { out } = await run(["status", "--hosts", "b", "--json"], hub);
    expect((JSON.parse(out) as { hosts: Array<{ hostId: string }> }).hosts.map((h) => h.hostId)).toEqual(["local", "b"]);
    expect(a.requests).toEqual([]);
    const unknown = await run(["status", "--hosts", "nope"], hub);
    expect([unknown.exitCode, unknown.err]).toEqual([1, "unknown host ids: nope"]);
    const before = hub.requests.length;
    for (const empty of ["", " , ,"]) {
      const got = await run(["status", "--hosts", empty], hub);
      expect([got.exitCode, got.out, got.err]).toEqual([1, "", "--hosts needs at least one registered host id (comma-separated); for every host use --all-hosts"]);
    }
    expect(hub.requests.length).toBe(before);
  });

  it("switch off here: one line naming the key, exit 1", async () => {
    const hub = await host("hub", { usageWindows: false, registry: [] });
    const got = await run(["status", "--all-hosts"], hub);
    expect([got.exitCode, got.err]).toEqual([1, "Usage across hosts needs usage windows on this daemon. Turn them on with: rig config set provider.usage_windows true"]);
  });

  it("--refresh: a failed leg prints and sets exit 1, the view still prints with the failure beside the kept reading", async () => {
    const a = await host("a");
    const hub = await host("hub", { registry: [a.entry()] });
    await refreshDirect(a);
    a.codex = { fail: { reason: "rpc_error", detail: "the app-server said no" } };
    const got = await run(["status", "--all-hosts", "--refresh", "--provider", "codex"], hub);
    expect(got.exitCode).toBe(1);
    expect(got.err).toBe("refresh codex on a failed: rpc_error (the app-server said no)");
    expect(got.out).toContain("refresh failed at 2026-10-13T23:30:00.000Z: rpc_error (the app-server said no); last reading kept, marked old");
    expect(a.codexReads).toBe(2);
  });

  it("--refresh: a host where Claude doesn't apply is a note under a bare --refresh, a failure when named", async () => {
    const a = await host("a", { claude: { fail: { reason: "binary_not_found", detail: "no claude on PATH" } } });
    const hub = await host("hub", { registry: [a.entry()] });
    const bare = await run(["status", "--all-hosts", "--refresh"], hub);
    expect(bare.exitCode).toBeUndefined();
    expect(bare.err).toBe("note: refresh claude on a failed: binary_not_found (no claude on PATH); exit unaffected (name --provider claude to require it)");
    const named = await run(["status", "--all-hosts", "--refresh", "--provider", "claude"], hub);
    expect(named.exitCode).toBe(1);
  });

  it("no bearer, bearer variable or bearer file reaches the output", async () => {
    const a = await host("a");
    const b = await host("b");
    process.env["XHOST_CLI_BEARER"] = "cli-s3cret-bearer";
    try {
      const hub = await host("hub", {
        registry: [a.entry({ bearer_env: "XHOST_CLI_BEARER" } as never), b.entry({ bearer_file: "/nonexistent/xhost-cli-bearer" } as never)],
      });
      const text = [await run(["status", "--all-hosts"], hub), await run(["status", "--all-hosts", "--json"], hub), await run(["status", "--all-hosts", "--refresh"], hub)]
        .map((r) => r.out + r.err).join("\n");
      for (const secret of ["cli-s3cret-bearer", "XHOST_CLI_BEARER", "/nonexistent/xhost-cli-bearer", "bearer_file", "bearer_env"]) expect(text).not.toContain(secret);
      expect(text).toContain("b  auth-failed (the bearer configured for this host couldn't be resolved)");
    } finally {
      delete process.env["XHOST_CLI_BEARER"];
    }
  });
});
