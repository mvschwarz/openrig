import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient, SENDER_IDENTITY_HEADER } from "../src/client.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "host-local" }));

const url = "http://127.0.0.1:17001";

function recordingFetch(selfHostId: string): { fetchImpl: typeof fetch; urls: string[]; sessions: string[] } {
  const urls: string[] = [];
  const sessions: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const session = (init?.headers as Record<string, string> | undefined)?.[SENDER_IDENTITY_HEADER];
    if (session) sessions.push(session);
    const body = url.endsWith("/healthz") ? { selfHostId } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, urls, sessions };
}

/** The deps of a status probe on `OPENRIG_URL`: only its /healthz answer matters. */
function statusDeps(fetch: LifecycleDeps["fetch"]): LifecycleDeps {
  const unused = (): never => { throw new Error("not used by a status probe"); };
  return {
    fetch,
    sleep: async () => {},
    spawn: unused,
    kill: unused,
    readFile: () => null,
    writeFile: unused,
    removeFile: unused,
    exists: () => false,
    mkdirp: unused,
    openForAppend: unused,
    isProcessAlive: () => false,
  };
}

const answering = (body: unknown): LifecycleDeps["fetch"] => async () => ({ ok: true, json: async () => body });

describe("a seat's locality proof on a direct endpoint", () => {
  beforeEach(() => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "qa@rig");
    vi.stubEnv("OPENRIG_URL", url);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the bare session once the endpoint's /healthz answers this host's id", async () => {
    const seen = recordingFetch("host-local");
    await new DaemonClient(url, { fetchImpl: seen.fetchImpl }).get("/api/queue/list");
    expect(seen.urls).toEqual([`${url}/healthz`, `${url}/api/queue/list`]);
    expect(seen.sessions).toEqual(["qa@rig"]);
  });

  it("carries this host's origin when the endpoint answers another instance's id", async () => {
    const seen = recordingFetch("host-forwarded");
    await new DaemonClient(url, { fetchImpl: seen.fetchImpl }).get("/api/queue/list");
    expect(seen.urls).toEqual([`${url}/healthz`, `${url}/api/queue/list`]);
    expect(seen.sessions).toEqual(["qa@rig@host-local"]);
  });

  it("asks at each new client's first request, whatever an earlier status probe of the endpoint answered", async () => {
    // The probe answers this host's id; the endpoint leads to another instance by the time the client asks.
    await getDaemonStatus(statusDeps(answering({ selfHostId: "host-local" })));
    const seen = recordingFetch("host-forwarded");
    await new DaemonClient(url, { fetchImpl: seen.fetchImpl }).get("/api/queue/list");
    expect(seen.urls).toEqual([`${url}/healthz`, `${url}/api/queue/list`]);
    expect(seen.sessions).toEqual(["qa@rig@host-local"]);
  });

  it("proves locality through a queue command's own client, not its status probe", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen = recordingFetch("host-forwarded");
    const bases: string[] = [];
    const deps: QueueDeps = {
      lifecycleDeps: statusDeps(answering({ selfHostId: "host-local" })),
      clientFactory: (base) => { bases.push(base); return new DaemonClient(base, { fetchImpl: seen.fetchImpl }); },
    };
    await new Command().addCommand(queueCommand(deps)).parseAsync(["node", "rig", "queue", "list", "--json"]);
    expect(bases).toEqual([url]);
    expect(seen.urls[0]).toBe(`${url}/healthz`);
    expect(new Set(seen.sessions)).toEqual(new Set(["qa@rig@host-local"]));
  });
});
