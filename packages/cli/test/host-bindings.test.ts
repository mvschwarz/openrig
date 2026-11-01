import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostBindings, recordHostObservation, describeBindingConflict } from "../src/host-bindings.js";
import { mkdirSync as fs2Mkdir, utimesSync as fs2Utimes } from "node:fs";
import { resolveHost, type HostRegistry } from "../src/host-registry.js";
import { resolveCrossHostTarget } from "../src/cross-host-target.js";

// The learned host-identity sidecar (Slice 14 / B4, A2 + Source-1): hosts.yaml's known_hosts.
// TOFU on first contact; a later contradicting observation is recorded LOUDLY and never adopted;
// absence and corruption are fail-open; resolution merges registry id/hostId with learned bindings.

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "host-bindings-test-"));
  dirs.push(d);
  return join(d, "host-bindings.json");
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-08-21T02:00:00.000Z");

describe("recordHostObservation — TOFU + loud-conflict", () => {
  it("first contact binds silently and persists (TOFU)", () => {
    const path = tmpPath();
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    expect(out.outcome).toBe("bound");
    const loaded = loadHostBindings(path);
    expect(loaded.bindings["mm2-host"]).toEqual({
      hostId: "host-84c37990",
      firstObservedAt: "2026-08-21T02:00:00.000Z",
      lastObservedAt: "2026-08-21T02:00:00.000Z",
    });
  });

  it("re-observing the same id confirms and refreshes lastObservedAt only", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    const later = () => new Date("2026-08-22T03:00:00.000Z");
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: later, path });
    expect(out.outcome).toBe("confirmed");
    const b = loadHostBindings(path).bindings["mm2-host"]!;
    expect(b.firstObservedAt).toBe("2026-08-21T02:00:00.000Z");
    expect(b.lastObservedAt).toBe("2026-08-22T03:00:00.000Z");
  });

  it("a CONTRADICTING observation is recorded and the stored binding is NEVER overwritten", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-deadbeef", now: fixedNow, path });
    expect(out.outcome).toBe("conflict");
    const b = loadHostBindings(path).bindings["mm2-host"]!;
    expect(b.hostId).toBe("host-84c37990"); // the silent flip is the one forbidden move
    expect(b.conflict).toEqual({ hostId: "host-deadbeef", observedAt: "2026-08-21T02:00:00.000Z" });
    expect(describeBindingConflict("mm2-host", b)).toContain("host-84c37990");
    expect(describeBindingConflict("mm2-host", b)).toContain("host-deadbeef");
  });

  it("re-observing the ORIGINAL id after a conflict keeps the conflict visible (flapping is worse)", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", now: fixedNow, path });
    recordHostObservation({ alias: "h", observedHostId: "host-bbbb", now: fixedNow, path });
    const out = recordHostObservation({ alias: "h", observedHostId: "host-aaaa", now: fixedNow, path });
    expect(out.outcome).toBe("confirmed");
    expect(loadHostBindings(path).bindings["h"]!.conflict?.hostId).toBe("host-bbbb");
  });
});

describe("loadHostBindings — fail-open by contract", () => {
  it("missing file is an empty set, not an error", () => {
    expect(loadHostBindings("/nonexistent/host-bindings.json")).toEqual({ version: 1, bindings: {} });
  });

  it("corrupt JSON is an empty set (delete-to-relearn, never a crash)", () => {
    const path = tmpPath();
    writeFileSync(path, "{not json", "utf-8");
    expect(loadHostBindings(path)).toEqual({ version: 1, bindings: {} });
  });

  it("a FUTURE declared version reads as empty (fail-open), never mis-parsed through v1 eyes", () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ version: 2, bindings: { h: { hostId: "host-1111", firstObservedAt: "x", lastObservedAt: "x" } } }), "utf-8");
    expect(loadHostBindings(path)).toEqual({ version: 1, bindings: {} });
  });

  it("entries without a hostId are skipped, well-formed siblings survive", () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ version: 1, bindings: { bad: {}, good: { hostId: "host-1111", firstObservedAt: "x", lastObservedAt: "x" } } }), "utf-8");
    const loaded = loadHostBindings(path);
    expect(loaded.bindings["bad"]).toBeUndefined();
    expect(loaded.bindings["good"]?.hostId).toBe("host-1111");
  });
});

