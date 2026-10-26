// Slice 09 (OPR.0.3.2.9) — `rig policy` CLI tests.
//
// HG-4 / HG-7 anchored at the CLI layer:
//   - HG-7: `rig policy set <mode>` WITHOUT --confirm restates the
//     proposed binding and exits 2; daemon is NOT called.
//   - HG-7: bare-word + `mode:` prefix BOTH normalize to a valid mode.
//   - HG-4: with --confirm + --bearer, an Authorization header is sent
//     on the PUT.
//   - HG-3: `rig policy effective` surfaces Q6 unknown_posture cleanly
//     when no binding matches.
//   - Citation helper format matches convention §Citation Rules
//     (short-prose with mode + scope(:qualifier) + operator source).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { rigModeCommand, __test__, type RigModeDeps } from "../src/commands/rig-mode.js";
import { DaemonResponseError } from "../src/client.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface FakeResponse<T = unknown> { status: number; data: T }
type RecordedCall = { method: string; path: string; body?: unknown; options?: { headers?: Record<string, string> } };

function fakeClient(opts: {
  defaultsResponse?: FakeResponse;
  putResponse?: FakeResponse;
  deleteResponse?: FakeResponse;
  getResponse?: FakeResponse;
  effectiveResponse?: FakeResponse;
}): { client: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = {
    get: vi.fn(async (path: string) => {
      calls.push({ method: "GET", path });
      if (path.startsWith("/api/rig-mode/defaults")) {
        return opts.defaultsResponse ?? {
          status: 200,
          data: {
            recommendedModeDefaults: {
              sleep: { autonomy_scope: "pre_approved_only", heartbeat_cadence: "sparse", inspection_depth: "normal", update_detail: "compact", escalation_threshold: "blocker_only", concurrency_limit: "serial", permission_prompt_posture: "batch_for_human" },
              desk: { autonomy_scope: "full_autonomy_within_workstream", heartbeat_cadence: "normal", inspection_depth: "normal", update_detail: "normal", escalation_threshold: "normal", concurrency_limit: "unlimited", permission_prompt_posture: "normal" },
              mobile: { autonomy_scope: "bounded_continuation", heartbeat_cadence: "normal", inspection_depth: "surface", update_detail: "compact", escalation_threshold: "low", concurrency_limit: "unlimited", permission_prompt_posture: "batch_for_human" },
              away: { autonomy_scope: "pre_approved_only", heartbeat_cadence: "sparse", inspection_depth: "normal", update_detail: "compact", escalation_threshold: "blocker_only", concurrency_limit: "serial", permission_prompt_posture: "batch_for_human" },
              focus: { autonomy_scope: "full_autonomy_within_workstream", heartbeat_cadence: "normal", inspection_depth: "normal", update_detail: "compact", escalation_threshold: "blocker_only", concurrency_limit: "unlimited", permission_prompt_posture: "batch_for_human" },
              debug: { autonomy_scope: "bounded_continuation", heartbeat_cadence: "fast", inspection_depth: "forensic", update_detail: "verbose", escalation_threshold: "low", concurrency_limit: "serial", permission_prompt_posture: "normal" },
            },
            recommendedDefaultScope: { sleep: "global_host", desk: "global_host", mobile: "global_host", away: "global_host", focus: "workstream", debug: "qitem" },
            defaultStaleRule: "re_confirm_on_long_gap",
          },
        };
      }
      if (path.startsWith("/api/rig-mode/effective")) {
        return opts.effectiveResponse ?? { status: 200, data: { effective: null, posture: "unknown_posture", hint: "..." } };
      }
      return opts.getResponse ?? { status: 200, data: { bindings: [] } };
    }),
    put: vi.fn(async (path: string, body: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: "PUT", path, body, options });
      const reqBody = body as { mode: string; record: Record<string, string> };
      return opts.putResponse ?? { status: 200, data: { binding: { id: "qitem:q-1", mode: reqBody.mode, record: reqBody.record, qualifier: "q-1", setAt: "2026-05-17T00:00:00.000Z", setBy: "operator" } } };
    }),
    delete: vi.fn(async (path: string, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: "DELETE", path, options });
      return opts.deleteResponse ?? { status: 200, data: { removed: true } };
    }),
  };
  return { client, calls };
}

