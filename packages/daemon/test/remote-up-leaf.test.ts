// OPR.0.4.4.11 — daemon-side remote single-rig leaf (FR-4).
//
// The leaf mirrors the CLI transport shape (bearer resolution + status
// classification vocabulary) — these tests pin the mirrored semantics and
// that failures surface the EXISTING classes, never a new taxonomy.

import { describe, it, expect } from "vitest";
import { remoteUpLeaf } from "../src/domain/topology/remote-up-leaf.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const HOST_ENV: HttpHostEntry = { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "VPS_B_TOKEN" };
const HOST_FILE: HttpHostEntry = { id: "vps-f", transport: "http", url: "http://vps-f:7433/", bearer_file: "/tok/f" };

function fetchStub(status: number, payload?: unknown, capture?: { url?: string; init?: RequestInit }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response(payload === undefined ? null : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("remoteUpLeaf — bearer resolution (mirrors CLI resolveRemoteBearer)", () => {
  it("bearer_env: missing/empty env is a permission-gate failure, no request sent", async () => {
    let called = false;
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[permission-gate]");
    expect(res.error).toContain("VPS_B_TOKEN");
    expect(called).toBe(false);
  });

  it("bearer_file: unreadable and empty files are permission-gate failures", async () => {
    const unreadable = await remoteUpLeaf({ sourceRef: "r" }, HOST_FILE, {
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(unreadable.error).toContain("[permission-gate]");
    expect(unreadable.error).toContain("not readable");

    const empty = await remoteUpLeaf({ sourceRef: "r" }, HOST_FILE, { readFile: () => "  " });
    expect(empty.error).toContain("[permission-gate]");
    expect(empty.error).toContain("is empty");
  });
});

describe("remoteUpLeaf — the shipped POST /api/up transport", () => {
  it("POSTs the body to {url}/api/up with the resolved bearer; 2xx is ok", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteUpLeaf(
      { sourceRef: "specs/factory.yaml", autoApprove: true },
      HOST_FILE, // trailing-slash url — normalized
      { readFile: () => "tok-123\n", fetchImpl: fetchStub(200, { status: "completed" }, capture) },
    );
    expect(res).toEqual({ ok: true });
    expect(capture.url).toBe("http://vps-f:7433/api/up");
    expect(capture.init?.method).toBe("POST");
    expect((capture.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-123");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ sourceRef: "specs/factory.yaml", autoApprove: true });
  });

  it("a 200 mixed bootstrap retains separate failed-seat identity and unprefixed reason", async () => {
    const res = await remoteUpLeaf(
      { sourceRef: "specs/factory.yaml" },
      HOST_FILE,
      { readFile: () => "tok-123\n", fetchImpl: fetchStub(200, {
        status: "partial", errors: ["pi launch failed: the runner exited (code 1)"],
        stages: [{ stage: "import_rig", status: "failed", detail: { nodes: [
          { logicalId: "main.sibling", status: "launched" },
          { logicalId: "main.seat", status: "failed", error: "pi launch failed: the runner exited (code 1)" },
        ] } }],
      }) },
    );
    expect(res).toEqual({
      ok: false,
      error: "[remote-command-failed] remote up on host vps-f answered HTTP 200 with status partial: main.seat: pi launch failed: the runner exited (code 1)",
    });
  });

  it("a 500 all-failed bootstrap retains errors array detail alongside HTTP status", async () => {
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(500, {
        status: "failed", stages: [{ stage: "import_rig", status: "failed", detail: { code: "launch_failed" } }],
        errors: ["All nodes failed to launch: main.seat: pi launch failed: the runner exited (code 1)"], warnings: [],
      }),
    });
    expect(res).toEqual({ ok: false, error: "[remote-command-failed] remote up on host vps-b failed: HTTP 500: All nodes failed to launch: main.seat: pi launch failed: the runner exited (code 1)" });
  });

  it("a 200 failed bootstrap reports the failed status even without error strings", async () => {
    const res = await remoteUpLeaf(
      { sourceRef: "specs/factory.yaml" },
      HOST_FILE,
      { readFile: () => "tok-123\n", fetchImpl: fetchStub(200, { status: "failed" }) },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("status failed");
  });

  it("401/403 classifies permission-gate; 4xx/5xx classifies remote-command-failed with the remote error text verbatim", async () => {
    const auth = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(401),
    });
    expect(auth.error).toContain("[permission-gate]");

    const failed = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(409, { error: "Already in progress for this source" }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("[remote-command-failed]");
    expect(failed.error).toContain("HTTP 409: Already in progress for this source");
  });

  it("R2-B1: a remote /api/up that NEVER settles returns a structured timeout failure instead of hanging the walk", async () => {
    // fetch stub honors AbortSignal exactly as real fetch does: never
    // resolves on its own, rejects with AbortError when the signal fires.
    let sawSignal = false;
    const neverSettling = ((url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        sawSignal = init?.signal instanceof AbortSignal;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      })) as typeof fetch;
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: neverSettling,
      timeoutMs: 25,
    });
    expect(sawSignal).toBe(true); // the abort path is actually wired to the request
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[remote-daemon-unreachable]");
    expect(res.error).toContain("timed out after 25ms");
    expect(res.error).toContain("vps-b");
  });

  it("G-R2B1-1: failure HEADERS followed by a NEVER-COMPLETING error body still returns the structured timeout (deadline stays armed through body parse)", async () => {
    // Guard's exact recipe: the response resolves with 500 headers and a
    // body stream that never produces bytes — Response.json() stays pending
    // forever unless the leaf bounds the parse itself.
    const stalledBody = ((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(new ReadableStream({ start() {} }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: stalledBody,
      timeoutMs: 25,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[remote-daemon-unreachable]");
    expect(res.error).toContain("timed out after 25ms");
    expect(res.error).toContain("response headers arrived (HTTP 500)");
    expect(res.error).toContain("vps-b");
  });

  it("G-R2B1-1: a COMPLETE error body within the deadline still yields the classified failure with the remote text verbatim (no regression)", async () => {
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(500, { error: "boom from remote" }),
      timeoutMs: 5_000,
    });
    expect(res.error).toContain("[remote-command-failed]");
    expect(res.error).toContain("HTTP 500: boom from remote");
  });

  it("R2-B1: the default deadline is the long-running rig-up budget, not the generic metadata default", async () => {
    const { REMOTE_UP_TIMEOUT_MS } = await import("../src/domain/topology/remote-up-leaf.js");
    expect(REMOTE_UP_TIMEOUT_MS).toBe(120_000);
  });

  it("network failure classifies remote-daemon-unreachable naming host + url", async () => {
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[remote-daemon-unreachable]");
    expect(res.error).toContain("vps-b");
    expect(res.error).toContain("ECONNREFUSED");
  });
});
