import { expect, it, vi } from "vitest";
import { attentionLines, checkKernelAttention, checkSeatAttention } from "../src/seat-attention.js";

type Reply = { status: number; data: unknown } | Error;
function client(routes: Record<string, Reply>) {
  const get = vi.fn(async (url: string) => {
    const reply = routes[url];
    if (reply instanceof Error) throw reply;
    return reply ?? { status: 404, data: { error: "not found" } };
  });
  return { get, client: { get } as unknown as Parameters<typeof checkSeatAttention>[0] };
}

const LOGIN = "Startup requires attention: Login expired · Please run /login";
const nodes = [
  // A live question the daemon serves (needs-input), with its own reason.
  { canonicalSessionName: "question@r", needsAttention: true, arbitratedNeedsInput: true, startupStatus: "ready", latestError: null,
    activityState: { activity: "needs_input", display: "needs input", needsInput: { count: 1, reason: "selection_prompt" }, decidedBy: "pane" } },
  // Broad attention that isn't a question: a ready seat started without required guidance.
  { canonicalSessionName: "guidance@r", needsAttention: true, arbitratedNeedsInput: false, startupStatus: "ready", latestError: null,
    startedWithoutRequired: ["/seat/AGENTS.md"] },
  // A failed start: a readiness timeout, as a dialog the startup check doesn't recognise leaves it.
  { canonicalSessionName: "failed@r", needsAttention: true, startupStatus: "failed",
    latestError: "Readiness timeout after 30s — harness did not become interactive: unknown" },
  // An expired sign-in at startup.
  { canonicalSessionName: "login@r", needsAttention: true, startupStatus: "attention_required", latestError: LOGIN },
  { canonicalSessionName: "fine@r", needsAttention: false, startupStatus: "ready", latestError: null },
  // An older daemon that serves no attention evidence.
  { canonicalSessionName: "old@r", startupStatus: "ready", latestError: null },
];

it("honours the daemon's needs-input precedence: a served 'no' beats a stale hook; the hook counts only without an answer", async () => {
  const precedence = [
    // Broad attention (missing guidance), the arbitrated answer is no question, and a stale needs_input hook remains.
    { canonicalSessionName: "stale@r", needsAttention: true, arbitratedNeedsInput: false, startupStatus: "ready", latestError: null,
      startedWithoutRequired: ["/seat/AGENTS.md"], agentActivity: { state: "needs_input", reason: "permission_prompt" } },
    // The same stale hook as the only reason: its reason isn't revived either.
    { canonicalSessionName: "staleonly@r", needsAttention: true, arbitratedNeedsInput: false, startupStatus: "ready", latestError: null,
      agentActivity: { state: "needs_input", reason: "permission_prompt" } },
    // No arbitrated answer: the hook decides, with its reason.
    { canonicalSessionName: "hook@r", needsAttention: true, arbitratedNeedsInput: null, startupStatus: "ready", latestError: null,
      agentActivity: { state: "needs_input", reason: "permission_prompt" } },
  ];
  const { client: c } = client({ "/api/ps": { status: 200, data: [{ rigId: "r1", rigName: "r" }] }, "/api/rigs/r1/nodes": { status: 200, data: [...nodes, ...precedence] } });
  const check = await checkSeatAttention(c, ["stale@r", "staleonly@r", "hook@r", "question@r"]);
  expect(check.attention).toEqual([
    { seat: "question@r", reason: "selection_prompt", waitingOnPerson: true },
    { seat: "stale@r", reason: "missing required AGENTS.md", waitingOnPerson: false },
    { seat: "staleonly@r", reason: "reason unavailable", waitingOnPerson: false },
    { seat: "hook@r", reason: "permission_prompt", waitingOnPerson: true },
  ]);
});

it("labels only a served live question as waiting on a person; the broad flag reads 'needs attention' with its reason", async () => {
  const { client: c } = client({ "/api/ps": { status: 200, data: [{ rigId: "r1", rigName: "r" }] }, "/api/rigs/r1/nodes": { status: 200, data: nodes } });
  const check = await checkSeatAttention(c, ["question@r", "guidance@r", "failed@r", "login@r", "fine@r", "old@r"]);
  expect(check.attention).toEqual([
    { seat: "question@r", reason: "selection_prompt", waitingOnPerson: true },
    { seat: "guidance@r", reason: "missing required AGENTS.md", waitingOnPerson: false },
    { seat: "failed@r", reason: "Readiness timeout after 30s — harness did not become interactive: unknown", waitingOnPerson: false },
    { seat: "login@r", reason: LOGIN, waitingOnPerson: false },
  ]);
  expect(check.unknown).toEqual([{ seat: "old@r", why: "the daemon served no attention evidence for it" }]);
  expect(attentionLines(check, "tile")).toEqual([
    "question@r is waiting on a person: selection_prompt. Answer it in its tile, or read it with: rig capture question@r",
    "guidance@r needs attention: missing required AGENTS.md. Look at it in its tile with: rig capture guidance@r",
    "failed@r needs attention: Readiness timeout after 30s — harness did not become interactive: unknown. Look at it in its tile with: rig capture failed@r",
    `login@r needs attention: ${LOGIN}. Look at it in its tile with: rig capture login@r`,
    "Couldn't check whether old@r needs attention: the daemon served no attention evidence for it.",
  ]);
});

