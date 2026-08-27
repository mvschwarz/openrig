// V0.3.1 slice 23 founder-walk-queue-handoff-envelope.
//
// Daemon-side renderer for the email-style envelope the recipient's
// tmux pane shows when a peer sends them a message (`rig send`) or
// when a queue handoff/create nudges them. Wrapping the body with
// From / To / --- / body / --- / ↩ Reply gives both a sender
// identity and a copy-pasteable reply hint.
//
// PARITY CONTRACT with CLI:
// `packages/cli/src/commands/send.ts :: wrapSendBody` must produce
// BYTE-IDENTICAL output for the same inputs. The two implementations
// live in separate packages because cli + daemon don't cross-import
// today; the contract is enforced via:
//   1. Identical function body (visual diff)
//   2. `packages/daemon/test/pane-envelope.test.ts` mirroring the
//      assertions in `packages/cli/test/send-header.test.ts`
//   3. Live integration parity (HG-5): a queue handoff nudge and a
//      rig send to the same destination render byte-identical
//      output except for the body content
// If you update this function, update wrapSendBody in lockstep.

const SENDER_FALLBACK = "<unknown sender>";

/** Send/broadcast header envelope metadata (ruling 03c35295). The ENVELOPE carries the machine truth;
 *  the rendered header is a PROJECTION of it. Both twins (this + cli wrapSendBody) share this shape. */
export interface EnvelopeScope {
  /** dm = a single recipient; multi = a named recipient set; rig-broadcast/topology = scaled broadcasts. */
  kind: "dm" | "multi" | "rig-broadcast" | "topology";
  /** multi: the full recipient list (WHO got it). */
  recipients?: string[];
  /** rig-broadcast: the rig + seat count (the anti-storm scale). */
  rig?: string;
  seats?: number;
}
export interface EnvelopeMeta {
  /** ISO-8601, stamped ONCE at the transport layer at send-time. Render READS it; never re-derives
   *  (the 51-02 wall-clock-in-projection forbids computing it at read). */
  stampISO?: string;
  scope?: EnvelopeScope;
  /** GHOST-STAGE (g): the SENDER's atom-B occupant generation-uuid, resolved ONCE at the transport
   *  layer at send-time (same seam as stampISO). Lets a recipient attribute a delayed lifecycle
   *  message to the composing generation rather than inheriting it as the current occupant's.
   *  ABSENT ⇒ UNKNOWN (cross-host --from relay whose sender isn't local, or pre-tenure daemon) —
   *  the render omits it, never forges a generation. Render is a PROJECTION of this machine truth. */
  genUuid?: string;
}

/** The To-line projection + anti-storm scale (header-alone distinguishability, ruling pin 2). */
export function renderToLine(recipient: string, scope?: EnvelopeScope): string {
  if (!scope || scope.kind === "dm") return `To: ${recipient}`;
  if (scope.kind === "multi") return `To: ${(scope.recipients ?? [recipient]).join(", ")}`;
  if (scope.kind === "rig-broadcast") return `To: broadcast to ${scope.rig} (${scope.seats} seats)`;
  return "To: broadcast to topology";
}

/** Short glanceable stamp MM-DD HH:MMZ (12 chars) from the transport ISO (ruling pin 3). */
export function renderShortStamp(stampISO: string): string {
  return `${stampISO.slice(5, 7)}-${stampISO.slice(8, 10)} ${stampISO.slice(11, 16)}Z`;
}

/** GHOST-STAGE (h): a delivery is FLAGGED as delayed only once its compose→write gap crosses this
 *  threshold. 10s is clearly beyond idle-wait jitter — unambiguously "this waited" — so sub-threshold
 *  gaps render nothing (measured-telemetry: a flag, not sub-second noise). ONE named constant. */
export const DELIVERED_LATENCY_FLAG_MS = 10_000;

/** GHOST-STAGE (h): append the relative delivered-latency segment to the Sent: line at the WRITE
 *  moment (daemon-side only — the CLI composes, it never delivers to a pane, so there is no compose
 *  twin for this). `deltaMs` is (write-time − the Sent: stampISO): how long the message waited since
 *  it was composed. Only a genuinely delayed delivery (deltaMs ≥ DELIVERED_LATENCY_FLAG_MS) renders a
 *  segment; whole seconds, in the g gen-suffix style (' · delivered +12s'). sent-ISO + this delta
 *  gives absolute delivered time for free. CONTAINMENT (the ' · delivered ' twin of g's ' · gen '):
 *  the segment is appended ONLY to the Sent: line WITHIN the header block (before the first "\n---\n"),
 *  so a body line that itself contains ' · delivered …' can never be mistaken for the real stamp. No
 *  Sent: line (unenveloped / meta-less send) ⇒ returned unchanged. */
export function appendDeliveredSegment(envelope: string, deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < DELIVERED_LATENCY_FLAG_MS) return envelope;
  const marker = "\n---\n";
  const idx = envelope.indexOf(marker);
  const headerBlock = idx === -1 ? envelope : envelope.slice(0, idx);
  const rest = idx === -1 ? "" : envelope.slice(idx);
  const lines = headerBlock.split("\n");
  const sentIdx = lines.findIndex((l) => l.startsWith("Sent: "));
  if (sentIdx === -1) return envelope;
  lines[sentIdx] = `${lines[sentIdx]} · delivered +${Math.floor(deltaMs / 1000)}s`;
  return lines.join("\n") + rest;
}

/** Wrap a tmux-pane body with the canonical From/To envelope. The
 *  recipient pane sees both the sender's identity and a reply hint.
 *  Cross-host nudges should NOT double-wrap: the remote rig wraps
 *  when it processes the same command (matches `wrapSendBody`'s
 *  cross-host carve-out).
 *  `meta` (ruling 03c35295) projects the recipient scale + a transport-stamped timestamp; ABSENT ⇒
 *  today's exact DM envelope (backward-compat until every sender surface threads it). */
export function wrapPaneEnvelope(
  sender: string | undefined,
  recipient: string,
  body: string,
  meta?: EnvelopeMeta,
): string {
  // FOUNDER ROOT INVARIANT (2026-08-27, supersedes 51-09 incr 3 / ruling cb19867f Q2
  // always-suffix): the sender renders EXACTLY AS RECEIVED. A local sender is the bare
  // member@rig (the reply hint is copy-paste-usable locally); a cross-host arrival already
  // carries its origin triple from the forwarding boundary and rides verbatim — the wrapper
  // never appends this host's id to anything.
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  const header = [`From: ${senderLabel}`, renderToLine(recipient, meta?.scope)];
  if (meta?.stampISO) {
    // GHOST-STAGE (g): the sender's occupant generation rides the Sent: line as a short suffix
    // (first8 of the uuid — discriminates at per-node scale; the ledger keeps the full uuid for
    // exact joins). ABSENT gen ⇒ OMIT the suffix entirely — never "gen unknown", never a forged
    // value. The suffix is positionally bound to the Sent: header line (a body line, always after
    // the first "---", can contain " · gen …" but cannot inject a Sent: line — containment).
    const genSuffix = meta.genUuid && meta.genUuid.length > 0 ? ` · gen ${meta.genUuid.slice(0, 8)}` : "";
    header.push(`Sent: ${renderShortStamp(meta.stampISO)}${genSuffix}`);
  }
  return [...header, "---", body, "---", `↩ Reply: rig send ${senderLabel} "..."`].join("\n");
}
