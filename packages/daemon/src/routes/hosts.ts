// OPR.0.4.6.MH1 FR-5/FR-6 — THE narrow named host add/pair route family
// (arch B1 ruling, pin P1: named verbs ONLY — no generic REST registry-write
// route exists; edit/remove joined the named family as the bounded #2128
// extension (maintainer-approved boundary: id+transport fixed on edit,
// secret VALUES refused, invalid registry never clobbered, remove deletes
// only the registry entry); the daemon reader module stays read-only-forever).
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
//   POST /api/hosts/update            LOCAL side, WRITE (bearer-gated like
//                                     /add). Edit ONE entry through the
//                                     same writer twin: id+transport FIXED,
//                                     unknown fields fail loud, empty string
//                                     clears an optional field.
//   POST /api/hosts/remove            LOCAL side, WRITE (bearer-gated like
//                                     /add). Deletes ONLY the registry entry
//                                     — no credential files, no learned
//                                     identity, no selection changes.
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
import { execFile } from "node:child_process";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { getOpenRigHome } from "../openrig-compat.js";
import { addHostEntry, updateHostEntry, removeHostEntry } from "../domain/hosts/hosts-registry-writer.js";
import { defaultHostRegistryPath, loadHostRegistry, validateHostRegistry, type HostEntry, type SshHostEntry } from "../domain/hosts/hosts-registry-reader.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { UNATTRIBUTED_ACTOR, type QueueItem, type QueueRepository } from "../domain/queue-repository.js";
import { KERNEL_OPERATOR_SESSION } from "../domain/policies/mode-scheduled-end.js";
import type { HumanQuestion } from "../domain/human-questions.js";
import { PAIR_SOURCE_SESSION } from "../domain/hosts/pairing-ask.js";
import { existsSync } from "node:fs";
import { loadHumanRegistry, type LoadResult } from "../domain/gateway/human-registry.js";
import { resolveDefaultPerson } from "../domain/gateway/participants.js";

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_PRUNE_GRACE_MS = 60 * 60 * 1000;
/** The longest a pairing request stays open: the 32-bit millisecond limit Node timers have, which the requester's own
 *  wait (`rig host pair --timeout`) is already clamped to. */
const MAX_PAIR_TTL_MS = 2_147_483_647;
/** An expired request becomes eligible for pruning (at the next issuance) this long after it expires, so a waiting
 *  client can still read "expired"; a terminal poll consumes it sooner. With the default life, that's the hour after
 *  creation it always was. */
const PAIR_EXPIRED_KEPT_MS = PAIR_PRUNE_GRACE_MS - PAIR_TTL_MS;

/** How long a pairing request stays open: as long as its requester waits (`timeoutMs`, sent by `rig host pair`),
 *  else the default 10 minutes for a requester that doesn't say. */
function pairTtlMs(requested: unknown): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(Math.round(requested), MAX_PAIR_TTL_MS) : PAIR_TTL_MS;
}

/** A pairing request's life as its approval states it: exact, in the largest whole unit (only a life that isn't whole
 *  seconds, which `rig host pair` never sends below its ceiling, is said as about). */
function describePairTtl(ms: number): string {
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms % 86_400_000 === 0 && ms >= 2 * 86_400_000) return count(ms / 86_400_000, "day");
  if (ms % 3_600_000 === 0 && ms >= 2 * 3_600_000) return count(ms / 3_600_000, "hour");
  if (ms % 60_000 === 0) return count(ms / 60_000, "minute");
  if (ms % 1000 === 0) return count(ms / 1000, "second");
  return `about ${count(Math.round(ms / 1000), "second")}`;
}
const PAIR_HTTP_TIMEOUT_MS = 10_000;

/** The pairing request's one question. A person answers it with a click or in their own words. Where an agent reads
 *  answers (the request's owner), both are context it acts on with `rig host approve|deny`; on an agent-free host the
 *  person's click is the decision. */
const PAIR_QUESTION_ID = "pair";
const PAIR_APPROVE = "approve";
function pairQuestion(requester: string, code: string): HumanQuestion[] {
  return [{ id: PAIR_QUESTION_ID, question: `Pair ${requester} (code ${code}) with this host?`, options: [
    { id: PAIR_APPROVE, label: "Approve: hand this host's bearer token to the requester" },
    { id: "deny", label: "Deny" },
  ] }];
}

