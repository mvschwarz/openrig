// #3315 — the CLI shows a daemon that is up while its tmux server does not answer as exactly that: `healthy` stays
// true, and `rig status`, `rig ps` and `rig doctor` say the terminals can't be reached, from the daemon's healthz.
import { describe, expect, it, vi } from "vitest";
import { getDaemonStatus, readTerminalsEvidence, terminalsDegradedLine, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";

const gone = {
  state: "degraded",
  servers: [{ socket: "/run/user/1000/openrig.sock", state: "unreachable", since: "2026-11-15T15:59:58.000Z",
    cause: "no server running on /run/user/1000/openrig.sock", lastCheckedAt: "2026-11-15T16:30:00.000Z", transitions: 1 }],
};
const reachable = {
  state: "ok",
  servers: [{ socket: "/run/user/1000/openrig.sock", state: "reachable", since: "2026-11-15T10:00:00.000Z",
    lastCheckedAt: "2026-11-15T16:30:00.000Z", transitions: 0 }],
};

function lifecycle(healthz: unknown): LifecycleDeps {
  return {
    spawn: vi.fn() as unknown as LifecycleDeps["spawn"],
    fetch: vi.fn(async () => ({ ok: true, json: async () => healthz })) as unknown as LifecycleDeps["fetch"],
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 0),
    isProcessAlive: vi.fn(() => false),
    sleep: async () => {},
  };
}

describe("rig status: the daemon up and its terminals reachable are two facts", () => {
  it("keeps the daemon healthy and carries the unreachable server", async () => {
    process.env.OPENRIG_URL = "http://127.0.0.1:7433";
    try {
      const status = await getDaemonStatus(lifecycle({ status: "ok", pid: 1, terminals: gone }));
      expect(status).toMatchObject({ state: "running", healthy: true });
      expect(status.terminals?.state).toBe("degraded");
      expect(terminalsDegradedLine(status.terminals)).toBe("Terminals: the tmux server on /run/user/1000/openrig.sock has not answered "
        + "since 2026-11-15T15:59:58.000Z (no server running on /run/user/1000/openrig.sock). The daemon is up; automatic delivery "
        + "through this tmux server is currently held, and the daemon does not restart it.");
    } finally {
      delete process.env.OPENRIG_URL;
    }
  });

  it("says nothing extra while the server answers, or when the daemon predates the field", async () => {
    process.env.OPENRIG_URL = "http://127.0.0.1:7433";
    try {
      expect(terminalsDegradedLine((await getDaemonStatus(lifecycle({ status: "ok", terminals: reachable }))).terminals)).toBeNull();
      const legacy = await getDaemonStatus(lifecycle({ status: "ok", pid: 1 }));
      expect(legacy.terminals).toBeUndefined();
      expect(terminalsDegradedLine(legacy.terminals)).toBeNull();
    } finally {
      delete process.env.OPENRIG_URL;
    }
  });

  it("keeps only a terminals field in the shape the daemon writes", () => {
    expect(readTerminalsEvidence({ state: "broken", servers: [] })).toBeUndefined();
    expect(readTerminalsEvidence({ state: "ok" })).toBeUndefined();
    expect(readTerminalsEvidence("degraded")).toBeUndefined();
    expect(readTerminalsEvidence({ state: "degraded", servers: [{ socket: 1 }, { socket: "/s", state: "unreachable", since: "t" }] }))
      .toEqual({ state: "degraded", servers: [{ socket: "/s", state: "unreachable", since: "t" }] });
  });
});

describe("rig doctor: does the running daemon reach its tmux server?", () => {
  const doctor = (healthz: unknown): DoctorDeps => ({
    exists: () => true,
    baseDir: "/install/cli/dist",
    readFile: () => null,
    exec: (cmd: string) => {
      if (cmd.startsWith("cmux")) throw new Error("cmux: not found"); // no cmux check, which reads healthz on its own
      return cmd === "tmux -V" ? "tmux 3.8\n" : "";
    },
    checkPort: async () => healthz === undefined, // a daemon holds the port when it answers healthz
    configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/o.sqlite" },
      transcripts: { enabled: false, path: "/tmp/t" } }) },
    platform: "linux",
    mkdirp: () => {},
    checkWritable: () => {},
    fetch: (async (url: string) => (url.endsWith("/healthz") && healthz !== undefined
      ? ({ ok: true, json: async () => healthz } as Response) : ({ ok: false } as Response))) as unknown as DoctorDeps["fetch"],
  });
  const check = async (healthz: unknown) =>
    (await Promise.all(runDoctorChecks(doctor(healthz)).asyncChecks)).find(c => c.name === "terminal_server");

  it("fails when the daemon is up but its tmux server does not answer, naming the socket, since when, and that nothing restarts it", async () => {
    const result = await check({ status: "ok", terminals: gone });
    expect(result?.status).toBe("fail");
    expect(result?.message).toContain("/run/user/1000/openrig.sock");
    expect(result?.message).toContain("2026-11-15T15:59:58.000Z");
    expect(result?.reason).toBe("The seats on it can't currently be reached through tmux. Automatic wakes, reminders and retries "
      + "through this server are currently held, without spending retries or escalating. The daemon does not restart the server.");
  });

  it("passes when it does", async () => {
    expect(await check({ status: "ok", terminals: reachable }))
      .toMatchObject({ status: "pass", message: expect.stringContaining("/run/user/1000/openrig.sock") });
  });

  it("reads the healthz body the port check already fetched: one request, not two", async () => {
    const deps = doctor({ status: "ok", terminals: gone });
    const fetch = vi.fn(deps.fetch!);
    await Promise.all(runDoctorChecks({ ...deps, fetch: fetch as unknown as DoctorDeps["fetch"] }).asyncChecks);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/healthz"))).toHaveLength(1);
  });

  it("is skipped by a daemon that doesn't report it, or hasn't observed its server yet", async () => {
    expect((await check({ status: "ok" }))?.status).toBe("skipped");
    expect((await check(undefined))?.status).toBe("skipped");
    expect((await check({ status: "ok", terminals: { state: "unknown", servers: [] } }))?.status).toBe("skipped");
  });

  it("says when the daemon couldn't read its server: skipped, not held, and no Terminals line", async () => {
    const unread = { state: "unknown", servers: [{ socket: "/run/user/1000/openrig.sock", state: "unknown",
      since: "2026-11-15T16:00:05.000Z", cause: "the return probe failed: Permission denied",
      lastLoss: { since: "2026-11-15T15:59:58.000Z" }, lastCheckedAt: "2026-11-15T16:00:05.000Z", transitions: 2 }] };
    const result = await check({ status: "ok", terminals: unread });
    expect(result?.status).toBe("skipped");
    expect(result?.message).toContain("couldn't read whether its tmux server on /run/user/1000/openrig.sock answers");
    expect(result?.message).toContain("is not held");
    expect(terminalsDegradedLine(readTerminalsEvidence(unread))).toBeNull();
  });
});
