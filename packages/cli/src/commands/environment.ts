import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonClient } from "../client.js";
import { getDaemonPath, getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { getOpenRigHome } from "../openrig-compat.js";
import { addGrant, grantFor, mcpTokenFilePath, readGrants } from "../mcp-http.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface EnvironmentCommandDeps extends StatusDeps { home?: string; assets?: string }
interface WorkConnection { version: 1; mcpUrl: string; seat: string; rig: string; grantName: string; artifactRoot: string; token: string }
const managedId = (id: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw new Error("A short binding identifier is required");
  return id;
};
function preserveWrite(file: string, data: string | Buffer): void {
  mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
  if (existsSync(file) || (() => { try { return lstatSync(file).isSymbolicLink(); } catch { return false; } })()) {
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || !readFileSync(file).equals(Buffer.from(data)))
      throw new Error(`An existing file is preserved: ${file}`);
    return;
  }
  writeFileSync(file, data, { flag: "wx", mode: 0o600 });
}
function connectionRef(home: string, bindingId: string): string { return join(home, "environment-secrets", managedId(bindingId), "work.json"); }
function readConnection(file: string): WorkConnection {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o077)) throw new Error("The managed work connection must be a private regular file");
  const value = JSON.parse(readFileSync(file, "utf8")) as WorkConnection;
  if (value.version !== 1 || typeof value.token !== "string" || !value.token || typeof value.mcpUrl !== "string") throw new Error("The work connection is invalid");
  return value;
}
async function prepareWork(home: string, input: { bindingId: string; seat: string; rig: string; mcpUrl: string; artifactRoot: string }): Promise<string> {
  const url = new URL(input.mcpUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/mcp"))
    throw new Error("The work endpoint must be an HTTP(S) MCP URL without embedded credentials");
  if (!/^[^\s@]+@[^\s@]+$/.test(input.seat) || !input.rig) throw new Error("A canonical seat and its rig are required");
  const file = connectionRef(home, input.bindingId), grantName = `environment-${input.bindingId}`;
  if (existsSync(file)) {
    const prior = readConnection(file), grants = readGrants(mcpTokenFilePath(home)) ?? [];
    const grant = grantFor(grants, prior.token);
    if (!grant || grant.name !== grantName || prior.seat !== input.seat || prior.rig !== input.rig || prior.mcpUrl !== url.toString()
      || prior.artifactRoot !== resolve(input.artifactRoot) || grant.seat !== input.seat || grant.owner || grant.workspace
      || grant.rigs.length !== 1 || grant.rigs[0] !== input.rig || grant.roots.length !== 0) throw new Error("The existing managed work connection changed or was revoked; preserve it and reconcile before setup");
    return file;
  }
  const token = await addGrant(mcpTokenFilePath(home), { name: grantName, seat: input.seat, rigs: [input.rig], roots: [], workspace: false, owner: false });
  const data: WorkConnection = { version: 1, mcpUrl: url.toString(), seat: input.seat, rig: input.rig, grantName, artifactRoot: resolve(input.artifactRoot), token };
  preserveWrite(file, JSON.stringify(data) + "\n");
  return file;
}

export function environmentCommand(override?: EnvironmentCommandDeps): Command {
  const cmd = new Command("environment").description("Explicit OpenShell execution placement and verified artifact return; not rig env (services)");
  const deps = (): EnvironmentCommandDeps => override ?? { lifecycleDeps: realDeps(), clientFactory: url => new DaemonClient(url) };
  const client = async () => { const d = deps(), status = await getDaemonStatus(d.lifecycleDeps); if (!daemonStatusGuard(status)) throw new Error("A reachable daemon is required"); return d.clientFactory(getDaemonUrl(status)); };
  const home = () => deps().home ?? getOpenRigHome();
  const report = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const action = (fn: (...args: any[]) => Promise<void>) => async (...args: any[]) => { try { await fn(...args); } catch (error) { console.error((error as Error).message); process.exitCode = 1; } };
  const checked = <T extends Record<string, any>>(res: { status: number; data: T }): T => { if (res.status >= 400) throw new Error(res.data?.error ?? `Environment request failed (${res.status})`); return res.data; };

  cmd.command("setup").description("Inspect the pinned vendor CLI and install the maintained example without overwriting another preset")
    .requiredOption("--directory <path>", "New or matching example directory")
    .option("--binding <id>", "Prepare this binding's normal scoped MCP work connection")
    .option("--seat <address>").option("--rig <name>").option("--mcp-url <url>", "Existing authenticated MCP HTTP listener, as reached by the guest")
    .option("--guest-base-url <origin>", "Guest-only activity listener origin (not the main daemon API); required with work authority")
    .option("--artifact-root <path>", "Host returned-artifact root, bound to this environment")
    .option("--json", "JSON receipt; never credential values")
    .action(action(async (opts: { directory: string; binding?: string; seat?: string; rig?: string; mcpUrl?: string; guestBaseUrl?: string; artifactRoot?: string }) => {
      const binary = await promisify(execFile)("openshell", ["--version"], { timeout: 10_000, maxBuffer: 4096 });
      if (!/\b0\.1\.6\b/.test(binary.stdout)) throw new Error("This reference requires OpenShell 0.1.6; no compute was prepared");
      const root = resolve(opts.directory), assets = deps().assets ?? join(getDaemonPath(), "assets", "openshell");
      const names = ["guest.py", "Dockerfile", "policy.yaml", "rig.yaml", "agents/worker/agent.yaml", "agents/worker/role.md", "agents/coordinator/agent.yaml", "agents/coordinator/role.md", "README.md", "driver-v1.schema.json", "claude-code-provider.yaml"];
      for (const name of names) {
        let data = readFileSync(join(assets, name));
        if (name === "policy.yaml" && opts.mcpUrl && opts.guestBaseUrl) {
          const mcp = new URL(opts.mcpUrl), activity = new URL(opts.guestBaseUrl);
          if (![mcp, activity].every(url => ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
            || activity.pathname !== "/") throw new Error("Explicit guest endpoints without embedded credentials are required");
          const mainPort = Number(process.env.OPENRIG_PORT ?? "7433");
          const ports = [mcp, activity].map(url => Number(url.port || (url.protocol === "https:" ? 443 : 80)));
          if (ports.includes(mainPort) || ports[0] === ports[1]) throw new Error("Select separate MCP and guest-only activity ports, never the daemon main port");
          const policy = parseYaml(data.toString("utf8"));
          for (const [name, url] of [["openrig_mcp", mcp], ["openrig_activity", activity]] as const) {
            policy.network_policies[name].endpoints[0].host = url.hostname;
            policy.network_policies[name].endpoints[0].port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
          }
          data = Buffer.from(stringifyYaml(policy));
        }
        preserveWrite(join(root, name), data);
      }
      preserveWrite(join(home(), "community-harnesses", "openshell-claude.yaml"), readFileSync(join(assets, "preset.yaml")));
      let ref: string | undefined;
      if (opts.binding || opts.seat || opts.rig || opts.mcpUrl) {
        if (!opts.binding || !opts.seat || !opts.rig || !opts.mcpUrl || !opts.guestBaseUrl) throw new Error("Preparing work authority needs --binding, --seat, --rig, --mcp-url and --guest-base-url together");
        ref = await prepareWork(home(), { bindingId: opts.binding, seat: opts.seat, rig: opts.rig, mcpUrl: opts.mcpUrl, artifactRoot: resolve(opts.artifactRoot ?? join(root, "artifacts")) });
      }
      report({ version: 1, driver: "openshell", vendorVersion: "0.1.6", directory: root,
        ...(ref ? { workConnectionRef: ref } : {}), effect: "reference and preset installed; no environment or native process created" });
    }));

  for (const verb of ["create", "attach"] as const) {
    const sub = cmd.command(verb).argument("<binding>").description(verb === "create" ? "Journal intent, then explicitly create one owned sandbox; retries reconcile the same operation" : "Verify and bind an exact existing resource as an attached consumer")
      .requiredOption("--seat <address>").option("--node <id>", "Existing node ID; otherwise claimed by the exact named seat on its first launch")
      .requiredOption("--gateway <ref>").requiredOption("--workspace <ref>").requiredOption("--name <name>")
      .requiredOption("--image <digest>").requiredOption("--provider <ref>").requiredOption("--policy <path>")
      .requiredOption("--guest-base-url <origin>", "Guest-reachable daemon origin for the single P6 activity grant")
      .option("--operation <id>", "Stable effect identity (default verb plus binding ID)").option("--json");
    if (verb === "attach") sub.requiredOption("--resource-id <id>", "Immutable live resource ID").option("--fingerprint <value>", "Expected host-key fingerprint");
    sub.action(action(async (binding: string, opts: Record<string, string>) => {
      managedId(binding); const ref = connectionRef(home(), binding), work = readConnection(ref);
      if (work.seat !== opts.seat) throw new Error("The managed work connection belongs to another seat; no provider operation was requested");
      const body = { version: 1, bindingId: binding, operationId: opts.operation ?? `${verb}-${binding}`, nodeId: opts.node, seat: opts.seat,
        baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: opts.guestBaseUrl, coordinationRef: ref, artifactRoot: work.artifactRoot,
        placement: { gateway: opts.gateway, workspace: opts.workspace, name: opts.name, image: opts.image, provider: opts.provider, policy: realpathSync(opts.policy!) },
        ...(verb === "attach" ? { resourceId: opts.resourceId, fingerprint: opts.fingerprint } : {}) };
      const res = await (await client()).post<Record<string, any>>(`/api/environments/${verb}`, body, { timeoutMs: 120_000 });
      report({ ...checked(res), operationId: body.operationId, effect: res.status === 202 ? "unconfirmed; reconcile this same operation" : "binding-confirmed; native launch not requested" });
    }));
  }
  cmd.command("inspect").description("Read stored binding receipts or inspect the exact live resource").argument("<binding>").option("--live", "Observe the exact provider resource; unavailable is not absence").option("--json")
    .action(action(async (binding: string, opts: { live?: boolean }) => report(checked(await (await client()).get<Record<string, any>>(`/api/environments/${encodeURIComponent(binding)}${opts.live ? "?live=true" : ""}`)))));
  cmd.command("connect").argument("<binding>").requiredOption("--generation <id>").description("Open only the bound execution's viewer; closing it does not prove native or compute stopped")
    .action(action(async (id: string, opts: { generation: string }) => {
      const c = await client(), b = checked(await c.get<Record<string, any>>(`/api/environments/${encodeURIComponent(id)}?live=true`));
      checked(await c.post<Record<string, any>>(`/api/environments/${encodeURIComponent(id)}/validate`, { generation: opts.generation }));
      const args = ["--gateway", b.placement.gateway, "--workspace", b.placement.workspace, "sandbox", "connect", b.placement.name];
      await new Promise<void>((resolveExit, reject) => {
        const child = spawn("openshell", args, { stdio: "inherit" });
        child.once("error", reject); child.once("exit", code => code === 0 ? resolveExit() : reject(new Error(`The environment viewer exited ${code}; native and compute state require inspection`)));
      });
    }));
  cmd.command("export").argument("<binding>").requiredOption("--request <path>", "Versioned artifact request JSON with operation/task/generation/path/hash/bytes/schema/context")
    .option("--json").description("Transfer actual bytes through the existing authenticated MCP work route, never an activity token")
    .action(action(async (binding: string, opts: { request: string }) => {
      const work = readConnection(connectionRef(home(), binding)), request = JSON.parse(readFileSync(opts.request, "utf8"));
      const transport = new StreamableHTTPClientTransport(new URL(work.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${work.token}` } } });
      const mcp = new Client({ name: "openrig-environment-export", version: "1" });
      try {
        await mcp.connect(transport);
        const result = await mcp.callTool({ name: "rig_environment_export", arguments: { ...request, bindingId: binding } });
        if (result.isError) throw new Error((result.content as Array<{ text?: string }>).map(c => c.text ?? "").join("\n"));
        report(result.structuredContent ?? result.content);
      } finally { await mcp.close(); }
    }));
  cmd.command("checkpoint").argument("<binding>").requiredOption("--generation <id>", "Selected current execution generation")
    .requiredOption("--operation <id>", "Stable private checkpoint identity").option("--json")
    .description("Capture exact private native history and verified prior artifact references while the provider remains accessible")
    .action(action(async (id: string, opts: { generation: string; operation: string }) => report(checked(await (await client()).post<Record<string, any>>(`/api/environments/${encodeURIComponent(id)}/checkpoint`, { operationId: opts.operation, generation: opts.generation }, { timeoutMs: 120_000 })))));
  cmd.command("recreate").argument("<binding>").requiredOption("--request <path>", "JSON with operationId, predecessor generation, checkpointId, exact resumeType/resumeToken and same-host placement")
    .option("--json").description("Explicitly create successor compute only after exact predecessor cleanup and retained state verification; native launch remains normal rig restore")
    .action(action(async (id: string, opts: { request: string }) => report(checked(await (await client()).post<Record<string, any>>(`/api/environments/${encodeURIComponent(id)}/recreate`, JSON.parse(readFileSync(opts.request, "utf8")), { timeoutMs: 120_000 })))));
  cmd.command("completion").argument("<binding>").requiredOption("--request <path>", "JSON selecting operationId, taskId, generation, exportOperationId and stop-native or stop-compute")
    .option("--json").description("Select finite completion for one task, generation and required verified export; persistent defaults stay unchanged")
    .action(action(async (id: string, opts: { request: string }) => report(checked(await (await client()).post<Record<string, any>>(`/api/environments/${encodeURIComponent(id)}/completion`, JSON.parse(readFileSync(opts.request, "utf8")))))));
  cmd.command("effect").argument("<binding>").requiredOption("--effect <name>", "close-viewer, stop-native, stop-compute or delete-owned")
    .requiredOption("--generation <id>", "Selected execution generation").requiredOption("--operation <id>", "Stable effect identity; retries reconcile without another provider mutation")
    .option("--engine-socket <path>", "Owned local rootless Podman socket, required to capture dependent identities before delete-owned").option("--json")
    .description("Execute one selected effect and return its separate observed outcome; attached native/storage/compute are preserved")
    .action(action(async (id: string, opts: { effect: string; generation: string; operation: string; engineSocket?: string }) => report(checked(await (await client()).post<Record<string, any>>(`/api/environments/${encodeURIComponent(id)}/effect`, { effect: opts.effect, generation: opts.generation, operationId: opts.operation, engineSocket: opts.engineSocket }, { timeoutMs: 120_000 })))));
  cmd.addHelpText("after", "\nStart with rig environment setup --help. Create/attach are explicit effects; a 202 is unconfirmed. The first native start remains rig up with the installed openshell-claude preset. Checkpoint before stop, select effects explicitly, and recreate compute before exact normal rig restore. No unknown effect permits fresh-native fallback.\n");
  return cmd;
}