/** A close that refuses the request: a denied, canceled or failed state; a done close with any reason but no-follow-on
 *  (Steering's Deny and Drop, an agent seat's `--closure-reason denied`); or a done close that carries no answer and
 *  doesn't name Approve (an agent seat's bare close, a bare Approve verb). A close that carries the person's answer, a
 *  click or their words, refuses nothing by itself. */
function pairClosedRefusing(item: QueueItem | null): boolean {
  if (!item) return false;
  if (item.state === "denied" || item.state === "canceled" || item.state === "failed") return true;
  return item.state === "done" && (item.closureReason !== "no-follow-on"
    || (item.humanAnswers?.[PAIR_QUESTION_ID] == null && item.resolution?.trim() !== PAIR_APPROVE));
}

/** An agent seat's close that names Approve on a request nobody has answered (`rig queue update <id> --state done
 *  --closure-reason no-follow-on --resolution approve`, the option-id answer ACP rows use). */
function pairClosedApproving(item: QueueItem | null): boolean {
  return !!item && item.state === "done" && item.closureReason === "no-follow-on" && item.resolution?.trim() === PAIR_APPROVE
    && item.humanAnswers?.[PAIR_QUESTION_ID] == null;
}

interface IssuedPair {
  code: string;
  qitemId: string;
  requester: string;
  createdAt: number;
  expiresAt: number;
  /** The person asked. */
  person: string;
  /** The seat that reads the person's answer and decides (the kernel operator); null when this host is agent-free, where
   *  the person's own click, or `rig host approve|deny` in a terminal, decides. */
  owner: string | null;
  /** The explicit decision (`rig host approve|deny`), made once. */
  decision?: { approve: boolean; by: string };
  /** The person has been told their answer reached the owner. */
  receipted?: boolean;
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

export function hostsRoutes(opts?: { bearerToken?: string | null; humanRegistry?: () => LoadResult }): Hono {
  const router = new Hono();
  const bearerToken = opts?.bearerToken ?? null;
  const issued = new Map<string, IssuedPair>();
  const clientPairs = new Map<string, ClientPair>();

  // Writes are gated exactly like mission-control writes: enforced when a
  // bearer is configured, pass-through on loopback/tailnet-trust daemons.
  const requireAuth = authBearerTokenMiddleware({ expectedToken: bearerToken });
  router.use("/add", requireAuth);
  router.use("/update", requireAuth);
  router.use("/remove", requireAuth);
  router.use("/pair", requireAuth);
  router.use("/pair/:pairId", requireAuth);
  router.use("/pair-decision", requireAuth);

  function getRepo(c: { get: (key: string) => unknown }): QueueRepository {
    return c.get("queueRepo" as never) as QueueRepository;
  }

  /** Who reads a person's answer to a pairing request here: the kernel operator, when this host has one (a session, in any
   *  state) and the queue takes rows to it; else nobody, and the request is agent-free. A stopped operator still owns it:
   *  the person's answer waits in its queue, and the person is told it isn't running. */
  function pairOwner(c: { get: (key: string) => unknown }): string | null {
    const repo = getRepo(c);
    try {
      const configured = !!repo.db.prepare("SELECT 1 FROM sessions WHERE session_name = ? LIMIT 1").get(KERNEL_OPERATOR_SESSION);
      return configured && repo.acceptsDestination(KERNEL_OPERATOR_SESSION) ? KERNEL_OPERATOR_SESSION : null;
    } catch { return null; }
  }

  /** Whether the owner's session is running now; null when that can't be read. */
  function ownerRunning(c: { get: (key: string) => unknown }, owner: string): boolean | null {
    try { return !!getRepo(c).db.prepare("SELECT 1 FROM sessions WHERE session_name = ? AND status = 'running' LIMIT 1").get(owner); }
    catch { return null; }
  }

  /** Ask the person to decide a pairing request: its approval row, with the one question. `lead` opens the body when it's
   *  asked again. Returns the row's id. */
  async function askPerson(c: { get: (key: string) => unknown }, pairId: string, rec: IssuedPair, lead: string[] = []): Promise<string> {
    const { owner, code, requester } = rec;
    const item = await getRepo(c).create({
      // The owner asks, so the person's answer, a click or their words, comes back to it as an ordinary reply. An
      // agent-free request keeps the synthetic source, and its answers stay on the request (createHumanAnswer).
      sourceSession: owner ?? PAIR_SOURCE_SESSION,
      destinationSession: rec.person,
      tier: "human-gate",
      // An approval that expires: worth an alert, not only a place on Steering.
      humanAlert: true,
      summary: `Host pairing request ${code} from ${requester}`,
      evidenceRef: `pair-request:${pairId}`,
      humanQuestions: pairQuestion(requester, code),
      body: [
        ...lead,
        `A remote operator (${requester}) is asking to pair with this host. "${requester}" is how the requesting machine describes itself.`,
        `Pairing code: ${code} — confirm it matches the code shown on the requesting side.`,
        ...(owner ? [
          `Answer with Approve or Deny, or in your own words. ${owner} reads your answer and acts on it: a clear yes pairs, a clear no denies, and if your answer isn't clear it asks you back.`,
          ...(ownerRunning(c, owner) === false ? [`${owner} isn't running right now, so your answer waits until it starts; nothing is granted or denied meanwhile. To decide sooner, in a terminal on this host: rig host approve ${code}, or rig host deny ${code}.`] : []),
          `For ${owner}: when the person's answer to this request comes back, act on it. A clear yes or an Approve click: rig host approve ${code}. A clear no or a Deny click: rig host deny ${code}. Don't ask them to confirm a clear answer. If their words are unclear or conditional, ask them back, naming pairing code ${code}, and act on what they answer.`,
        ] : [
          `Answer with Approve or Deny. No agent reads answers on this host (it has no ${KERNEL_OPERATOR_SESSION}), so typed words are kept but don't decide it, and you're asked again.`,
          `To decide in a terminal on this host: rig host approve ${code}, or rig host deny ${code}.`,
        ]),
        `Approval hands this daemon's bearer token to the requester (full API access).`,
        `This request expires ${describePairTtl(rec.expiresAt - rec.createdAt)} after creation, at ${new Date(rec.expiresAt).toISOString().slice(0, 19).replace("T", " ")} UTC; expiry persists nothing.`,
      ].join("\n"),
    });
    return item.qitemId;
  }

  /** A decided or expired request: close its approval row if nobody has answered it, so it leaves the person's feed, and
   *  tell the person the result. The decision stands whatever this manages: each step is best effort. An expired
   *  request the person never answered is closed without a message. */
  async function settlePairRequest(c: { get: (key: string) => unknown }, rec: IssuedPair, outcome: "approved" | "denied" | "expired", by: string, handedNow = false): Promise<void> {
    const repo = getRepo(c);
    const item = rec.qitemId ? repo.getById(rec.qitemId) : null;
    const open = item?.state === "pending" || item?.state === "in-progress" || item?.state === "blocked";
    try {
      if (open) await repo.update(outcome === "expired"
        ? { qitemId: rec.qitemId, actorSession: PAIR_SOURCE_SESSION, state: "canceled", transitionNote: `pairing request ${rec.code} expired undecided` }
        : { qitemId: rec.qitemId, actorSession: by, state: "done", closureReason: "no-follow-on", resolution: `pairing ${outcome} by ${by}`,
            transitionNote: `pairing request ${rec.code} ${outcome} by ${by}` });
    } catch { /* the decision stands */ }
    if (outcome === "expired" && open) return;
    // An expired request whose answer still sits unclaimed in the owner's queue was never read: say so.
    let unread = false;
    if (outcome === "expired" && rec.owner && rec.qitemId) {
      try { unread = !!repo.db.prepare("SELECT 1 FROM queue_items WHERE reply_to = ? AND destination_session = ? AND state = 'pending' LIMIT 1").get(rec.qitemId, rec.owner); } catch { /* can't tell */ }
    }
    const what = outcome === "approved" ? `approved by ${by}. ${handedNow ? "This host's token was handed to the requesting machine." : "This host's token is handed over when the requesting machine next checks, if it's still waiting."}`
      : outcome === "denied" ? `denied by ${by}. Nothing was handed over.`
      : `expired before it was decided${unread ? `: ${rec.owner} never picked up your answer, so nobody read it` : ""}. Nothing was handed over; the requester can run rig host pair again.`;
    try {
      await repo.create({ sourceSession: rec.owner ?? PAIR_SOURCE_SESSION, destinationSession: rec.person, humanIntent: "update",
        summary: `Pairing ${rec.code} from ${rec.requester}: ${outcome}`, body: `Pairing request ${rec.code} from ${rec.requester}: ${what}` });
    } catch { /* the decision stands */ }
  }

  // ---------------------------------------------------------------------
  // Pointers-only READ for the dashboard host-config component (FR-5).
  // Not a write surface (P1's cap is the write family); rows mirror the
  // CLI's `rig host ls --json` additive shape: entry fields (bearer
  // POINTERS by construction) + `selected` + a bounded coarse `status`.
  // ---------------------------------------------------------------------

  // Where ssh would connect for this host, from `ssh -G` (reads ssh config, no connection); null when
  // ssh can't resolve it or a ProxyJump/ProxyCommand sits in between. Twin of the CLI's resolveSshEndpoint.
  function resolveSshEndpoint(host: SshHostEntry, timeoutMs: number): Promise<{ hostname: string; port: number } | null> {
    const args = [...(host.user ? ["-l", host.user] : []), "-G", host.target];
    return new Promise((resolve) => {
      execFile("ssh", args, { timeout: timeoutMs }, (error, stdout) => {
        if (error) return resolve(null);
        const conf = new Map(stdout.split("\n").map((line) => {
          const i = line.indexOf(" ");
          return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()] as const;
        }));
        const proxied = ["proxyjump", "proxycommand"].some((k) => (conf.get(k) ?? "none") !== "none");
        const hostname = conf.get("hostname");
        const port = Number(conf.get("port"));
        resolve(hostname && Number.isInteger(port) && !proxied ? { hostname, port } : null);
      });
    });
  }

