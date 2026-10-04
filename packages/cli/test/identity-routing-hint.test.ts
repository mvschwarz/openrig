import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DaemonClient, DaemonTimeoutError } from "../src/client.js";
import { whoamiCommand, type WhoamiDeps } from "../src/commands/whoami.js";
import { healthCommand } from "../src/commands/health.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://selected-daemon:7433"),
}));

const original = { error: "Session or node 'missing-node' not found in any managed rig. Check available sessions with: rig ps --nodes" };
const hint = 'Reached daemon "selected-host" at "http://selected-daemon:7433/". '
  + "Seat routing may point to a different OpenRig install. "
  + "Compare OPENRIG_URL and OPENRIG_HOME in this shell with the daemon that launched this seat.";
let out: string[], err: string[];

beforeEach(() => {
  vi.stubEnv("OPENRIG_NODE_ID", "missing-node");
  vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
  vi.stubEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", "must-not-print-token");
  out = []; err = [];
  vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => err.push(args.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

function setup(status = 404, data: Record<string, unknown> = original,
  identity: unknown = { status: 200, data: { selfHostId: "selected-host" } },
  baseUrl = "http://selected-daemon:7433") {
  const get = vi.fn(async (path: string, _options?: unknown) => {
    if (path === "/healthz") {
      if (identity instanceof Error) throw identity;
      return identity;
    }
    return { status, data };
  });
  const deps: WhoamiDeps = {
    lifecycleDeps: {} as WhoamiDeps["lifecycleDeps"],
    clientFactory: () => ({ baseUrl, get }) as unknown as DaemonClient,
  };
  return { deps, get };
}

async function run(command: "whoami" | "health", deps: WhoamiDeps, args: string[]) {
  const cmd = command === "whoami" ? whoamiCommand(deps)
    : healthCommand({ ...deps, resolveIdentity: () => ({ nodeId: "missing-node" }) });
  await cmd.parseAsync(["node", "rig", ...args]);
}

it.each([{ args: [] }, { args: ["--json"] }, { args: ["--json", "--full"] }])("whoami unknown node adds routing guidance (%j)", async ({ args }) => {
  const { deps, get } = setup();
  await run("whoami", deps, args);
  if (args.includes("--json")) expect(JSON.parse(out.join("\n"))).toEqual({ ...original, hint });
  else expect(err).toEqual([original.error, hint]);
  expect(process.exitCode).toBe(1);
  expect(get.mock.calls).toEqual([
    [`/api/whoami?nodeId=missing-node${args.includes("--full") ? "" : "&compact=1"}`],
    ["/healthz", { timeoutMs: 1_000 }],
  ]);
  expect(original).not.toHaveProperty("hint");
  expect([...out, ...err].join("\n")).not.toContain("must-not-print-token");
});

it("whoami unknown session uses the same hint without switching to a node lookup", async () => {
  vi.stubEnv("OPENRIG_NODE_ID", "");
  const { deps, get } = setup();
  await run("whoami", deps, ["--json"]);
  expect(JSON.parse(out.join("\n"))).toEqual({ ...original, hint });
  expect(get.mock.calls[0]).toEqual(["/api/whoami?sessionName=seat%40rig&compact=1"]);
  expect(get).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
});

it.each([false, true])("health self keeps its error envelope and shows routing guidance (json=%s)", async (json) => {
  const { deps, get } = setup();
  await run("health", deps, json ? ["--json"] : []);
  if (json) expect(JSON.parse(out.join("\n"))).toEqual({
    schema: "openrig.health-error/v0alpha1", error: "health_identity_unavailable",
    message: "The daemon could not resolve the current seat identity.",
    nextInspection: "rig whoami --json", details: original, hint,
  });
  else expect(err).toEqual([
    "Error: The daemon could not resolve the current seat identity.",
    "  Next inspection: rig whoami --json", `  ${hint}`,
  ]);
  expect(process.exitCode).toBe(1);
  expect(get.mock.calls).toEqual([
    ["/api/whoami?nodeId=missing-node&compact=1"], ["/healthz", { timeoutMs: 1_000 }],
  ]);
});

it.each([
  new DaemonTimeoutError("private transport detail"),
  { status: 200, data: {} },
  { status: 503, data: { selfHostId: "unconfirmed-host" } },
])("identity enrichment failure keeps the original error and useful routing advice", async (identity) => {
  const { deps, get } = setup(404, original, identity);
  await run("whoami", deps, ["--json"]);
  const body = JSON.parse(out.join("\n"));
  expect(body.error).toBe(original.error);
  expect(body.hint).toBe(hint.replace('daemon "selected-host"', "daemon (host ID unavailable)"));
  expect(process.exitCode).toBe(1);
  expect(get).toHaveBeenCalledTimes(2);
});

it.each([400, 401, 409, 500])("other identity errors (%s) stay unchanged, with no extra lookup", async (status) => {
  for (const command of ["whoami", "health"] as const) {
    const { deps, get } = setup(status, { error: "unchanged" });
    out = []; err = [];
    await run(command, deps, ["--json"]);
    const body = JSON.parse(out.join("\n"));
    expect(body).not.toHaveProperty("hint");
    if (command === "whoami") expect(body).toEqual({ error: "unchanged" });
    else expect(body.details).toEqual({ error: "unchanged" });
    expect(process.exitCode).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
  }
});

it("full identity success remains byte-equivalent and makes no enrichment read", async () => {
  const data = { identity: { nodeId: "known" }, peers: [], extra: "unchanged" };
  const { deps, get } = setup(200, data);
  await run("whoami", deps, ["--full", "--json"]);
  expect(out).toEqual([JSON.stringify(data, null, 2)]);
  expect(get).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBeUndefined();
});

it("omits URL credentials, query and fragment from the additive hint", async () => {
  const { deps } = setup(404, original, undefined,
    "https://private-user:private-password@selected-daemon:7433/proxy?token=private-query#private-fragment");
  await run("whoami", deps, ["--json"]);
  const body = JSON.parse(out.join("\n"));
  expect(body.hint).toBe(hint.replace("http://selected-daemon:7433/", "https://selected-daemon:7433/proxy"));
  expect(body.error).toBe(original.error);
});

it("bounds a hanging identity response with the actual DaemonClient timeout", async () => {
  vi.useFakeTimers();
  let started!: () => void;
  const healthStarted = new Promise<void>((resolve) => { started = resolve; });
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/healthz")) return new Response(JSON.stringify(original), { status: 404 });
    started();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  const client = new DaemonClient("http://selected-daemon:7433", { fetchImpl: fetchImpl as typeof fetch });
  const { deps } = setup();
  deps.clientFactory = () => client;
  const pending = run("whoami", deps, ["--json"]);
  await healthStarted;
  await vi.advanceTimersByTimeAsync(1_001);
  await pending;
  const body = JSON.parse(out.join("\n"));
  expect(body.error).toBe(original.error);
  expect(body.hint).toContain("host ID unavailable");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
});