function deps(client: unknown): RigModeDeps {
  return {
    lifecycleDeps: {} as LifecycleDeps,
    clientFactory: () => client as ReturnType<RigModeDeps["clientFactory"]>,
  };
}

let logs: string[];
let errs: string[];
beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => errs.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")));
  process.exitCode = undefined;
});

describe("disambiguateModeInvocation (Component 4 bare-word rule)", () => {
  const { disambiguateModeInvocation } = __test__;
  it("accepts bare reserved modes", () => {
    for (const m of ["sleep", "desk", "mobile", "away", "focus", "debug"]) {
      expect(disambiguateModeInvocation(m)).toBe(m);
    }
  });
  it("accepts the `mode:` prefix form", () => {
    expect(disambiguateModeInvocation("mode:debug")).toBe("debug");
    expect(disambiguateModeInvocation("mode: focus")).toBe("focus");
  });
  it("rejects unknown words", () => {
    expect(disambiguateModeInvocation("banana")).toBeNull();
    expect(disambiguateModeInvocation("operator:L1")).toBeNull();
    expect(disambiguateModeInvocation("OFF")).toBeNull();
  });
  it("rejects multi-word strings (embedded-in-sentence)", () => {
    expect(disambiguateModeInvocation("set debug")).toBeNull();
    expect(disambiguateModeInvocation("we should mobile this")).toBeNull();
  });
  it("rejects empty input", () => {
    expect(disambiguateModeInvocation("")).toBeNull();
    expect(disambiguateModeInvocation("   ")).toBeNull();
  });
});

describe("formatCitation (Component 5)", () => {
  const { formatCitation } = __test__;
  it("emits mode + scope(:qualifier) + operator source + set_at — mode is binding-level", () => {
    const line = formatCitation({
      id: "qitem:q-1",
      mode: "debug",
      record: { scope: "qitem" } as Record<string, string>,
      qualifier: "q-1",
      setAt: "2026-05-17T00:00:00.000Z",
      setBy: "operator",
    });
    expect(line).toContain("`debug`");
    expect(line).toContain("`qitem:q-1`");
    expect(line).toContain("operator");
    expect(line).toContain("2026-05-17T00:00:00.000Z");
  });
  it("omits qualifier when null (global_host)", () => {
    const line = formatCitation({
      id: "global_host:host",
      mode: "sleep",
      record: { scope: "global_host" } as Record<string, string>,
      qualifier: null,
      setAt: "2026-05-17T00:00:00.000Z",
      setBy: "operator",
    });
    expect(line).toContain("`global_host`");
    expect(line).not.toContain("`global_host:");
  });
});

describe("rig policy set — restate-and-confirm gate (HG-7)", () => {
  it("WITHOUT --confirm: restates + exits 2 + does NOT call PUT", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(2);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(0);
    expect(logs.join("\n")).toContain("Proposed binding (restate-and-confirm — NOT applied)");
    expect(logs.join("\n")).toContain("debug");
  });

  it("WITHOUT --confirm + --json: ok:false + confirm_required:true", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--json"]);
    expect(process.exitCode).toBe(2);
    const joined = logs.join("\n");
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    expect(parsed.confirm_required).toBe(true);
    expect(parsed.proposed.mode).toBe("debug");
    expect(parsed.proposed.record.mode).toBeUndefined();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("WITH --confirm: PUTs { mode, record } to the daemon and prints citation", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm"]);
    expect(process.exitCode).toBeUndefined();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe("/api/rig-mode/bindings/qitem/q-1");
    const putBody = puts[0]!.body as { mode: string; record: Record<string, string> };
    expect(putBody.mode).toBe("debug");
    // BLOCKING-1: record must NOT carry `mode` inside.
    expect(putBody.record.mode).toBeUndefined();
    expect(putBody.record.scope).toBe("qitem");
    expect(logs.join("\n")).toContain("Operating in `debug` mode at `qitem:q-1`");
  });

  it("HG-4: --bearer forwards Authorization: Bearer <token>", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm", "--bearer", "operator-token"]);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.options?.headers?.Authorization).toBe("Bearer operator-token");
  });

  it("HG-7 mode:<name> prefix: works the same as bare word", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "mode:focus", "--qualifier", "ws-1", "--confirm"]);
    const put = calls.find((c) => c.method === "PUT")!;
    const body = put.body as { mode: string; record: Record<string, string> };
    expect(body.mode).toBe("focus");
    expect(body.record.scope).toBe("workstream");
    expect(put.path).toBe("/api/rig-mode/bindings/workstream/ws-1");
  });

  it("rejects unknown mode with exit=1; daemon NOT called", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "banana", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Unknown mode/);
  });

  it("forwards 401 from daemon with operator hint", async () => {
    const { client } = fakeClient({ putResponse: { status: 401, data: { error: "unauthorized" } } });
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/Unauthorized/);
  });
});

