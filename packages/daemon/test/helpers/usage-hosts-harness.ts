// Slice 01 — loopback hosts for usage across hosts. Each host is the daemon's real provider routes and config route
// over a real ProviderServiceImpl with real Codex and Claude usage windows, served over HTTP on 127.0.0.1 (ephemeral
// port). Only the native readers are scripted: they count their reads and never start a process, so no codex or
// claude binary, login or PATH is involved. Homes are temp folders under os.tmpdir() (usage-hosts-*), removed on
// close. A hub is a host given a host registry naming the others.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { providerRoutes, type ProviderRoutesOptions } from "../../src/routes/provider.js";
import { configRoutes } from "../../src/routes/config.js";
import { ProviderServiceImpl } from "../../src/domain/provider/provider-service-impl.js";
import { CodexUsageWindows } from "../../src/domain/provider/codex-usage-windows.js";
import { ClaudeUsageWindows, type ClaudeWindowSample } from "../../src/domain/provider/claude-usage-windows.js";
import { SettingsStore } from "../../src/domain/user-settings/settings-store.js";
import { loadHostRegistry, type HostEntry, type HostRegistryLoadResult } from "../../src/domain/hosts/hosts-registry-reader.js";
import type { ProviderService } from "../../src/domain/provider/provider-service.js";
import type { CodexUsageReadOutcome } from "../../src/domain/provider/codex-usage-reader.js";
import type { UsageReadOutcome } from "../../src/domain/provider/usage-windows.js";
import type { ClaudeAuthAnswer } from "../../src/domain/provider/claude-auth-status-reader.js";
import { createFullTestDb } from "./test-app.js";

export interface CodexPlan {
  accountId?: string | null;
  workspaceId?: string | null;
  email?: string | null;
  limitId?: string;
  primaryUsed?: number;
  secondaryUsed?: number;
  /** ISO time; the weekly (secondary) window's reset. */
  secondaryResetsAt?: string;
  fail?: { reason: "timeout" | "rpc_error"; detail: string };
  /** Answer after this long (real time). */
  delayMs?: number;
  /** Never answer until the host closes. */
  hang?: boolean;
}

export interface ClaudePlan {
  orgId?: string | null;
  email?: string | null;
  fail?: { reason: "binary_not_found" | "not_logged_in" | "auth_status_failed"; detail: string };
}

export type HostShape =
  /** Today's daemon. */
  | "current"
  /** A daemon with no /api/provider/status route at all. */
  | "no-provider-routes"
  /** A daemon that serves status without usage windows and doesn't know the provider.usage_windows setting. */
  | "predates-usage-windows";

export interface UsageHostOptions {
  usageWindows?: boolean;
  codex?: CodexPlan;
  claude?: ClaudePlan;
  samples?: ClaudeWindowSample[];
  shape?: HostShape;
  /** For a hub: the registry entries it reads (urls of other hosts), or a hosts.yaml path read by the real reader. */
  registry?: HostEntry[] | { path: string };
  routes?: ProviderRoutesOptions;
  now?: () => string;
  /** Answer GET /api/provider/status and /api/config only after this long (real time). */
  slowReadMs?: number;
}

const toEpoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
export const DEFAULT_RESET = "2026-10-20T00:00:00.000Z";

export class UsageHost {
  readonly requests: Array<{ method: string; path: string }> = [];
  codexReads = 0;
  claudeReads = 0;
  codex: CodexPlan;
  claude: ClaudePlan;
  samples: ClaudeWindowSample[];
  readonly settings: SettingsStore;
  private readonly hangs: Array<() => void> = [];
  private server!: ServerType;
  url = "";

  private constructor(readonly id: string, readonly home: string, private readonly opts: UsageHostOptions) {
    this.codex = opts.codex ?? {};
    this.claude = opts.claude ?? {};
    this.samples = opts.samples ?? [];
    this.settings = new SettingsStore(path.join(home, "config.json"));
    this.settings.set("provider.usage_windows", String(opts.usageWindows ?? true));
  }