describe("resolveHost — learned bindings join the match set", () => {
  const registry: HostRegistry = {
    hosts: [
      { id: "mm2-host", transport: "http", url: "http://x:7433" },
      { id: "declared", transport: "http", url: "http://y:7433", hostId: "host-declared" },
    ],
  };

  it("a suffix equal to a LEARNED self-id resolves the alias it was learned for", () => {
    const res = resolveHost(registry, "host-84c37990", { "mm2-host": { hostId: "host-84c37990" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.host.id).toBe("mm2-host");
  });

  it("registry id and declared hostId outrank a learned binding", () => {
    // a learned binding claiming the DECLARED id for another alias must not shadow the declaration
    const res = resolveHost(registry, "host-declared", { "mm2-host": { hostId: "host-declared" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.host.id).toBe("declared");
  });

  it("no bindings passed behaves exactly as before (fail-open absence)", () => {
    expect(resolveHost(registry, "host-84c37990").ok).toBe(false);
  });
});

describe("resolveCrossHostTarget — the lived reply-hint scenario via the sidecar", () => {
  const registryLoader = () => ({
    ok: true as const,
    registry: { hosts: [{ id: "mm2-host", transport: "http" as const, url: "http://x:7433" }] },
  });

  it("a pasted reply hint resolves through the LEARNED binding and normalizes to the alias", () => {
    const out = resolveCrossHostTarget("pm@some-rig@host-84c37990", undefined, registryLoader, undefined, () => ({
      version: 1,
      bindings: { "mm2-host": { hostId: "host-84c37990", firstObservedAt: "x", lastObservedAt: "x" } },
    }));
    expect(out).toEqual({ ok: true, target: "pm@some-rig", sugarHost: "mm2-host", hint: undefined });
  });

  it("resolution through an entry with a recorded contradiction carries a loud warning naming both ids", () => {
    const out = resolveCrossHostTarget("pm@some-rig@host-84c37990", undefined, registryLoader, undefined, () => ({
      version: 1,
      bindings: {
        "mm2-host": {
          hostId: "host-84c37990",
          firstObservedAt: "x",
          lastObservedAt: "x",
          conflict: { hostId: "host-deadbeef", observedAt: "y" },
        },
      },
    }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.warning).toContain("host-84c37990");
      expect(out.warning).toContain("host-deadbeef");
    }
  });

  it("an unlearned suffix still passes through unchanged with the loud unregistered hint", () => {
    const out = resolveCrossHostTarget("pm@some-rig@host-unknown", undefined, registryLoader, undefined, () => ({
      version: 1,
      bindings: {},
    }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.target).toBe("pm@some-rig@host-unknown");
      expect(out.hint).toContain("no registered host 'host-unknown'");
    }
  });
});

describe("doctorLegs — Source-1 learning from the healthz body already in hand", () => {
  const anonHost = { id: "mm2-host", transport: "http", url: "http://x:7433" } as const;
  const baseDeps = {
    run: async () => ({ ok: true as const, stdout: "", sshStderr: "", failedStep: null }),
    tcpProbe: async () => "open" as const,
  };

  it("first contact: learns the selfHostId, records via the injected learner, reports pass", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const calls: Array<[string, string]> = [];
    const rows = await doctorLegs(anonHost, {
      ...baseDeps,
      httpGet: async () => ({ status: 200, body: JSON.stringify({ status: "ok", selfHostId: "host-84c37990" }) }),
      learnHostBinding: (alias, id) => {
        calls.push([alias, id]);
        return { outcome: "bound", binding: { hostId: id, firstObservedAt: "x", lastObservedAt: "x" } };
      },
    } as never);
    expect(calls).toEqual([["mm2-host", "host-84c37990"]]);
    const row = rows.find((r) => r.step === "host-identity-binding");
    expect(row).toMatchObject({ status: "pass" });
    expect(row!.detail).toContain("first contact");
    expect(row!.detail).toContain("host-84c37990");
  });

  it("contradiction: reports a LOUD fail row naming both ids with the re-learn fix", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const rows = await doctorLegs(anonHost, {
      ...baseDeps,
      httpGet: async () => ({ status: 200, body: JSON.stringify({ selfHostId: "host-deadbeef" }) }),
      learnHostBinding: (_alias, id) => ({
        outcome: "conflict",
        binding: { hostId: "host-84c37990", firstObservedAt: "x", lastObservedAt: "x", conflict: { hostId: id, observedAt: "y" } },
      }),
    } as never);
    const row = rows.find((r) => r.step === "host-identity-binding");
    expect(row).toMatchObject({ status: "fail" });
    expect(row!.detail).toContain("host-84c37990");
    expect(row!.detail).toContain("host-deadbeef");
    expect(row!.fix).toContain("host-bindings.json");
  });

  it("fail-open: a healthz body without selfHostId (older daemon) learns nothing and adds no row", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const calls: string[] = [];
    const rows = await doctorLegs(anonHost, {
      ...baseDeps,
      httpGet: async (url: string) => ({ status: 200, body: url.includes("healthz") ? "ok" : "{}" }),
      learnHostBinding: (alias: string) => {
        calls.push(alias);
        return { outcome: "bound", binding: { hostId: "x", firstObservedAt: "x", lastObservedAt: "x" } };
      },
    } as never);
    expect(calls).toEqual([]);
    expect(rows.find((r) => r.step === "host-identity-binding")).toBeUndefined();
  });

  it("fail-open: no learner wired (existing fixtures) means no learning and no row", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const rows = await doctorLegs(anonHost, {
      ...baseDeps,
      httpGet: async () => ({ status: 200, body: JSON.stringify({ selfHostId: "host-84c37990" }) }),
    } as never);
    expect(rows.find((r) => r.step === "host-identity-binding")).toBeUndefined();
  });

  it("first contact where replies do resolve here keeps the claim and adds no route row", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const rows = await doctorLegs(anonHost, {
      ...baseDeps,
      httpGet: async () => ({ status: 200, body: JSON.stringify({ selfHostId: "host-84c37990" }) }),
      learnHostBinding: (_alias: string, id: string) => ({ outcome: "bound", binding: { hostId: id, firstObservedAt: "x", lastObservedAt: "x" } }),
      replyRoute: () => anonHost,
    } as never);
    expect(rows.find((r) => r.step === "host-identity-binding")!.detail).toContain("now resolve to 'mm2-host'");
    expect(rows.find((r) => r.step === "reply-route")).toBeUndefined();
  });

  // An earlier hosts.yaml entry that learned the same identity keeps the replies, even after its
  // address stops answering. Real learner and real resolver over one sidecar file.
  it("an earlier entry with the same identity: doctor names it on the working entry and fails it when dead", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const p = tmpPath();
    const stale = { id: "old-box-b", transport: "http", url: "http://10.0.0.9:7433" } as const;
    const working = { id: "box-b", transport: "http", url: "http://10.0.0.5:7433" } as const;
    const registry: HostRegistry = { hosts: [stale, working] };
    recordHostObservation({ alias: stale.id, observedHostId: "host-0b0b0b0b", observedUrl: stale.url, path: p });
    const deps = {
      ...baseDeps,
      learnHostBinding: (alias: string, id: string, url: string) => recordHostObservation({ alias, observedHostId: id, observedUrl: url, path: p }),
      replyRoute: (id: string) => {
        const r = resolveHost(registry, id, loadHostBindings(p).bindings);
        return r.ok ? r.host : null;
      },
      learnedHostId: (alias: string) => loadHostBindings(p).bindings[alias]?.hostId ?? null,
    };

    const live = await doctorLegs(working, { ...deps, httpGet: async () => ({ status: 200, body: JSON.stringify({ selfHostId: "host-0b0b0b0b" }) }) } as never);
    const identity = live.find((r) => r.step === "host-identity-binding")!;
    expect(identity.status).toBe("pass");
    expect(identity.detail).not.toContain("now resolve to");
    const route = live.find((r) => r.step === "reply-route")!;
    expect(route.status).toBe("unknown");
    expect(route.detail).toContain("go to 'old-box-b', not 'box-b'");
    expect(route.fix).toContain("rig host doctor old-box-b");
    // The entry doctor names is the one rig send's own resolver picks.
    const sent = resolveCrossHostTarget("pm@some-rig@host-0b0b0b0b", undefined, () => ({ ok: true as const, registry }), undefined, () => loadHostBindings(p));
    expect(sent).toMatchObject({ ok: true, sugarHost: "old-box-b" });

    const dead = await doctorLegs(stale, { ...deps, httpGet: async () => { throw new Error("read ECONNRESET"); } } as never);
    expect(dead.find((r) => r.step === "transport-reachability")!.status).toBe("fail");
    const deadRoute = dead.find((r) => r.step === "reply-route")!;
    expect(deadRoute.status).toBe("fail");
    expect(deadRoute.detail).toContain("@host-0b0b0b0b resolve to 'old-box-b'");
    expect(deadRoute.fix).toContain("delete 'old-box-b'");
  });

  it("an unreachable entry that replies don't resolve to adds no route row", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const rows = await doctorLegs(anonHost, {
      ...baseDeps,
      httpGet: async () => { throw new Error("connect ECONNREFUSED"); },
      learnedHostId: () => "host-84c37990",
      replyRoute: () => ({ id: "other-host", transport: "http", url: "http://y:7433" }),
    } as never);
    expect(rows.map((r) => r.step)).toEqual(["transport-reachability"]);
  });

  it("an unreachable ssh entry whose declared hostId replies resolve to gets the route row too", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const sshHost = { id: "vps-1", transport: "ssh", target: "vps-1.tailnet", user: "openrig", hostId: "host-84c37990" } as const;
    const rows = await doctorLegs(sshHost, {
      ...baseDeps,
      run: async () => ({ ok: false, failedStep: "ssh-unreachable", sshStderr: "connect refused" }),
      httpGet: async () => ({ status: 200, body: "" }),
      replyRoute: (id: string) => (id === "host-84c37990" ? sshHost : null),
    } as never);
    expect(rows.find((r) => r.step === "reply-route")).toMatchObject({ status: "fail" });
  });
});