  async function probeHost(host: HostEntry, timeoutMs = 1500): Promise<"reachable" | "unreachable" | "unknown"> {
    try {
      let target: string;
      let port: number;
      if (host.transport === "ssh") {
        const endpoint = await resolveSshEndpoint(host, timeoutMs);
        if (!endpoint) return "unknown";
        ({ hostname: target, port } = endpoint);
      } else {
        const u = new URL(host.url);
        // WHATWG keeps the brackets on an IPv6 hostname; net.connect wants the bare address.
        target = u.hostname.replace(/^\[(.*)\]$/, "$1");
        port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      }
      return new Promise((resolve) => {
        const sock = connect({ host: target, port, timeout: timeoutMs });
        sock.on("connect", () => { sock.destroy(); resolve("reachable"); });
        sock.on("timeout", () => { sock.destroy(); resolve("unreachable"); });
        sock.on("error", () => { sock.destroy(); resolve("unreachable"); });
      });
    } catch {
      return "unknown";
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
    const body = (await c.req.json<{ requester?: string; human?: string; timeoutMs?: number }>().catch(() => ({}))) as { requester?: string; human?: string; timeoutMs?: number };
    const registry = (opts?.humanRegistry ?? loadHumanRegistry)();
    if (!registry.ok) return c.json({ error: "pair_human_registry_unavailable", message: registry.error }, 409);
    // Named, or else the default person (chosen, or the only one); never the first of several.
    const fallback = body.human ? null : resolveDefaultPerson(registry.entities).person;
    const humans = body.human ? registry.entities.filter((human) => human.address === body.human) : fallback ? [fallback] : [];
    if (humans.length !== 1) return c.json({
      error: "pair_human_required", addresses: registry.entities.map((human) => human.address),
      message: "Pair approval needs one registered human, or a default when several exist. Inspect rig gateway participants --json; select --human <entityId>@external, or choose a default with rig gateway default <id>. No approval row was created.",
    }, 409);

    // Prune stale issued pairs past the grace window (keep recently expired entries
    // so waiting polling clients receive { status: "expired" } instead of 404 pair_unknown).
    const now = Date.now();
    for (const [id, rec] of issued.entries()) {
      if (now > rec.expiresAt + PAIR_EXPIRED_KEPT_MS) {
        issued.delete(id);
      }
    }
    const rawRequester = (typeof body.requester === "string" ? body.requester : "").trim();
    const requester = rawRequester.slice(0, 128).replace(/[\r\n\t\u2028\u2029]/g, " ").trim() || "unknown requester";
    const pairId = randomUUID();
    const code = String(randomInt(100000, 1000000));

    // Retain the request while its approval item is being created; remove it on failure.
    const ttlMs = pairTtlMs(body.timeoutMs);
    const createdAt = Date.now();
    const rec: IssuedPair = { code, qitemId: "", requester, createdAt, expiresAt: createdAt + ttlMs, person: humans[0]!.address, owner: pairOwner(c) };
    issued.set(pairId, rec);

    let qitemId: string;
    try {
      qitemId = await askPerson(c, pairId, rec);
      rec.qitemId = qitemId;
    } catch (err) {
      issued.delete(pairId);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "pair_approval_item_failed", message }, 500);
    }