describe("rig policy effective — Q6 unknown_posture surfaced", () => {
  it("prints 'unknown_posture' when daemon returns null effective", async () => {
    const { client } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "effective", "--qitem", "q-1"]);
    expect(logs.join("\n")).toContain("unknown_posture");
  });
});

describe("rig policy cite — convention citation rules", () => {
  it("prints unknown_posture fallback when no binding resolves", async () => {
    const { client } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "cite", "--qitem", "q-1"]);
    expect(logs.join("\n")).toContain("without an explicit");
  });

  it.each([401, 403, 500])("does not fabricate an unset posture after HTTP %s", async (status) => {
    const { client } = fakeClient({ effectiveResponse: { status, data: { error: "read_failed" } } });
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "cite", "--qitem", "q-1"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("read_failed");
    expect(logs).toEqual([]);
  });

  it("emits citation line when a binding resolves", async () => {
    const { client } = fakeClient({
      effectiveResponse: {
        status: 200,
        data: {
          posture: "known",
          effective: {
            resolvedScope: "qitem",
            binding: {
              id: "qitem:q-1",
              mode: "debug",
              record: { scope: "qitem" },
              qualifier: "q-1",
              setAt: "2026-05-17T00:00:00.000Z",
              setBy: "operator",
            },
          },
        },
      },
    });
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "cite", "--qitem", "q-1"]);
    const line = logs.join("\n");
    expect(line).toMatch(/Operating in `debug` mode at `qitem:q-1` per operator/);
  });
});

describe("normalizeScopeQualifier (CLI mirror of daemon-route parseScopeAndQualifier)", () => {
  const { normalizeScopeQualifier } = __test__;
  it("global_host + no explicit qualifier → ok with null", () => {
    const r = normalizeScopeQualifier("global_host", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.qualifier).toBeNull();
  });
  it("global_host + explicit qualifier → REJECTED (no silent drop)", () => {
    const r = normalizeScopeQualifier("global_host", "unexpected");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Global-host bindings cannot carry a qualifier/);
  });
  it("rig + qualifier → ok with the qualifier", () => {
    const r = normalizeScopeQualifier("rig", "rig-a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.qualifier).toBe("rig-a");
  });
  it("rig + no qualifier → rejected (qualifier_required)", () => {
    const r = normalizeScopeQualifier("rig", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/requires a qualifier/);
  });
});

