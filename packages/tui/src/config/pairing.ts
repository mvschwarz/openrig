import { escapeControlChars, listItem, sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { Action } from "../types.js";

/** One open pairing request on this host, as GET /api/hosts/pair-requests serves it. */
export interface PairRequest {
  code: string;
  requester: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "unknown";
  person: string;
  /** The agent that reads the person's answer; null when none does here (`noReader` says why). */
  owner: string | null;
  noReader?: string;
  /** The person's answer kept on the request, which decided nothing by itself: their choice, or the start of their words. */
  answer?: { by: string; choice?: string; words?: string };
  /** The request's approval row, which names it for a decision. */
  approvalQitemId: string | null;
}
export interface PairRequestsRead { requests: PairRequest[]; readAt: string }
type PairDecisionAct = Extract<Action, { type: "act"; act: "pair-decision" }>;

/** The requester's self-description, as the daemon shows it: quoted and escaped, the unauthenticated requesting
 *  machine's own words, never text that reads as this page's own. */
function quotedRequester(requester: string): string {
  return JSON.stringify(requester);
}

function hhmm(iso: string): string {
  return /T(\d\d:\d\d)/.exec(iso)?.[1] ?? iso;
}

/** Instance & work's pairing requests: each open request, who reads the person's answer, and Approve and Deny as direct
 *  controls (as `rig host approve|deny`). `focus` (an approval row) marks the request the Feed opened this page on; when
 *  that request is no longer listed, the page says so above the list. */
export function pairingLines(read: PairRequestsRead | null | undefined, focus: string | null | undefined, width: number): ContentLine[] {
  const lines: ContentLine[] = [sectionRule("Pairing requests", width)];
  if (!read) {
    return [...lines, ...wrapDetailLines([{ text: "Pairing requests unavailable: this host's list couldn't be read. Refresh, or run rig host approve <code> or rig host deny <code> here." }], width)];
  }
  const focused = focus ? read.requests.find((r) => r.approvalQitemId === focus) : undefined;
  const text: ContentLine[] = [];
  if (focus && !focused) text.push({ text: "The request you opened isn't open here anymore: it expired, was collected or decided, or the daemon restarted. Open requests are below." });
  if (!read.requests.length) text.push({ text: "No open pairing requests on this host." });
  for (const r of read.requests) {
    const mark = r === focused ? "> " : "  ";
    text.push({ text: `${mark}${r.code} · ${quotedRequester(r.requester)} · expires ${hhmm(r.expiresAt)} UTC · ${r.status}` });
    text.push({ text: `    ${r.owner ? `${r.owner} reads ${r.person}'s answer and decides` : `No agent reads answers here: ${r.noReader ?? "reason unreported"}`}` });
    if (r.answer) {
      const a = r.answer;
      text.push({ text: a.choice === "deny" ? `    ${a.by} answered Deny (kept). Approve overrides it.`
        : a.choice === "approve" ? `    ${a.by} answered Approve (kept). Deny overrides it.`
        : a.choice ? `    ${a.by} chose ${a.choice} (kept).`
        : a.words ? `    ${a.by} wrote "${a.words}" (kept).` : `    ${a.by} replied with no words (kept).` });
    }
    if (r.status === "pending" && r.approvalQitemId) {
      const act = (decision: "approve" | "deny"): Action => ({ type: "act", act: "pair-decision", request: r.approvalQitemId!, decision, code: r.code, requester: r.requester });
      text.push(listItem(`Approve ${r.code}: hand this host's bearer token to ${quotedRequester(r.requester)}`, act("approve"), 4),
        listItem(`Deny ${r.code}`, act("deny"), 4));
    } else if (r.status === "unknown") {
      text.push({ text: "    Its decision couldn't be read here: refresh before deciding." });
    }
  }
  text.push({ text: `Read at ${read.readAt}. Approve and Deny decide directly, as rig host approve|deny does; the request is read again first.` });
  return [...lines, ...wrapDetailLines(text, width)];
}

export interface PairDecisionClient {
  pairRequests(): Promise<{ requests: PairRequest[] }>;
  pairDecision(request: string, decision: "approve" | "deny"): Promise<{ status: number; body: Record<string, unknown> | null }>;
}

/** Decide one pairing request from the settings page: read it again first, so a request that's no longer open, or already
 *  decided, is reported and nothing is sent; then decide. When the decision can't be confirmed (a timeout or a lost
 *  connection), the outcome is unknown: it reads the request again and says what that shows, never deciding a second time. */
export async function decidePairRequest(client: PairDecisionClient, act: PairDecisionAct): Promise<string> {
  // The notice is printed on the status line, which nothing else cleans: the requester is a host not yet paired, and the
  // daemon's own messages can quote it, so the whole notice is escaped as the list's lines are.
  return escapeControlChars(await decideOnce(client, act));
}

async function decideOnce(client: PairDecisionClient, act: PairDecisionAct): Promise<string> {
  const what = `Pairing request ${act.code} from ${quotedRequester(act.requester)}`;
  const find = async () => (await client.pairRequests()).requests.find((r) => r.approvalQitemId === act.request);
  let before: PairRequest | undefined;
  try { before = await find(); } catch (error) {
    return `${what}: it couldn't be read again first (${(error as Error).message}), so nothing was sent. Refresh and try again.`;
  }
  if (!before) return `${what} isn't open here anymore (expired, collected or decided, or the daemon restarted). Nothing was sent.`;
  if (before.status === "unknown") return `${what}: its decision couldn't be read, so nothing was sent. Refresh and try again.`;
  if (before.status !== "pending") return `${what} was already ${before.status}; that stands. Nothing was sent.`;
  // Not confirmed either way: the decision may have been recorded. Read it again and say what that shows; never resend.
  const unknown = async (why: string): Promise<string> => {
    const head = `${what}: the ${act.decision === "approve" ? "Approve" : "Deny"} wasn't confirmed (${why}), so its outcome is unknown.`;
    try {
      const after = await find();
      return `${head} Read again: ${!after ? "it's no longer open here." : after.status === "pending" ? "still pending, with no decision recorded. Check again before deciding again." : `${after.status}.`}`;
    } catch (again) {
      return `${head} Reading it again failed too (${(again as Error).message}): refresh before deciding again.`;
    }
  };
  let result: Awaited<ReturnType<PairDecisionClient["pairDecision"]>>;
  try { result = await client.pairDecision(act.request, act.decision); } catch (error) {
    return unknown((error as Error).message);
  }
  // The daemon's plain refusals decide nothing: no bearer (401), a bad request (400), gone (404), decided or expired (409).
  // Any other failure, such as a server error, can follow a recorded decision, so its outcome is unknown.
  if (result.status !== 401 && ![400, 404, 409].includes(result.status) && (result.status < 200 || result.status >= 300)) {
    return unknown(`HTTP ${result.status}${typeof result.body?.error === "string" ? ` ${result.body.error}` : ""}`);
  }
  if (result.status === 401) return `${what}: this daemon refused the decision without its operator bearer token, so nothing was decided. Start the TUI with OPENRIG_AUTH_BEARER_TOKEN set to the token this daemon runs with, or run rig host ${act.decision} ${act.code} here.`;
  if (result.status < 200 || result.status >= 300) {
    const message = typeof result.body?.message === "string" ? result.body.message : `HTTP ${result.status}${typeof result.body?.error === "string" ? ` (${result.body.error})` : ""}`;
    return `${what}: not decided here. ${message}`;
  }
  return act.decision === "approve"
    ? `Approved ${what}: the requester collects this host's bearer token at its next check.`
    : `Denied ${what}: nothing is handed over.`;
}
