import { describe, it, expect, vi, afterEach } from "vitest";
import { DaemonClient, remoteDaemonClient, senderIdentityHeaders, SENDER_IDENTITY_HEADER } from "../src/client.js";

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch;
}

describe("DaemonClient header merge", () => {
  it("post() merges options.headers into the request", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async (_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers as Record<string, string>),
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    await client.post("/test", { data: 1 }, {
      headers: { Authorization: "Bearer my-token" },
    });

    expect(capturedHeaders["Authorization"]).toBe("Bearer my-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
  });

  it("get() merges options.headers into the request", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async (_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>),
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    await client.get("/test", { headers: { Authorization: "Bearer token-2" } });

    expect(capturedHeaders["Authorization"]).toBe("Bearer token-2");
  });

  it("post() without options.headers works normally", async () => {
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async () => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    const res = await client.post("/test", { data: 1 });
    expect(res.status).toBe(200);
  });
});

// ── P18 sender-provenance: the seat identity is derived from the env ONCE at the transport chokepoint ──
describe("DaemonClient sender-identity header (P18)", () => {
  const savedSession = process.env.OPENRIG_SESSION_NAME;
  const savedRigged = process.env.RIGGED_SESSION_NAME;
  afterEach(() => {
    if (savedSession === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = savedSession;
    if (savedRigged === undefined) delete process.env.RIGGED_SESSION_NAME; else process.env.RIGGED_SESSION_NAME = savedRigged;
  });

  const captureHeaders = () => {
    const box: { headers: Record<string, string> } = { headers: {} };
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: mockFetch(async (_url, init) => {
        box.headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    });
    return { client, box };
  };

  it("derives the identity header from OPENRIG_SESSION_NAME", () => {
    process.env.OPENRIG_SESSION_NAME = "dev50-driver@rig";
    expect(senderIdentityHeaders()).toEqual({ [SENDER_IDENTITY_HEADER]: "dev50-driver@rig" });
  });

  it("emits NO header when the seat env is absent (the daemon refuses; the CLI never fabricates)", () => {
    delete process.env.OPENRIG_SESSION_NAME;
    delete process.env.RIGGED_SESSION_NAME;
    expect(senderIdentityHeaders()).toEqual({});
  });

  it("stamps the seat identity on EVERY request at the ONE transport chokepoint", async () => {
    process.env.OPENRIG_SESSION_NAME = "alice@rig";
    const { client, box } = captureHeaders();
    await client.post("/inbox/drop", { destinationSession: "bob@rig", body: "x" });
    expect(box.headers[SENDER_IDENTITY_HEADER]).toBe("alice@rig");
  });

  it("the transport identity is AUTHORITATIVE — a caller cannot override it via options.headers", async () => {
    process.env.OPENRIG_SESSION_NAME = "alice@rig";
    const { client, box } = captureHeaders();
    await client.post("/inbox/drop", { body: "x" }, { headers: { [SENDER_IDENTITY_HEADER]: "mallory@rig" } });
    expect(box.headers[SENDER_IDENTITY_HEADER]).toBe("alice@rig"); // the seat env wins, not the caller's claim
  });
});

// ── A4 — HTTP-path origin-triple carry: a REMOTE-targeting client stamps the ORIGIN triple so the
//    remote daemon's wrapPaneEnvelope renders the ORIGIN host, not the destination's. Identity stays
//    DERIVED (env session + THIS host's selfHostId), never caller-supplied. These lock the composition
//    mechanism; they would fail against the pre-A4 stamp (which ignored the arg and emitted 2-part). ──
describe("A4 — origin-triple carry (senderIdentityHeaders + remoteDaemonClient)", () => {
  const savedSession = process.env.OPENRIG_SESSION_NAME;
  const savedRigged = process.env.RIGGED_SESSION_NAME;
  afterEach(() => {
    if (savedSession === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = savedSession;
    if (savedRigged === undefined) delete process.env.RIGGED_SESSION_NAME; else process.env.RIGGED_SESSION_NAME = savedRigged;
  });

  it("2-part session + originSelfHostId ⇒ composes the ORIGIN triple member@rig@selfHostId", () => {
    process.env.OPENRIG_SESSION_NAME = "dev50@v-rig";
    expect(senderIdentityHeaders("mm2-openrig1")).toEqual({ [SENDER_IDENTITY_HEADER]: "dev50@v-rig@mm2-openrig1" });
  });

  it("pin 6 — an already-3-part origin is preserved VERBATIM, never re-stamped with this host", () => {
    process.env.OPENRIG_SESSION_NAME = "dev50@v-rig@origin-host";
    expect(senderIdentityHeaders("relay-host")).toEqual({ [SENDER_IDENTITY_HEADER]: "dev50@v-rig@origin-host" });
  });

  it("pin 4 — no originSelfHostId (LOCAL client) ⇒ 2-part, byte-identical to today", () => {
    process.env.OPENRIG_SESSION_NAME = "dev50@v-rig";
    expect(senderIdentityHeaders()).toEqual({ [SENDER_IDENTITY_HEADER]: "dev50@v-rig" });
  });

  it("pin 5 — absent selfHostId (fetchSelfHostId fail-open ⇒ empty) ⇒ 2-part, no new failure mode", () => {
    process.env.OPENRIG_SESSION_NAME = "dev50@v-rig";
    expect(senderIdentityHeaders("")).toEqual({ [SENDER_IDENTITY_HEADER]: "dev50@v-rig" });
  });

  it("no session ⇒ NO header regardless of originSelfHostId (the daemon refuses; CLI never fabricates)", () => {
    delete process.env.OPENRIG_SESSION_NAME;
    delete process.env.RIGGED_SESSION_NAME;
    expect(senderIdentityHeaders("mm2-openrig1")).toEqual({});
  });

  it("remoteDaemonClient ⇒ the constructed client stamps the TRIPLE on the wire (via the injected factory)", async () => {
    process.env.OPENRIG_SESSION_NAME = "dev50@v-rig";
    const box: { headers: Record<string, string> } = { headers: {} };
    const factory = (url: string) => new DaemonClient(url, {
      fetchImpl: (async (_u: string, init: RequestInit) => {
        box.headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const client = remoteDaemonClient(factory, "http://vps-b:7433", "mm2-openrig1");
    expect(client.originSelfHostId).toBe("mm2-openrig1");
    await client.post("/api/transport/broadcast", { text: "hi" });
    expect(box.headers[SENDER_IDENTITY_HEADER]).toBe("dev50@v-rig@mm2-openrig1"); // ORIGIN triple on the wire
  });

  it("a LOCAL client (not built via remoteDaemonClient) stamps 2-part on the wire — the scope stays narrow", async () => {
    process.env.OPENRIG_SESSION_NAME = "dev50@v-rig";
    const box: { headers: Record<string, string> } = { headers: {} };
    const client = new DaemonClient("http://localhost:7433", {
      fetchImpl: (async (_u: string, init: RequestInit) => {
        box.headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    expect(client.originSelfHostId).toBeUndefined();
    await client.post("/api/transport/send", { text: "hi" });
    expect(box.headers[SENDER_IDENTITY_HEADER]).toBe("dev50@v-rig"); // unchanged — no triple on the local path
  });
});