  static async start(id: string, opts: UsageHostOptions = {}): Promise<UsageHost> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `usage-hosts-${id}-`));
    const host = new UsageHost(id, home, opts);
    await host.listen();
    return host;
  }

  /** The registry entry another daemon would have for this host. */
  entry(extra: Partial<HostEntry> = {}): HostEntry {
    return { id: this.id, transport: "http", url: this.url, ...extra } as HostEntry;
  }

  private now(): string {
    return (this.opts.now ?? (() => new Date().toISOString()))();
  }

  private async readCodex(): Promise<CodexUsageReadOutcome> {
    this.codexReads += 1;
    const plan = this.codex;
    if (plan.hang) await new Promise<void>((resolve) => this.hangs.push(resolve));
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    if (plan.fail) return { ok: false, at: this.now(), reason: plan.fail.reason, detail: plan.fail.detail };
    const limitId = plan.limitId ?? "codex";
    return {
      ok: true,
      observedAt: this.now(),
      account: {
        account: { email: plan.email === undefined ? "dev@example.com" : plan.email, planType: "team" },
        ...(plan.workspaceId ? { workspaceRouting: { chatgptAccountId: plan.workspaceId } } : {}),
      },
      rateLimits: {
        ...(plan.accountId === null ? {} : { accountId: plan.accountId ?? "acct-1" }),
        rateLimits: {
          limitId,
          primary: { usedPercent: plan.primaryUsed ?? 10, windowDurationMins: 300, resetsAt: toEpoch("2026-10-14T05:00:00.000Z") },
          secondary: { usedPercent: plan.secondaryUsed ?? 40, windowDurationMins: 10080, resetsAt: toEpoch(plan.secondaryResetsAt ?? DEFAULT_RESET) },
        },
      },
    };
  }

  private async readClaude(): Promise<UsageReadOutcome<ClaudeAuthAnswer>> {
    this.claudeReads += 1;
    const plan = this.claude;
    if (plan.fail) return { ok: false, at: this.now(), reason: plan.fail.reason, detail: plan.fail.detail };
    return {
      ok: true,
      observedAt: this.now(),
      auth: {
        loggedIn: true,
        authMethod: "claude.ai",
        email: plan.email === undefined ? "dev@example.com" : plan.email,
        orgId: plan.orgId === undefined ? "org-1" : plan.orgId,
        orgName: "Example",
        subscriptionType: "max",
      },
    };
  }

  private service(): ProviderService {
    const now = () => this.now();
    const codexHome = path.join(this.home, "codex");
    fs.mkdirSync(codexHome, { recursive: true });
    return new ProviderServiceImpl({
      db: createFullTestDb(),
      listRigs: () => [],
      env: { HOME: this.home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      now,
      usageWindows: {
        enabled: () => this.settings.resolveOne("provider.usage_windows").value === true,
        windows: new CodexUsageWindows({ read: () => this.readCodex(), now }),
        claude: new ClaudeUsageWindows({ readIdentity: () => this.readClaude(), listSamples: () => this.samples, now }),
      },
    });
  }

  private app(): Hono {
    const app = new Hono();
    const shape = this.opts.shape ?? "current";
    const svc = this.service();
    const registry = this.opts.registry;
    app.use("*", async (c, next) => {
      this.requests.push({ method: c.req.method, path: `${c.req.path}${new URL(c.req.url).search}` });
      const slow = this.opts.slowReadMs;
      if (slow && c.req.method === "GET" && (c.req.path === "/api/provider/status" || c.req.path === "/api/config")) {
        await new Promise((r) => setTimeout(r, slow));
      }
      c.set("providerService" as never, svc as never);
      c.set("settingsStore" as never, this.settings as never);
      if (registry) {
        c.set("hostRegistryLoader" as never, ((): HostRegistryLoadResult =>
          Array.isArray(registry) ? { ok: true, registry: { hosts: registry } } : loadHostRegistry(registry.path)) as never);
      }
      await next();
    });
    if (shape === "predates-usage-windows") {
      // An older daemon: status without usage windows, and settings that don't include the key.
      app.get("/api/provider/status", async (c) => {
        const { usage: _u, seatAccounts: _s, ...rest } = await svc.getReadModel();
        return c.json(rest);
      });
      app.get("/api/config", (c) => c.json({ entries: [{ key: "agents.default", value: "x", source: "default" }] }));
      return app;
    }
    app.route("/api/config", configRoutes({ home: this.home }));
    if (shape === "current") app.route("/api/provider", providerRoutes(this.opts.routes));
    return app;
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = serve({ fetch: this.app().fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) => {
        this.url = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const release of this.hangs.splice(0)) release();
    const server = this.server as unknown as { close(cb: () => void): void; closeAllConnections?: () => void };
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.home, { recursive: true, force: true });
  }

  /** The requests this host received for these path prefixes. */
  seen(prefix: string): Array<{ method: string; path: string }> {
    return this.requests.filter((r) => r.path.startsWith(prefix));
  }
}

/** A loopback port that refuses connections (bound, then closed). */
export async function closedPortUrl(): Promise<string> {
  const host = await UsageHost.start("closed");
  const url = host.url;
  await host.close();
  return url;
}
