import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonTimeoutError } from "../src/client.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { shellQuote } from "../src/cross-host-executor.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://selected-daemon:7433"),
}));

const id = "qitem-xh-missing";
const verbs = [
  ["show"], ["transitions"], ["claim"], ["unclaim"],
  ["update", "--note", "a note"],
  ["block", "--on", "external:dependency"],
  ["resolve", "--decision", "continue"],
  ["handoff", "--to", "peer@rig", "--summary", "Continue"],
  ["handoff-and-complete", "--to", "peer@rig", "--summary", "Continue"],
  ["fallback", "--destination", "peer@rig"],
];

function setup(response = { status: 404, data: { error: "qitem_not_found", message: "original detail" } },
  health: unknown = { status: 200, data: { selfHostId: "selected-host" } }) {
  const calls: Array<{ path: string; options?: unknown }> = [];
  const client = {
    baseUrl: "http://selected-daemon:7433",
    get: vi.fn(async (path: string, options?: unknown) => {
      calls.push({ path, options });
      if (path === "/healthz") {
        if (health instanceof Error) throw health;
        return health;
      }
      return response;
    }),
    post: vi.fn(async (path: string) => { calls.push({ path }); return response; }),
  };
  const deps: QueueDeps = {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: (baseUrl) => {
      expect(baseUrl).toBe(client.baseUrl);
      return client as unknown as ReturnType<QueueDeps["clientFactory"]>;
    },
  };
  return { deps, calls };
}

let output: string[];
beforeEach(() => {
  vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.exitCode = undefined;
});
afterEach(() => { process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

for (const json of [false, true]) {
  describe(json ? "JSON recovery" : "human recovery", () => {
    it.each(verbs)("%s names the selected host and a read-only recovery", async (verb, ...options) => {
      const { deps, calls } = setup();
      await queueCommand(deps).parseAsync(["node", "rig", verb, id, ...options, ...(json ? ["--json"] : [])]);
      expect(process.exitCode).toBe(1);
      const body = JSON.parse(output.join("\n"));
      expect(body.error).toBe("qitem_not_found");
      expect(body.message).toBe("original detail");
      expect(body.hint).toBe(`Queue item "${id}" was not found on daemon "selected-host".\n`
        + `If it came from another host, run rig host list; replace <daemon-url> with its registered daemon URL and run: OPENRIG_URL='<daemon-url>' rig queue show ${shellQuote(id)} --full --json`);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual({ path: "/healthz", options: { timeoutMs: 1_000 } });
      expect(calls.some(c => c.path.includes("/hosts"))).toBe(false);
    });
  });
}

it.each([
  new DaemonTimeoutError("identity read timed out"),
  { status: 200, data: {} },
  { status: 503, data: { selfHostId: "not-confirmed" } },
])("keeps recovery and exit1 when host identity is unavailable", async (health) => {
  const { deps } = setup(undefined, health);
  await queueCommand(deps).parseAsync(["node", "rig", "show", id, "--json"]);
  const body = JSON.parse(output.join("\n"));
  expect(body.error).toBe("qitem_not_found");
  expect(body.hint).toContain("selected daemon (host ID unavailable)");
  expect(body.hint).toContain("rig host list");
  expect(body.hint).not.toContain("not-confirmed");
  expect(process.exitCode).toBe(1);
});

it.each([200, 403, 500])("leaves other response/status %s unchanged without an identity request", async (status) => {
  const data = { error: "some_other_result", message: "unchanged" };
  const { deps, calls } = setup({ status, data });
  await queueCommand(deps).parseAsync(["node", "rig", "transitions", id, "--json"]);
  expect(JSON.parse(output.join("\n"))).toEqual(data);
  expect(process.exitCode).toBe(status >= 500 ? 2 : status >= 400 ? 1 : undefined);
  expect(calls).toHaveLength(1);
});

it("quotes the supplied ID without guessing a host or suggesting a write replay", async () => {
  const supplied = "remote' item";
  const { deps, calls } = setup();
  await queueCommand(deps).parseAsync(["node", "rig", "update", supplied, "--note", "keep", "--json"]);
  const body = JSON.parse(output.join("\n"));
  expect(body.hint).toContain(`rig queue show ${shellQuote(supplied)} --full --json`);
  expect(body.hint).not.toContain("queue update");
  expect(calls[0]?.path).toBe(`/api/queue/${encodeURIComponent(supplied)}/update`);
  expect(process.exitCode).toBe(1);
});