describe("F2 — concurrency guard: conflict records survive concurrent writers", () => {
  it("sequential writers on different aliases both land (baseline)", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "a-host", observedHostId: "host-aaaa", now: fixedNow, path });
    recordHostObservation({ alias: "b-host", observedHostId: "host-bbbb", now: fixedNow, path });
    const loaded = loadHostBindings(path);
    expect(loaded.bindings["a-host"]?.hostId).toBe("host-aaaa");
    expect(loaded.bindings["b-host"]?.hostId).toBe("host-bbbb");
  });

  it("REAL multi-process contention: N parallel writers, every binding and the conflict record survive", async () => {
    const path = tmpPath();
    const { spawn } = await import("node:child_process");
    // CONTENTION SMOKE, not a deterministic discriminator: the pre-guard loss requires a specific
    // interleave, so a green run does not prove the guard alone — the guard's serialization claim
    // rests on mkdir's atomicity; this proves the locked path survives real parallel writers.
    // Seed a binding, then race 6 child processes: 5 write distinct aliases, 1 writes a
    // CONTRADICTING id for the seeded alias.
    recordHostObservation({ alias: "seed", observedHostId: "host-orig", now: fixedNow, path });
    const runner = (alias: string, id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e",
        `import { recordHostObservation } from ${JSON.stringify(new URL("../src/host-bindings.ts", import.meta.url).href)};` +
        `recordHostObservation({ alias: ${JSON.stringify(alias)}, observedHostId: ${JSON.stringify(id)}, path: ${JSON.stringify(path)} });`,
      ], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${alias} exited ${code}`))));
      child.on("error", reject);
    });
    await Promise.all([
      runner("w1", "host-1111"), runner("w2", "host-2222"), runner("w3", "host-3333"),
      runner("w4", "host-4444"), runner("w5", "host-5555"), runner("seed", "host-CONTRA"),
    ]);
    const loaded = loadHostBindings(path);
    for (const [alias, id] of [["w1","host-1111"],["w2","host-2222"],["w3","host-3333"],["w4","host-4444"],["w5","host-5555"]] as const) {
      expect(loaded.bindings[alias]?.hostId, alias).toBe(id);
    }
    expect(loaded.bindings["seed"]?.hostId).toBe("host-orig"); // never silently adopted
    expect(loaded.bindings["seed"]?.conflict?.hostId).toBe("host-CONTRA"); // the record SURVIVED the race
  }, 30_000);

  it("a writer behind a slow holder waits for it, rather than writing over it unguarded", async () => {
    const path = tmpPath();
    const lockDir = `${path}.lock`;
    const { spawn } = await import("node:child_process");
    recordHostObservation({ alias: "seed", observedHostId: "host-orig", now: fixedNow, path });
    // The holder does what a descheduled writer does on a loaded machine: takes the lock, loads, stalls 600 ms
    // (past a short wait budget, well inside the stale threshold), then writes what it loaded plus its own binding.
    const holder = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.mkdirSync(${JSON.stringify(lockDir)});
      const file = JSON.parse(fs.readFileSync(${JSON.stringify(path)}, "utf-8"));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      file.bindings.holder = { hostId: "host-hold", firstObservedAt: "x", lastObservedAt: "x" };
      fs.writeFileSync(${JSON.stringify(`${path}.tmp-holder`)}, JSON.stringify(file));
      fs.renameSync(${JSON.stringify(`${path}.tmp-holder`)}, ${JSON.stringify(path)});
      fs.rmdirSync(${JSON.stringify(lockDir)});
    `], { stdio: "ignore" });
    let done = false;
    const exited = new Promise<number | null>((resolve) => holder.on("exit", (code) => { done = true; resolve(code); }));
    while (!existsSync(lockDir) && !done) await new Promise((r) => setTimeout(r, 2));
    recordHostObservation({ alias: "w1", observedHostId: "host-1111", now: fixedNow, path });
    expect(await exited).toBe(0);
    const loaded = loadHostBindings(path);
    expect(loaded.bindings["holder"]?.hostId).toBe("host-hold");
    expect(loaded.bindings["w1"]?.hostId).toBe("host-1111");
  }, 10_000);

  it("a stale lock (crashed writer) is taken over, not waited on forever", () => {
    const path = tmpPath();
    const lockDir = `${path}.lock`;
    fs2Mkdir(lockDir);
    // Backdate the lock beyond the stale threshold.
    const old = Date.now() / 1000 - 10;
    fs2Utimes(lockDir, old, old);
    const out = recordHostObservation({ alias: "x", observedHostId: "host-xxxx", now: fixedNow, path });
    expect(out.outcome).toBe("bound");
    expect(loadHostBindings(path).bindings["x"]?.hostId).toBe("host-xxxx");
  });
});