describe("BLOCKING re-verify-2 (qitem-20260518045300): explicit --scope global_host --qualifier <X> rejected BEFORE any daemon contact", () => {
  it("WITHOUT --confirm: exits 1; daemon NOT contacted at all (no GET /defaults, no PUT, no restate)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--qualifier", "unexpected"]);
    expect(process.exitCode).toBe(1);
    // BLOCKING re-verify-2 evidence: zero daemon calls of any kind.
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Global-host bindings cannot carry a qualifier/);
    expect(logs.join("\n")).not.toContain("Proposed binding");
  });

  it("WITH --confirm: exits 1; daemon NOT contacted (no GET /defaults, no PUT)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--qualifier", "unexpected", "--confirm"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Global-host bindings cannot carry a qualifier/);
  });

  it("WITH --json: emits ok:false + qualifier_invalid; zero daemon calls", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--qualifier", "unexpected", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("qualifier_invalid");
  });

  it("Explicit non-global scope missing qualifier ALSO preflighted: zero daemon calls", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--scope", "rig"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/requires a qualifier/);
  });

  it("Explicit unknown scope rejected locally: zero daemon calls", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--scope", "banana", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Unknown scope 'banana'/);
  });

  it("Positive: set sleep --scope global_host --confirm → PUT /bindings/global_host (one GET /defaults + one PUT)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--confirm"]);
    expect(process.exitCode).toBeUndefined();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/rig-mode/bindings/global_host");
  });

  it("Implicit-default-scope path STILL fetches defaults (no preflight rejection): set debug without --scope reaches GET /defaults + PUT", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm"]);
    expect(process.exitCode).toBeUndefined();
    const gets = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/rig-mode/defaults"));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(gets.length).toBe(1);
    expect(puts.length).toBe(1);
    expect(puts[0]!.path).toBe("/api/rig-mode/bindings/qitem/q-1");
  });

  it("Implicit-default-scope path still rejects missing qualifier when default scope needs one (no PUT)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    // `debug` default scope is `qitem`; without --qualifier the post-defaults normalization rejects.
    await cmd.parseAsync(["node", "rig", "set", "debug"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/requires a qualifier/);
  });
});

describe("rig policy unset — operator-only DELETE", () => {
  it("calls DELETE with Authorization when --bearer is provided", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "qitem", "q-1", "--bearer", "operator-token"]);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/rig-mode/bindings/qitem/q-1");
    expect(del.options?.headers?.Authorization).toBe("Bearer operator-token");
  });

  it("rejects unknown scope with exit=1; daemon NOT called", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "banana", "x"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  // BLOCKING re-verify (qitem-20260518044650): `unset global_host
  // <qualifier>` must NOT silently drop the qualifier and delete the
  // host row. Same shape as set; same shared helper.
  it("BLOCKING re-verify: unset global_host unexpected → exits 1; daemon NOT called", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "global_host", "unexpected"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Global-host bindings cannot carry a qualifier/);
  });

  it("Positive: unset global_host (no qualifier) targets /bindings/global_host", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigModeCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "global_host"]);
    expect(process.exitCode).toBeUndefined();
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/rig-mode/bindings/global_host");
  });
});

