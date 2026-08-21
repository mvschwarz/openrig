import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostBindings, recordHostObservation, describeBindingConflict } from "../src/host-bindings.js";
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
