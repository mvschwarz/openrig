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
import { rigPolicyCommand, __test__, type RigPolicyDeps } from "../src/commands/rig-policy.js";
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
      if (path.startsWith("/api/rig-policy/defaults")) {
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
      if (path.startsWith("/api/rig-policy/effective")) {
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

function deps(client: unknown): RigPolicyDeps {
  return {
    lifecycleDeps: {} as LifecycleDeps,
    clientFactory: () => client as ReturnType<RigPolicyDeps["clientFactory"]>,
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
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(2);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(0);
    expect(logs.join("\n")).toContain("Proposed binding (restate-and-confirm — NOT applied)");
    expect(logs.join("\n")).toContain("debug");
  });

  it("WITHOUT --confirm + --json: ok:false + confirm_required:true", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
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
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm"]);
    expect(process.exitCode).toBeUndefined();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe("/api/rig-policy/bindings/qitem/q-1");
    const putBody = puts[0]!.body as { mode: string; record: Record<string, string> };
    expect(putBody.mode).toBe("debug");
    // BLOCKING-1: record must NOT carry `mode` inside.
    expect(putBody.record.mode).toBeUndefined();
    expect(putBody.record.scope).toBe("qitem");
    expect(logs.join("\n")).toContain("Operating in `debug` mode at `qitem:q-1`");
  });

  it("HG-4: --bearer forwards Authorization: Bearer <token>", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm", "--bearer", "operator-token"]);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.options?.headers?.Authorization).toBe("Bearer operator-token");
  });

  it("HG-7 mode:<name> prefix: works the same as bare word", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "mode:focus", "--qualifier", "ws-1", "--confirm"]);
    const put = calls.find((c) => c.method === "PUT")!;
    const body = put.body as { mode: string; record: Record<string, string> };
    expect(body.mode).toBe("focus");
    expect(body.record.scope).toBe("workstream");
    expect(put.path).toBe("/api/rig-policy/bindings/workstream/ws-1");
  });

  it("rejects unknown mode with exit=1; daemon NOT called", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "banana", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Unknown mode/);
  });

  it("forwards 401 from daemon with operator hint", async () => {
    const { client } = fakeClient({ putResponse: { status: 401, data: { error: "unauthorized" } } });
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm"]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/Unauthorized/);
  });
});

describe("rig policy effective — Q6 unknown_posture surfaced", () => {
  it("prints 'unknown_posture' when daemon returns null effective", async () => {
    const { client } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "effective", "--qitem", "q-1"]);
    expect(logs.join("\n")).toContain("unknown_posture");
  });
});

describe("rig policy cite — convention citation rules", () => {
  it("prints unknown_posture fallback when no binding resolves", async () => {
    const { client } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "cite", "--qitem", "q-1"]);
    expect(logs.join("\n")).toContain("without an explicit");
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
    const cmd = rigPolicyCommand(deps(client));
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
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--qualifier", "unexpected"]);
    expect(process.exitCode).toBe(1);
    // BLOCKING re-verify-2 evidence: zero daemon calls of any kind.
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Global-host bindings cannot carry a qualifier/);
    expect(logs.join("\n")).not.toContain("Proposed binding");
  });

  it("WITH --confirm: exits 1; daemon NOT contacted (no GET /defaults, no PUT)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--qualifier", "unexpected", "--confirm"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Global-host bindings cannot carry a qualifier/);
  });

  it("WITH --json: emits ok:false + qualifier_invalid; zero daemon calls", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--qualifier", "unexpected", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("qualifier_invalid");
  });

  it("Explicit non-global scope missing qualifier ALSO preflighted: zero daemon calls", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--scope", "rig"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/requires a qualifier/);
  });

  it("Explicit unknown scope rejected locally: zero daemon calls", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--scope", "banana", "--qualifier", "q-1"]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Unknown scope 'banana'/);
  });

  it("Positive: set sleep --scope global_host --confirm → PUT /bindings/global_host (one GET /defaults + one PUT)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "sleep", "--scope", "global_host", "--confirm"]);
    expect(process.exitCode).toBeUndefined();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/rig-policy/bindings/global_host");
  });

  it("Implicit-default-scope path STILL fetches defaults (no preflight rejection): set debug without --scope reaches GET /defaults + PUT", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "set", "debug", "--qualifier", "q-1", "--confirm"]);
    expect(process.exitCode).toBeUndefined();
    const gets = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/rig-policy/defaults"));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(gets.length).toBe(1);
    expect(puts.length).toBe(1);
    expect(puts[0]!.path).toBe("/api/rig-policy/bindings/qitem/q-1");
  });

  it("Implicit-default-scope path still rejects missing qualifier when default scope needs one (no PUT)", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
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
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "qitem", "q-1", "--bearer", "operator-token"]);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/rig-policy/bindings/qitem/q-1");
    expect(del.options?.headers?.Authorization).toBe("Bearer operator-token");
  });

  it("rejects unknown scope with exit=1; daemon NOT called", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "banana", "x"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  // BLOCKING re-verify (qitem-20260518044650): `unset global_host
  // <qualifier>` must NOT silently drop the qualifier and delete the
  // host row. Same shape as set; same shared helper.
  it("BLOCKING re-verify: unset global_host unexpected → exits 1; daemon NOT called", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "global_host", "unexpected"]);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(errs.join("\n")).toMatch(/Global-host bindings cannot carry a qualifier/);
  });

  it("Positive: unset global_host (no qualifier) targets /bindings/global_host", async () => {
    const { client, calls } = fakeClient({});
    const cmd = rigPolicyCommand(deps(client));
    await cmd.parseAsync(["node", "rig", "unset", "global_host"]);
    expect(process.exitCode).toBeUndefined();
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/rig-policy/bindings/global_host");
  });
});