describe("sidecar file hygiene", () => {
  it("the write is whole-file JSON a human can read and delete (the disposable contract)", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    const raw = readFileSync(path, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).version).toBe(1);
  });
});

describe("observedUrl — the entry URL a binding was learned at (#1642)", () => {
  const URL_A = "http://10.0.0.5:7433";
  const URL_B = "http://10.0.0.6:7433";
  const later = () => new Date("2026-08-22T03:00:00.000Z");

  it("first contact stores the URL the self-id was observed at", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", observedUrl: URL_A, now: fixedNow, path });
    expect(loadHostBindings(path).bindings["h"]).toEqual({
      hostId: "host-aaaa", firstObservedAt: "2026-08-21T02:00:00.000Z", lastObservedAt: "2026-08-21T02:00:00.000Z", observedUrl: URL_A,
    });
  });

  it("reconfirming the same id backfills a legacy binding's URL and follows a moved entry", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", now: fixedNow, path });
    expect(loadHostBindings(path).bindings["h"]!.observedUrl).toBeUndefined();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", observedUrl: URL_A, now: later, path });
    expect(loadHostBindings(path).bindings["h"]!.observedUrl).toBe(URL_A);
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", observedUrl: URL_B, now: later, path });
    expect(loadHostBindings(path).bindings["h"]!.observedUrl).toBe(URL_B);
  });

  it("a conflicting observation never attaches its URL to the stored identity", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", observedUrl: URL_A, now: fixedNow, path });
    const out = recordHostObservation({ alias: "h", observedHostId: "host-bbbb", observedUrl: URL_B, now: later, path });
    expect(out.outcome).toBe("conflict");
    const b = loadHostBindings(path).bindings["h"]!;
    expect(b.hostId).toBe("host-aaaa");
    expect(b.observedUrl).toBe(URL_A);
    expect(b.conflict?.hostId).toBe("host-bbbb");
  });

  it("a conflicting observation leaves a legacy binding without a URL", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", now: fixedNow, path });
    recordHostObservation({ alias: "h", observedHostId: "host-bbbb", observedUrl: URL_B, now: later, path });
    expect(loadHostBindings(path).bindings["h"]!.observedUrl).toBeUndefined();
  });

  it("reconfirming the original id while a conflict is recorded neither changes the URL nor clears the conflict", () => {
    const path = tmpPath();
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", observedUrl: URL_A, now: fixedNow, path });
    recordHostObservation({ alias: "h", observedHostId: "host-bbbb", observedUrl: URL_B, now: later, path });
    recordHostObservation({ alias: "h", observedHostId: "host-aaaa", observedUrl: URL_B, now: later, path });
    const b = loadHostBindings(path).bindings["h"]!;
    expect(b.observedUrl).toBe(URL_A);
    expect(b.conflict?.hostId).toBe("host-bbbb");
  });

  it("the loader keeps a string observedUrl and drops any other value", () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ version: 1, bindings: {
      a: { hostId: "host-aaaa", firstObservedAt: "x", lastObservedAt: "x", observedUrl: URL_A },
      b: { hostId: "host-bbbb", firstObservedAt: "x", lastObservedAt: "x", observedUrl: 7 },
    } }));
    const { bindings } = loadHostBindings(path);
    expect(bindings["a"]!.observedUrl).toBe(URL_A);
    expect("observedUrl" in bindings["b"]!).toBe(false);
  });

  it("doctor passes the entry URL it probed to the learner", async () => {
    const { doctorLegs } = await import("../src/commands/host.js");
    const calls: unknown[][] = [];
    await doctorLegs({ id: "vm-a", transport: "http", url: URL_A } as const, {
      run: async () => ({ ok: true as const, stdout: "", sshStderr: "", failedStep: null }),
      tcpProbe: async () => "open" as const,
      httpGet: async () => ({ status: 200, body: JSON.stringify({ selfHostId: "host-aaaa" }) }),
      learnHostBinding: (...args: unknown[]) => {
        calls.push(args);
        return { outcome: "bound", binding: { hostId: "host-aaaa", firstObservedAt: "x", lastObservedAt: "x" } };
      },
    } as never);
    expect(calls).toEqual([["vm-a", "host-aaaa", URL_A]]);
  });
});