    return c.json({ pairId, code, approvalQitemId: qitemId });
  });

  router.get("/pair-request/:pairId", async (c) => {
    const pairId = c.req.param("pairId");
    const rec = issued.get(pairId);
    if (!rec) return c.json({ error: "pair_unknown", message: "unknown or already-consumed pairing request" }, 404);

    if (Date.now() > rec.expiresAt) {
      issued.delete(pairId);
      await settlePairRequest(c, rec, "expired", PAIR_SOURCE_SESSION);
      return c.json({ status: "expired" });
    }
    // Approval hands over this daemon's bearer token, so only an explicit decision does: `rig host approve`, an agent
    // seat's close naming Approve, or, on an agent-free host, the person's own Approve click. A person's answer arriving
    // decides nothing where an agent reads it: the request stays pending until the agent acts or it expires.
    const item = rec.qitemId ? getRepo(c).getById(rec.qitemId) : null;
    const answer = item?.humanAnswers?.[PAIR_QUESTION_ID];
    // Agent-free, typed words close the request and its buttons, and nothing reads them: ask again, keeping their words on
    // the closed row, so the person still has a way to decide. Words never deny.
    if (!rec.owner && !rec.decision && typeof answer === "object" && answer?.kind === "typed-reply" && !pairClosedRefusing(item)) {
      const closed = rec.qitemId;
      rec.qitemId = ""; // one ask at a time: a poll meanwhile reads pending
      const words = answer.text.replace(/\s+/g, " ").trim();
      try {
        rec.qitemId = await askPerson(c, pairId, rec, [
          `You wrote "${words.length > 200 ? `${words.slice(0, 200)}…` : words}" in reply to this request. Your words are kept, and they didn't deny anything: no agent on this host reads typed answers, so please decide with Approve or Deny here.`,
        ]);
      } catch { rec.qitemId = closed; } // the next poll asks again
      return c.json({ status: "pending", code: rec.code });
    }
    const approved = rec.decision ? rec.decision.approve
      : pairClosedRefusing(item) || (!rec.owner && answer === "deny") ? false
      : pairClosedApproving(item) || (!rec.owner && answer === PAIR_APPROVE) ? true
      : null;
    if (approved === null) {
      // Where the owner reads answers, the person's answer arriving decides nothing: tell them once that it was received,
      // and whether the owner is running to read it.
      if (rec.owner && !rec.receipted && answer != null) {
        rec.receipted = true;
        const said = typeof answer === "string" ? `your ${answer === PAIR_APPROVE ? "Approve" : answer === "deny" ? "Deny" : answer} choice`
          : `"${answer.text.replace(/\s+/g, " ").trim().slice(0, 200)}"`;
        const reading = ownerRunning(c, rec.owner) === false
          ? `${rec.owner} isn't running, so nobody has read it yet. Nothing is granted or denied until it acts, or the request expires at ${new Date(rec.expiresAt).toISOString().slice(0, 19).replace("T", " ")} UTC. To decide now, in a terminal on this host: rig host approve ${rec.code}, or rig host deny ${rec.code}.`
          : `${rec.owner} reads it and acts on it. You'll see the result here, or a question if your answer isn't clear.`;
        try {
          await getRepo(c).create({ sourceSession: rec.owner, destinationSession: rec.person, humanIntent: "update",
            summary: `Pairing ${rec.code} from ${rec.requester}: answer received`,
            body: `Received ${said} on pairing request ${rec.code} from ${rec.requester}. ${reading}` });
        } catch { /* the answer is kept either way */ }
      }
      return c.json({ status: "pending", code: rec.code });
    }
    // Single-shot: the first decided read consumes the pairing.
    issued.delete(pairId);
    // A decision from a close (the person's click on an agent-free host, an agent seat's close) is told to the person
    // here; `rig host approve|deny` told them when it decided.
    if (!rec.decision) {
      const by = (item && getRepo(c).closingTransition(item.qitemId, item.state)?.actorSession) || rec.person;
      await settlePairRequest(c, rec, approved ? "approved" : "denied", by, true);
    }
    return c.json(approved ? { status: "approved", token: bearerToken } : { status: "denied" });
  });

  // ---------------------------------------------------------------------
  // TARGET side: the explicit decision (`rig host approve|deny`), from the request's owner agent or a person at a
  // terminal on this host. Write-gated like every other daemon write.
  // ---------------------------------------------------------------------

  router.post("/pair-decision", async (c) => {
    const body = (await c.req.json<{ request?: unknown; decision?: unknown }>().catch(() => ({}))) as { request?: unknown; decision?: unknown };
    const decision = body.decision;
    const ref = typeof body.request === "string" ? body.request.trim() : "";
    if ((decision !== "approve" && decision !== "deny") || !ref) {
      return c.json({ error: "pair_decision_invalid", message: "Name the request (its pairing code or approval row id) and decision: approve or deny." }, 400);
    }
    const matches = [...issued.entries()].filter(([, r]) => r.qitemId === ref || r.code === ref);
    if (matches.length === 0) {
      return c.json({ error: "pair_request_unknown", message: `No open pairing request ${ref} on this host: it's unknown, already handed over or denied, or the daemon restarted since it was made. Nothing was decided.` }, 404);
    }
    if (matches.length > 1) {
      return c.json({ error: "pair_request_ambiguous", message: `Pairing code ${ref} matches ${matches.length} open requests; name one by its approval row: ${matches.map(([, r]) => r.qitemId).join(", ")}. Nothing was decided.` }, 409);
    }
    const [, rec] = matches[0]!;
    if (Date.now() > rec.expiresAt) {
      return c.json({ error: "pair_request_expired", message: `Pairing request ${rec.code} from ${rec.requester} expired at ${new Date(rec.expiresAt).toISOString().slice(0, 19).replace("T", " ")} UTC. Nothing was decided; the requester can run rig host pair again.` }, 409);
    }
    if (rec.decision) {
      return c.json({ error: "pair_request_decided", decision: rec.decision.approve ? "approve" : "deny", by: rec.decision.by,
        message: `Pairing request ${rec.code} was already ${rec.decision.approve ? "approved" : "denied"} by ${rec.decision.by}; that stands.` }, 409);
    }
    // The acting seat, or the person at this host's terminal (no seat), recorded as a direct human action.
    const by = c.req.header("X-OpenRig-Session")?.trim() || UNATTRIBUTED_ACTOR;
    rec.decision = { approve: decision === "approve", by };
    await settlePairRequest(c, rec, decision === "approve" ? "approved" : "denied", by);
    return c.json({ ok: true, decision, code: rec.code, requester: rec.requester, by });
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

  // ------------------------------------------------------------------------
  // OPR.0.4.6.MH1 FR-1 extension (issue #2128): the two named write verbs
  // beside /add — POST /update and POST /remove, both bearer-gated exactly
  // like /add (no new auth surface) and both refusing secret-shaped fields
  // with add's own no_secret_values check BEFORE any write. Update keeps the
  // host's id and transport FIXED (the boundary's first rule), refuses
  // unknown fields and invalid values through the SAME writer+validator as
  // add, and never clobbers an invalid registry. Remove deletes ONLY the
  // registry entry — no credential files, no learned identity, no selection
  // changes. Both responses report wasSelected, read exactly like the GET
  // route reads it, so a dashboard can tell its user when the selection now
  // names a removed or just-edited entry; the pointer itself is never
  // rewritten here.
  // ------------------------------------------------------------------------

  function selectedHost(c: { get: (key: string) => unknown }): string {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    return (store?.resolveOne("host.selected").value as string | undefined) ?? "local";
  }

  router.post("/update", async (c) => {
    const body = (await c.req.json<Record<string, unknown>>().catch(() => null));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_host_entry", message: "body must be a host entry object with at least { id }" }, 400);
    }
    const secretField = SECRET_SHAPED_FIELDS.find((f) => f in body);
    if (secretField) {
      return c.json({
        error: "no_secret_values",
        message: `field '${secretField}' looks like a secret VALUE — hosts.yaml carries bearer POINTERS only (bearer_env / bearer_file). Nothing was written.`,
      }, 400);
    }
    const id = body["id"];
    if (typeof id !== "string" || !id.trim()) {
      return c.json({ error: "host_id_required", message: "body.id must be a non-empty host id to update" }, 400);
    }
    const { id: _id, ...changes } = body;
    const res = updateHostEntry(id.trim(), changes);
    if (!res.ok) {
      return c.json({ error: "invalid_host_entry", message: res.error }, 400);
    }
    return c.json({ ok: true, entry: res.entry, previous: res.previous, path: res.path, wasSelected: id.trim() === selectedHost(c) });
  });

  router.post("/remove", async (c) => {
    const body = (await c.req.json<Record<string, unknown>>().catch(() => null));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_host_entry", message: "body must be an object with { id }" }, 400);
    }
    const secretField = SECRET_SHAPED_FIELDS.find((f) => f in body);
    if (secretField) {
      return c.json({
        error: "no_secret_values",
        message: `field '${secretField}' looks like a secret VALUE — hosts.yaml carries bearer POINTERS only (bearer_env / bearer_file). Nothing was written.`,
      }, 400);
    }
    const id = body.id;
    if (typeof id !== "string" || !id.trim()) {
      return c.json({ error: "host_id_required", message: "body.id must be a non-empty host id to remove" }, 400);
    }
    const res = removeHostEntry(id.trim());
    if (!res.ok) {
      return c.json({ error: "invalid_host_entry", message: res.error }, 400);
    }
    return c.json({ ok: true, entry: res.entry, path: res.path, wasSelected: id.trim() === selectedHost(c) });
  });

  router.post("/pair", async (c) => {
    const body = (await c.req.json<{ url?: string; id?: string; requester?: string; human?: string }>().catch(() => ({}))) as { url?: string; id?: string; requester?: string; human?: string };
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

    // Prune stale client pairs past the grace window (keep recently expired entries
    // so waiting polling clients receive { status: "expired" } instead of 404 pair_unknown).
    const now = Date.now();
    for (const [id, rec] of clientPairs.entries()) {
      if (now - rec.createdAt > PAIR_PRUNE_GRACE_MS) {
        clientPairs.delete(id);
      }
    }
    const localPairId = randomUUID();
    // Retain the operation while contacting the target; remove it on failure.
    clientPairs.set(localPairId, {
      url: targetBase,
      remotePairId: "",
      code: "",
      hostId,
      createdAt: Date.now(),
    });

    let remote: { pairId?: string; code?: string; error?: string; message?: string };
    let status: number;
    try {
      const res = await fetch(`${targetBase}/api/hosts/pair-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requester: typeof body.requester === "string" && body.requester.trim()
            ? body.requester.trim()
            : `dashboard@${getOpenRigHome()}`,
          ...(body.human ? { human: body.human } : {}),
        }),
        signal: AbortSignal.timeout(PAIR_HTTP_TIMEOUT_MS),
      });
      status = res.status;
      remote = (await res.json().catch(() => ({}))) as typeof remote;
    } catch (err) {
      clientPairs.delete(localPairId);
      return c.json({ error: "pair_target_unreachable", message: `could not reach ${targetBase}: ${(err as Error).message}` }, 502);
    }
    if (status !== 200 || !remote.pairId || !remote.code) {
      clientPairs.delete(localPairId);
      return c.json({
        error: remote.error ?? "pair_request_failed",
        message: remote.message ?? `target responded HTTP ${status}`,
      }, 502);
    }

    const clientRec = clientPairs.get(localPairId);
    if (clientRec) {
      clientRec.remotePairId = remote.pairId;
      clientRec.code = remote.code;
    }
    return c.json({ pairId: localPairId, code: remote.code, target: targetBase });
  });

  router.get("/pair/:pairId", async (c) => {
    const rec = clientPairs.get(c.req.param("pairId"));
    if (!rec) return c.json({ error: "pair_unknown", message: "unknown or already-completed pairing" }, 404);
    if (Date.now() - rec.createdAt > PAIR_TTL_MS) {
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ status: "expired" });
    }
    if (!rec.remotePairId) {
      return c.json({ status: "pending", code: rec.code });
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
