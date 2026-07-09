// OPR.0.4.6.MH1 FR-5/FR-6 — THE narrow named host add/pair route family
// (arch B1 ruling, pin P1: host add + the pair handshake ONLY — no
// generic registry-write route exists, remove/edit stay out of scope;
// the daemon reader module stays read-only-forever).
//
// Surface map:
//   POST /api/hosts/pair-request      TARGET side, OPEN (pre-token
//                                     bootstrap — a pairing client has no
//                                     bearer yet by definition). Mints a
//                                     pairing code + the ONE human
//                                     approval moment (arch Ruling 2: a
//                                     human-routed queue item — the
//                                     shipped human-gate machinery IS the
//                                     approval surface).
//   GET  /api/hosts/pair-request/:id  TARGET side, OPEN. Polls the
//                                     approval item; hands the bearer
//                                     over ONCE on approval (single-shot,
//                                     then the pairing dies).
//   POST /api/hosts/add               LOCAL side, WRITE (bearer-gated
//                                     like every other daemon write).
//                                     The dashboard's manual-add seam —
//                                     delegates to the parity-pinned
//                                     writer twin (P3); never accepts
//                                     secret VALUES (P2).
//   POST /api/hosts/pair              LOCAL side, WRITE. The browser's
//                                     pair-client seam (B1: the UI's
//                                     write seam is its local daemon).
//   GET  /api/hosts/pair/:id          LOCAL side, WRITE-family. Stateless
//                                     pull-through poll of the target; on
//                                     approval persists token file +
//                                     registry entry via the writer twin.
//
// Deny/timeout persists NOTHING: pairing state is an in-memory map (a
// daemon restart kills pending pairs), the token file is deleted if the
// registry write fails, and the approval item simply goes stale.

import { Hono } from "hono";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { connect } from "node:net";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { getOpenRigHome } from "../openrig-compat.js";
import { addHostEntry } from "../domain/hosts/hosts-registry-writer.js";
import { defaultHostRegistryPath, loadHostRegistry, validateHostRegistry, type HostEntry } from "../domain/hosts/hosts-registry-reader.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { existsSync } from "node:fs";

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_HTTP_TIMEOUT_MS = 10_000;

// The human seat that receives pairing approvals (the shipped human-seat
// session grammar; renders in the target's attention/For-You surface).
const PAIR_APPROVAL_SEAT = "human-operator@kernel";
const PAIR_SOURCE_SESSION = "host-pair@kernel";

interface IssuedPair {
  code: string;
  qitemId: string;
  requester: string;
  createdAt: number;
}

interface ClientPair {
  url: string;
  remotePairId: string;
  code: string;
  hostId: string;
  createdAt: number;
}

// P2 — hosts.yaml carries bearer POINTERS only; any secret-value-shaped
// field on the add body is rejected loudly BEFORE any write.
const SECRET_SHAPED_FIELDS = ["bearer_value", "bearer_token", "token", "secret", "password"];

function deriveHostId(url: URL): string {
  const raw = url.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/\./g, "-");
  return raw.replace(/^-+|-+$/g, "") || "paired-host";
}