// Slice 04 (OPR.0.7.0.4) 04-A2 — a saved mode and a posture kept side by side at one target.
describe("rig mode: a saved mode and a posture kept side by side (04-A2)", () => {
  const categoryOfMode = (mode: string) => (mode === "human-led" || mode === "delegated" ? "posture" : "mode");
  const binding = (mode: string, id: string) => ({ id, mode, record: {}, qualifier: "r1", setAt: "2026-10-14T18:00:00.000Z", setBy: "operator" });
  const preview = async (getResponse: FakeResponse | "throw", extra: string[] = []) => {
    const { client, calls } = fakeClient(getResponse === "throw" ? {} : { getResponse });
    if (getResponse === "throw") {
      const get = (client as { get: (path: string) => Promise<unknown> }).get;
      (client as { get: unknown }).get = vi.fn(async (path: string) => {
        if (path.startsWith("/api/rig-mode/bindings/")) throw new Error("connection reset");
        return get(path);
      });
    }
    // (The test defaults carry only the legacy modes, so the proposal is a saved mode.)
    await rigModeCommand(deps(client)).parseAsync(["node", "rig", "set", "focus", "--scope", "rig", "--qualifier", "r1", ...extra]);
    expect(process.exitCode).toBe(2);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    return { out: logs.join("\n"), calls };
  };

  it("preview reads the target this write lands on and names what it replaces there; exit 2, no PUT", async () => {
    const { out, calls } = await preview({ status: 200, data: { writeTarget: "rig:r1", bindings: [binding("debug", "rig:r1"), binding("delegated", "posture@rig:r1")] } });
    expect(calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual(["/api/rig-mode/defaults", "/api/rig-mode/bindings/rig/r1?for=mode"]);
    expect(out).toContain("  currently at rig:r1, where this write lands: mode=debug, posture=delegated");
    expect(out).toContain("  this write replaces: debug (mode, rig:r1); any posture there is kept");
  });

  it("preview with nothing stored where the write lands says it replaces nothing there", async () => {
    const { out } = await preview({ status: 200, data: { writeTarget: "rig:r1", bindings: [] } }, ["--json"]);
    expect(JSON.parse(out)).toMatchObject({ confirm_required: true, current: { writeTarget: "rig:r1", mode: null, posture: null }, displaces: null });
  });

  it.each<[string, FakeResponse | "throw", string]>([
    ["a daemon that predates categories (no writeTarget)", { status: 200, data: { binding: binding("focus", "rig:r1") } }, "this daemon doesn't report where this write lands"],
    ["a daemon that predates categories (nothing stored: its 404)", { status: 404, data: { error: "not_found" } }, "this daemon doesn't report where this write lands"],
    ["a refusal", { status: 400, data: { error: "scope_unresolved", hint: "x" } }, "scope_unresolved"],
    ["an HTTP error", { status: 500, data: { error: "boom" } }, "boom"],
    ["a malformed reply (bindings not a list)", { status: 200, data: { writeTarget: "rig:r1", bindings: "x" } }, "the daemon's answer was malformed"],
    ["a malformed reply (a binding without a mode)", { status: 200, data: { writeTarget: "rig:r1", bindings: [{ id: "rig:r1" }] } }, "the daemon's answer was malformed"],
    ["a malformed reply (not an object)", { status: 200, data: "ok" }, "this daemon doesn't report where this write lands"],
    ["a failed request", "throw", "the read failed"],
  ])("preview with %s restates the proposal with the current state UNKNOWN, never none; exit 2", async (_label, response, reason) => {
    const { out } = await preview(response);
    expect(out).toContain("Proposed binding (restate-and-confirm — NOT applied)");
    expect(out).toContain(`  currently: UNKNOWN (${reason}); what this write replaces is unknown`);
    expect(out).not.toMatch(/none|replaces: /);
  });

  // A successful reply is used only when it is usable: a named write target and bindings in supported modes.
  it.each<[string, FakeResponse]>([
    ["an empty writeTarget", { status: 200, data: { writeTarget: "", bindings: [] } }],
    ["a binding in an unsupported mode", { status: 200, data: { writeTarget: "rig:r1", bindings: [binding("not-a-mode", "rig:r1")] } }],
  ])("preview with a 200 carrying %s reads UNKNOWN, in the text and the JSON; exit 2, no PUT", async (_label, response) => {
    const text = await preview(response);
    expect(text.out).toContain("  currently: UNKNOWN (the daemon's answer was malformed); what this write replaces is unknown");
    expect(text.out).not.toMatch(/none|replaces: /);
    logs.length = 0;
    const json = await preview(response, ["--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ confirm_required: true, current: "unknown", displaces: "unknown" });
  });

  it("controls: a named target with nothing stored stays a known absence, and every supported mode name is used as stored", async () => {
    const empty = await preview({ status: 200, data: { writeTarget: "rig:r1", bindings: [] } });
    expect(empty.out).toContain("  this write replaces: no mode binding; any posture there is kept");
    for (const mode of ["sleep", "desk", "mobile", "away", "focus", "debug", "human-led", "delegated"]) {
      logs.length = 0;
      const id = categoryOfMode(mode) === "posture" ? "posture@rig:r1" : "rig:r1";
      const { out } = await preview({ status: 200, data: { writeTarget: "rig:r1", bindings: [binding(mode, id)] } });
      expect(out, mode).toContain("  currently at rig:r1, where this write lands:");
      if (categoryOfMode(mode) === "mode") expect(out, mode).toContain(`  this write replaces: ${mode} (mode, rig:r1); any posture there is kept`);
      else expect(out, mode).toContain(`posture=${mode}`);
    }
  });

  it("unset --category goes through the category path and says what's still kept, in the text and the JSON", async () => {
    const deleteResponse = { status: 200, data: { removed: true, category: "posture", remaining: binding("focus", "rig:r1") } };
    const { client, calls } = fakeClient({ deleteResponse });
    await rigModeCommand(deps(client)).parseAsync(["node", "rig", "unset", "rig", "r1", "--category", "posture"]);
    expect(calls.find((c) => c.method === "DELETE")!.path).toBe("/api/rig-mode/bindings/rig/r1/categories/posture");
    expect(logs).toEqual(["Removed rig:r1", "  still kept: focus (mode, rig:r1)"]);
    logs.length = 0;
    const json = fakeClient({ deleteResponse });
    await rigModeCommand(deps(json.client)).parseAsync(["node", "rig", "unset", "global_host", "--category", "mode", "--json"]);
    expect(json.calls.find((c) => c.method === "DELETE")!.path).toBe("/api/rig-mode/bindings/global_host/categories/mode");
    expect(JSON.parse(logs.join("\n"))).toEqual({ ok: true, removed: true, category: "posture", remaining: deleteResponse.data.remaining });
  });

  it("unset --category against a daemon without that route (its plain 404) removes nothing, says so and exits 1", async () => {
    const { client } = fakeClient({});
    (client as { delete: unknown }).delete = vi.fn(async () => { throw new DaemonResponseError(404, "404 Not Found"); });
    await rigModeCommand(deps(client)).parseAsync(["node", "rig", "unset", "rig", "r1", "--category", "mode"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toBe("This daemon can't remove a binding by category (it predates categories); nothing was removed.");
    expect(logs).toEqual([]);
  });

  it("effective names the other category's binding when both apply", async () => {
    const effective = { binding: { ...binding("delegated", "posture@rig:r1"), record: { scope: "rig" } }, resolvedScope: "rig" };
    const { client } = fakeClient({ effectiveResponse: { status: 200, data: {
      posture: "known", effective, categories: { mode: binding("focus", "rig:r1"), posture: effective.binding },
    } } });
    await rigModeCommand(deps(client)).parseAsync(["node", "rig", "effective", "--rig", "r1"]);
    expect(logs.join("\n")).toContain("  also kept: focus (mode, rig:r1, set_at=2026-10-14T18:00:00.000Z)");
  });
});

// Slice 04 (OPR.0.7.0.4) 04-A3 — eight legacy record fields are stored and shown, but nothing in OpenRig acts on them
// yet. Every human surface that prints them says so, on exactly those eight, with one legend line; `scope` (the
// binding's key) and `evidence_citation` (read by the operating-posture consumer) aren't marked. JSON is unchanged.
describe("rig mode: legacy record fields marked stored, not applied (04-A3)", () => {
  const MARKED = ["autonomy_scope", "heartbeat_cadence", "inspection_depth", "update_detail", "escalation_threshold", "concurrency_limit",
    "permission_prompt_posture", "expiry_or_stale_rule"];
  const UNMARKED = ["scope", "evidence_citation"];
  const MARK = "(stored; not applied)";
  const LEGEND = "fields marked (stored; not applied) are saved and shown, but nothing in OpenRig acts on them yet";
  const record = {
    autonomy_scope: "bounded_continuation", heartbeat_cadence: "fast", inspection_depth: "forensic", update_detail: "verbose",
    escalation_threshold: "low", concurrency_limit: "serial", permission_prompt_posture: "normal",
    scope: "rig", expiry_or_stale_rule: "re_confirm_on_long_gap", evidence_citation: "operator confirmed debug",
  };
  /** Each printed record line, keyed by its field. */
  const fieldLines = (out: string[]) => Object.fromEntries(out.map((l) => l.match(/^\s+([a-z_]+): /)).filter(Boolean).map((m) => [m![1]!, m!.input!]));
  const expectMarked = (out: string[]) => {
    const lines = fieldLines(out);
    for (const f of MARKED) expect(lines[f], f).toMatch(new RegExp(`: \\S+  \\(stored; not applied\\)$`));
    for (const f of UNMARKED) expect(lines[f], f).not.toContain(MARK);
    expect(out.filter((l) => l.trim() === LEGEND)).toHaveLength(1);
  };

  it("effective marks exactly the eight fields, with one legend line; --json is unchanged", async () => {
    const effectiveResponse = { status: 200, data: { posture: "known", effective: { binding: { id: "rig:r1", mode: "debug", record, qualifier: "r1", setAt: "t", setBy: "operator" }, resolvedScope: "rig" } } };
    await rigModeCommand(deps(fakeClient({ effectiveResponse }).client)).parseAsync(["node", "rig", "effective", "--rig", "r1"]);
    expectMarked(logs);
    logs.length = 0;
    await rigModeCommand(deps(fakeClient({ effectiveResponse }).client)).parseAsync(["node", "rig", "effective", "--rig", "r1", "--json"]);
    expect(logs.join("\n")).toBe(JSON.stringify(effectiveResponse.data, null, 2));
  });

  it("defaults marks the seven fields of every mode, says the served default stale rule isn't applied, and has one legend line; --json is unchanged", async () => {
    // The daemon serves all eight modes (the six legacy names and both postures).
    const seven = { autonomy_scope: "a", heartbeat_cadence: "b", inspection_depth: "c", update_detail: "d", escalation_threshold: "e", concurrency_limit: "f", permission_prompt_posture: "g" };
    const modes = ["sleep", "desk", "mobile", "away", "focus", "debug", "human-led", "delegated"];
    const defaultsResponse = { status: 200, data: { recommendedModeDefaults: Object.fromEntries(modes.map((m) => [m, seven])),
      recommendedDefaultScope: Object.fromEntries(modes.map((m) => [m, "rig"])), defaultStaleRule: "re_confirm_on_long_gap" } };
    await rigModeCommand(deps(fakeClient({ defaultsResponse }).client)).parseAsync(["node", "rig", "defaults"]);
    const marked = logs.filter((l) => l.endsWith(`  ${MARK}`));
    expect(marked).toHaveLength(8 * 7); // seven fields for each of the eight modes
    for (const l of marked) expect(MARKED.some((f) => l.trimStart().startsWith(`${f}: `))).toBe(true);
    // The served default isn't a stored field, so it reads "(not applied)" without "stored".
    expect(logs).toContain("\ndefault stale rule: re_confirm_on_long_gap  (not applied)");
    expect(logs.filter((l) => l.trim() === LEGEND)).toHaveLength(1);
    logs.length = 0;
    await rigModeCommand(deps(fakeClient({ defaultsResponse }).client)).parseAsync(["node", "rig", "defaults", "--json"]);
    expect(logs.join("\n")).toBe(JSON.stringify(defaultsResponse.data, null, 2));
  });

  it("the set preview marks the eight fields of the proposed record, with one legend line; exit 2; --json is unchanged", async () => {
    await rigModeCommand(deps(fakeClient({}).client)).parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(2);
    expectMarked(logs);
    logs.length = 0;
    await rigModeCommand(deps(fakeClient({}).client)).parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--json"]);
    expect(process.exitCode).toBe(2);
    expect(logs.join("\n")).not.toContain("not applied");
  });

  it("set's help says the same on each of the eight options, and not on the others", () => {
    const set = rigModeCommand(deps(fakeClient({}).client)).commands.find((c) => c.name() === "set")!;
    const marked = set.options.filter((o) => (o.description ?? "").includes(`${MARK}: nothing in OpenRig acts on it yet`)).map((o) => o.long!.slice(2).replace(/-/g, "_"));
    expect(marked.sort()).toEqual([...MARKED].sort());
  });
});