it("an unreadable rig list leaves every seat unknown, not unflagged", async () => {
  const { client: c } = client({ "/api/ps": { status: 503, data: { error: "busy" } } });
  const check = await checkSeatAttention(c, ["a@r", "b@r"]);
  expect(check).toEqual({ attention: [], unknown: [
    { seat: "a@r", why: "the rig list couldn't be read (HTTP 503: busy)" },
    { seat: "b@r", why: "the rig list couldn't be read (HTTP 503: busy)" }] });
  expect(attentionLines(check, "pane")).toEqual(["Couldn't check whether a@r, b@r need attention: the rig list couldn't be read (HTTP 503: busy)."]);
});

it("one rig's failed read keeps the other rig's answers and leaves only its own seats unknown", async () => {
  const { client: c } = client({
    "/api/ps": { status: 200, data: [{ rigId: "a1", rigName: "a" }, { rigId: "b1", rigName: "b" }] },
    "/api/rigs/a1/nodes": { status: 200, data: [{ canonicalSessionName: "x@a", needsAttention: true, startupStatus: "attention_required", latestError: LOGIN }] },
    "/api/rigs/b1/nodes": new Error("socket hang up"),
  });
  const check = await checkSeatAttention(c, ["x@a", "y@b"]);
  expect(check.attention).toEqual([{ seat: "x@a", reason: LOGIN, waitingOnPerson: false }]);
  expect(check.unknown).toEqual([{ seat: "y@b", why: "b's seats couldn't be read (socket hang up)" }]);
});

it("a seat that isn't in this daemon's inventory is unknown, never 'fine'", async () => {
  const { client: c } = client({ "/api/ps": { status: 200, data: [{ rigId: "r1", rigName: "r" }] }, "/api/rigs/r1/nodes": { status: 200, data: [] } });
  const check = await checkSeatAttention(c, ["gone@r", "x@elsewhere"]);
  expect(check.unknown).toEqual([
    { seat: "gone@r", why: "not in r's seats on this daemon" },
    { seat: "x@elsewhere", why: "no rig named elsewhere on this daemon" }]);
});

it("finds attention for a seat whose rig name contains @", async () => {
  const { client: c } = client({
    "/api/ps": { status: 200, data: [{ rigId: "r1", rigName: "team@east" }] },
    "/api/rigs/r1/nodes": { status: 200, data: [
      { canonicalSessionName: "lead@team@east", needsAttention: true, startupStatus: "attention_required", latestError: LOGIN },
    ] },
  });
  expect(await checkSeatAttention(c, ["lead@team@east"])).toEqual({
    attention: [{ seat: "lead@team@east", reason: LOGIN, waitingOnPerson: false }], unknown: [],
  });
});

it("an unreadable kernel status is reported, not read as no held seat", async () => {
  const { client: c } = client({ "/api/kernel/status": { status: 503, data: { error: "kernel_boot_tracker_unavailable" } } });
  expect(await checkKernelAttention(c)).toEqual({ attention: [],
    unknown: [{ seat: "kernel", why: "the kernel status couldn't be read (HTTP 503: kernel_boot_tracker_unavailable)" }] });
});

it("keeps a long unknown list to one bounded line per reason", () => {
  const unknown = ["a", "b", "c", "d", "e", "f", "g"].map(name => ({ seat: `${name}@r`, why: "down" }));
  expect(attentionLines({ attention: [], unknown }, "pane"))
    .toEqual(["Couldn't check whether a@r, b@r, c@r, d@r, e@r and 2 more need attention: down."]);
});

it("a seat waiting on a person names its question, not an older recorded error; the needs-attention order is unchanged", async () => {
  const OLD = "Readiness timeout after 30s — harness did not become interactive: unknown";
  const seats = [
    // A live question, served by the arbitrated answer, on a seat that also carries an older startup error.
    { canonicalSessionName: "asked@r", needsAttention: true, arbitratedNeedsInput: true, startupStatus: "failed", latestError: OLD,
      activityState: { activity: "needs_input", display: "needs input", needsInput: { count: 1, reason: "permission_prompt" }, decidedBy: "hook" } },
    // A live question from the hook alone (no arbitrated answer), with the same older error.
    { canonicalSessionName: "hooked@r", needsAttention: true, arbitratedNeedsInput: null, startupStatus: "failed", latestError: OLD,
      agentActivity: { state: "needs_input", reason: "elicitation_dialog" } },
    // A live question whose reason isn't served: never the older error.
    { canonicalSessionName: "unsaid@r", needsAttention: true, arbitratedNeedsInput: true, startupStatus: "failed", latestError: OLD,
      activityState: { activity: "needs_input", display: "needs input", needsInput: { count: 1, reason: null }, decidedBy: "hook" } },
    // No question: the recorded error still leads.
    { canonicalSessionName: "broad@r", needsAttention: true, arbitratedNeedsInput: false, startupStatus: "failed", latestError: OLD,
      agentActivity: { state: "needs_input", reason: "permission_prompt" } },
  ];
  const { client: c } = client({ "/api/ps": { status: 200, data: [{ rigId: "r1", rigName: "r" }] }, "/api/rigs/r1/nodes": { status: 200, data: seats } });
  const check = await checkSeatAttention(c, ["asked@r", "hooked@r", "unsaid@r", "broad@r"]);
  expect(check.attention).toEqual([
    { seat: "asked@r", reason: "permission_prompt", waitingOnPerson: true },
    { seat: "hooked@r", reason: "elicitation_dialog", waitingOnPerson: true },
    { seat: "unsaid@r", reason: "reason unavailable", waitingOnPerson: true },
    { seat: "broad@r", reason: OLD, waitingOnPerson: false },
  ]);
  expect(attentionLines(check, "tile")[0]).toBe("asked@r is waiting on a person: permission_prompt. Answer it in its tile, or read it with: rig capture asked@r");
});