export function hostsRoutes(opts?: { bearerToken?: string | null }): Hono {
  const router = new Hono();
  const bearerToken = opts?.bearerToken ?? null;
  const issued = new Map<string, IssuedPair>();
  const clientPairs = new Map<string, ClientPair>();

  // Writes are gated exactly like mission-control writes: enforced when a
  // bearer is configured, pass-through on loopback/tailnet-trust daemons.
  const requireAuth = authBearerTokenMiddleware({ expectedToken: bearerToken });
  router.use("/add", requireAuth);
  router.use("/pair", requireAuth);
  router.use("/pair/:pairId", requireAuth);

  function getRepo(c: { get: (key: string) => unknown }): QueueRepository {
    return c.get("queueRepo" as never) as QueueRepository;
  }

  // ---------------------------------------------------------------------
  // Pointers-only READ for the dashboard host-config component (FR-5).
  // Not a write surface (P1's cap is the write family); rows mirror the
  // CLI's `rig host ls --json` additive shape: entry fields (bearer
  // POINTERS by construction) + `selected` + a bounded coarse `status`.
  // ---------------------------------------------------------------------

  function probeHost(host: HostEntry, timeoutMs = 1500): Promise<"reachable" | "unreachable" | "unknown"> {
    try {
      let target: string;
      let port: number;
      if (host.transport === "ssh") {
        target = host.target;
        port = 22;
      } else {
        const u = new URL(host.url);
        target = u.hostname;
        port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      }
      return new Promise((resolve) => {
        const sock = connect({ host: target, port, timeout: timeoutMs });
        sock.on("connect", () => { sock.destroy(); resolve("reachable"); });
        sock.on("timeout", () => { sock.destroy(); resolve("unreachable"); });
        sock.on("error", () => { sock.destroy(); resolve("unreachable"); });
      });
    } catch {
      return Promise.resolve("unknown");
    }
  }

  router.get("/", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    const selected = (store?.resolveOne("host.selected").value as string | undefined) ?? "local";
    const ownName = (store?.resolveOne("host.name").value as string | undefined) ?? "localhost";
    const registryPath = defaultHostRegistryPath();
    if (!existsSync(registryPath)) {
      return c.json({ ownName, selected, hosts: [] });
    }
    const loaded = loadHostRegistry(registryPath);
    if (!loaded.ok) {
      return c.json({ error: "invalid_registry", message: loaded.error }, 500);
    }
    const statuses = await Promise.all(loaded.registry.hosts.map((h) => probeHost(h)));
    return c.json({
      ownName,
      selected,
      hosts: loaded.registry.hosts.map((h, i) => ({ ...h, selected: h.id === selected, status: statuses[i] })),
    });
  });

  // ---------------------------------------------------------------------
  // TARGET side: issuance.
  // ---------------------------------------------------------------------

  router.post("/pair-request", async (c) => {
    if (!bearerToken) {
      // A tokenless daemon has nothing to issue. Loud + structured; the
      // fix is named (no silent success, no token minting machinery —
      // the one-static-bearer model is the shipped auth surface).
      return c.json({
        error: "pair_target_no_bearer",
        message: "this daemon runs without OPENRIG_AUTH_BEARER_TOKEN; pairing has no credential to issue. Set OPENRIG_AUTH_BEARER_TOKEN on the target daemon and retry.",
      }, 409);
    }
    const body = (await c.req.json<{ requester?: string }>().catch(() => ({}))) as { requester?: string };
    const requester = (body.requester ?? "").trim() || "unknown requester";
    const pairId = randomUUID();
    const code = String(randomInt(100000, 1000000));

    let qitemId: string;
    try {
      const item = await getRepo(c).create({
        sourceSession: PAIR_SOURCE_SESSION,
        destinationSession: PAIR_APPROVAL_SEAT,
        tier: "human-gate",
        summary: `Host pairing request ${code} from ${requester}`,
        evidenceRef: `pair-request:${pairId}`,
        body: [
          `A remote operator (${requester}) is asking to pair with this host.`,
          `Pairing code: ${code} — confirm it matches the code shown on the requesting side.`,
          `APPROVE: rig queue update <this-qitem-id> --state done --closure-reason no-follow-on`,
          `DENY:    rig queue update <this-qitem-id> --state denied`,
          `Approval hands this daemon's bearer token to the requester (full API access).`,
          `This request expires ${Math.round(PAIR_TTL_MS / 60000)} minutes after creation; expiry persists nothing.`,
        ].join("\n"),
      });
      qitemId = item.qitemId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "pair_approval_item_failed", message }, 500);
    }

    issued.set(pairId, { code, qitemId, requester, createdAt: Date.now() });
    return c.json({ pairId, code, approvalQitemId: qitemId });
  });

  router.get("/pair-request/:pairId", (c) => {
    const pairId = c.req.param("pairId");
    const rec = issued.get(pairId);
    if (!rec) return c.json({ error: "pair_unknown", message: "unknown or already-consumed pairing request" }, 404);

    if (Date.now() - rec.createdAt > PAIR_TTL_MS) {
      issued.delete(pairId);
      return c.json({ status: "expired" });
    }
    const item = getRepo(c).getById(rec.qitemId);
    const state = item?.state ?? "pending";
    if (state === "done") {
      // Single-shot handover: the first approved read consumes the pairing.
      issued.delete(pairId);
      return c.json({ status: "approved", token: bearerToken });
    }
    if (state === "denied" || state === "canceled" || state === "failed") {
      issued.delete(pairId);
      return c.json({ status: "denied" });
    }
    return c.json({ status: "pending", code: rec.code });
  });

  // ---------------------------------------------------------------------
  // LOCAL side: the dashboard's add + pair-client seams.
  // ---------------------------------------------------------------------

  router.post("/add", async (c) => {
    const body = (await c.req.json<Record<string, unknown>>().catch(() => null));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_host_entry", message: "body must be a host entry object" }, 400);
    }
    const secretField = SECRET_SHAPED_FIELDS.find((f) => f in body);
    if (secretField) {
      return c.json({
        error: "no_secret_values",
        message: `field '${secretField}' looks like a secret VALUE — hosts.yaml carries bearer POINTERS only (bearer_env / bearer_file). Nothing was written.`,
      }, 400);
    }
    const res = addHostEntry(body);
    if (!res.ok) {
      return c.json({ error: "invalid_host_entry", message: res.error }, 400);
    }
    return c.json({ ok: true, entry: res.entry, path: res.path });
  });

  router.post("/pair", async (c) => {
    const body = (await c.req.json<{ url?: string; id?: string; requester?: string }>().catch(() => ({}))) as { url?: string; id?: string; requester?: string };
    const rawUrl = (body.url ?? "").trim();
    if (!rawUrl) return c.json({ error: "pair_url_required", message: "body.url is required (the target daemon's address)" }, 400);
    let target: URL;
    try {
      target = new URL(/^https?:\/\//.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
    } catch {
      return c.json({ error: "pair_url_invalid", message: `'${rawUrl}' is not a usable address` }, 400);
    }
    const targetBase = target.origin;

    // B1 fixback (guard code-review 2026-07-07): PREFLIGHT before the
    // target is contacted. The candidate entry runs the SAME validation
    // contract the add will use (duplicate/reserved ids, invalid existing
    // registry fail here — before any approval item is minted on the
    // target), and a pre-existing token file is pre-existing CREDENTIAL
    // STATE: rejected, never overwritten, never deleted by this pairing.
    const hostId = (body.id ?? "").trim() || deriveHostId(target);
    const tokenPath = join(getOpenRigHome(), "secrets", `host-${hostId}.token`);
    {
      const registryPath = defaultHostRegistryPath();
      let existing: HostEntry[] = [];
      if (existsSync(registryPath)) {
        const loaded = loadHostRegistry(registryPath);
        if (!loaded.ok) {
          return c.json({ error: "invalid_registry", message: loaded.error }, 400);
        }
        existing = loaded.registry.hosts;
      }
      const preflight = validateHostRegistry(
        { hosts: [...existing, { id: hostId, transport: "http", url: targetBase, bearer_file: tokenPath }] },
        registryPath,
      );
      if (!preflight.ok) {
        return c.json({ error: "invalid_host_entry", message: preflight.error }, 400);
      }
      if (existsSync(tokenPath)) {
        return c.json({
          error: "pair_token_path_exists",
          message: `a credential file already exists at ${tokenPath} — pre-existing credential state is never overwritten. Pair with a different id, or remove the file if it is stale.`,
        }, 409);
      }
    }

    let remote: { pairId?: string; code?: string; error?: string; message?: string };
    let status: number;
    try {
      const res = await fetch(`${targetBase}/api/hosts/pair-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requester: body.requester ?? `dashboard@${getOpenRigHome()}` }),
        signal: AbortSignal.timeout(PAIR_HTTP_TIMEOUT_MS),
      });
      status = res.status;
      remote = (await res.json().catch(() => ({}))) as typeof remote;
    } catch (err) {
      return c.json({ error: "pair_target_unreachable", message: `could not reach ${targetBase}: ${(err as Error).message}` }, 502);
    }
    if (status !== 200 || !remote.pairId || !remote.code) {
      return c.json({
        error: remote.error ?? "pair_request_failed",
        message: remote.message ?? `target responded HTTP ${status}`,
      }, 502);
    }

    const localPairId = randomUUID();
    clientPairs.set(localPairId, {
      url: targetBase,
      remotePairId: remote.pairId,
      code: remote.code,
      hostId,
      createdAt: Date.now(),
    });
    return c.json({ pairId: localPairId, code: remote.code, target: targetBase });
  });

  router.get("/pair/:pairId", async (c) => {
    const rec = clientPairs.get(c.req.param("pairId"));
    if (!rec) return c.json({ error: "pair_unknown", message: "unknown or already-completed pairing" }, 404);
    if (Date.now() - rec.createdAt > PAIR_TTL_MS) {
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ status: "expired" });
    }

    let remote: { status?: string; token?: string };
    try {
      const res = await fetch(`${rec.url}/api/hosts/pair-request/${rec.remotePairId}`, {
        signal: AbortSignal.timeout(PAIR_HTTP_TIMEOUT_MS),
      });
      remote = (await res.json().catch(() => ({}))) as typeof remote;
    } catch (err) {
      return c.json({ error: "pair_target_unreachable", message: `could not reach ${rec.url}: ${(err as Error).message}` }, 502);
    }

    if (remote.status === "pending" || remote.status === undefined) {
      return c.json({ status: "pending", code: rec.code });
    }
    if (remote.status !== "approved" || !remote.token) {
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ status: remote.status === "expired" ? "expired" : "denied" });
    }

    // Approved: persist the token via EXCLUSIVE CREATE (open flag "wx",
    // 0600 — rev1-r2 B3: check-then-rename had a window where a
    // concurrent same-id pair could clobber the winner's file and then
    // delete it on its own add failure; "wx" is atomic at the
    // filesystem, so creation SUCCESS is the proof of ownership the
    // cleanup relies on), then the registry entry through the ONE write
    // contract. addHostEntry re-validates authoritatively.
    const secretsDir = join(getOpenRigHome(), "secrets");
    const tokenPath = join(secretsDir, `host-${rec.hostId}.token`);
    try {
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(tokenPath, `${remote.token}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        clientPairs.delete(c.req.param("pairId"));
        return c.json({
          error: "pair_token_path_exists",
          message: `a credential file appeared at ${tokenPath} during pairing — refusing to overwrite it; nothing was persisted by this pairing.`,
        }, 409);
      }
      return c.json({ error: "pair_token_write_failed", message: (err as Error).message }, 500);
    }
    const added = addHostEntry({
      id: rec.hostId,
      transport: "http",
      url: rec.url,
      bearer_file: tokenPath,
      notes: `paired ${new Date().toISOString().slice(0, 10)}`,
    });
    if (!added.ok) {
      rmSync(tokenPath, { force: true });
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ error: "invalid_host_entry", message: added.error }, 400);
    }
    clientPairs.delete(c.req.param("pairId"));
    return c.json({ status: "approved", entry: added.entry });
  });

  return router;
}
