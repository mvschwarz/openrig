import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const [group, home, sourceRoot] = process.argv.slice(2);
const moduleRoot = sourceRoot ? join(sourceRoot, "packages/daemon/src") : fileURLToPath(new URL("../../dist/", import.meta.url));
const load = (path) => import(pathToFileURL(join(moduleRoot, path + (sourceRoot ? ".ts" : ".js"))));
const { subsystemSlackDeliver } = await load("domain/gateway/slack/slack-delivery");
const { SeenStore } = await load("domain/gateway/slack/state-store");
const { fetchRecentMessageTexts } = await load("domain/gateway/slack/slack-api");
const { reconcileToken } = await load("domain/gateway/slack/message");
const scenarios = group === "recovery" ? ["root", "thread", "found-first", "absent"] : ["api-error", "cursor-loop", "missing-cursor", "page-bound", "deadline"];
const results = [];
for (const scenario of scenarios) {
  const posted = [];
  let postRequests = 0;
  let reads = 0;
  let deadlineProbed = false;
  const queried = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/api/chat.postMessage") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        postRequests++;
        if (postRequests !== 1 || scenario !== "absent") posted.push({ text: JSON.parse(body).text, ts: "1000.1" });
        if (postRequests === 1) { response.destroy(); return; }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, ts: "1000.2" }));
      });
      return;
    }
    reads++;
    const cursor = url.searchParams.get("cursor");
    queried.push({ method: url.pathname, cursor });
    let json = { ok: true, messages: [{ text: "newer unrelated coordination", ts: "1001.1" }], has_more: true, response_metadata: { next_cursor: "older" } };
    if (scenario === "found-first") json = { ok: true, messages: posted, has_more: true, response_metadata: { next_cursor: "unread" } };
    else if (scenario === "absent") json = { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: "" } };
    else if ((scenario === "root" || scenario === "thread") && cursor === "older") json = { ok: true, messages: posted, has_more: true, response_metadata: { next_cursor: "unread" } };
    else if (scenario === "api-error" && cursor || scenario === "deadline" && deadlineProbed) json = { ok: false, error: "synthetic unreadable history" };
    else if (scenario === "missing-cursor") json.response_metadata.next_cursor = "";
    else if (scenario === "page-bound") json.response_metadata.next_cursor = `page-${reads}`;
    const send = () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(json)); };
    if (scenario === "deadline" && !deadlineProbed) {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 160);
      timers.add(timer);
    } else send();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const attempted = new SeenStore(join(home, scenario, "attempted.jsonl"));
    const delivered = new SeenStore(join(home, scenario, "delivered.jsonl"));
    const seen = new SeenStore(join(home, scenario, "seen.jsonl"));
    const fetchImpl = (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, init);
    const opts = { botToken: "synthetic-bot-token", channel: "C-FIXTURE", sourceLabel: "fixture", fetchImpl, attempted, delivered, outboundSeen: seen,
      ...(scenario === "thread" ? { resolveThreadTs: () => "900.1" } : {}) };
    const decision = { kind: "outbound_decision", decisionId: `d-pagination-${scenario}`, op: "queue-notification", entityBindingRef: "human#slack",
      payload: { qitemId: `q-pagination-${scenario}`, summary: "Decide X", body: "native recovery", destinationSession: "human@external", sourceSession: "fixture@kernel" } };
    assert.equal((await subsystemSlackDeliver(opts)(decision)).ok, false);
    assert.ok(attempted.load().has(decision.decisionId));
    if (scenario === "deadline") {
      // Two real delayed responses would each fit 250ms independently, but not
      // the scan's single total 250ms budget. Probe the actual production helper.
      const scan = await fetchRecentMessageTexts(opts.botToken, opts.channel, undefined, fetchImpl, 100, 250, reconcileToken(decision.decisionId));
      assert.equal(scan.ok, false);
      assert.equal(delivered.load().has(decision.decisionId), false);
      deadlineProbed = true;
    }
    const retry = await subsystemSlackDeliver({ ...opts, attempted: new SeenStore(join(home, scenario, "attempted.jsonl")) })(decision);
    if (group === "recovery") {
      assert.equal(retry.ok, true);
      assert.equal(posted.length, 1, "a landed first post is not duplicated");
      assert.equal(postRequests, scenario === "absent" ? 2 : 1);
      assert.equal(delivered.load().has(decision.decisionId), true);
      assert.equal(seen.load().has(decision.payload.qitemId), true);
      if (scenario === "root" || scenario === "thread") { assert.equal(reads, 2); assert.equal(queried[1].cursor, "older"); }
      else assert.equal(reads, 1);
      if (scenario === "thread") assert.ok(queried.every((query) => query.method === "/api/conversations.replies"));
    } else {
      assert.equal(retry.ok, false, "an incomplete search cannot prove absence");
      assert.equal(retry.class, "reconcile-unreadable");
      assert.equal(postRequests, 1, "no blind second post after incomplete search");
      assert.equal(posted.length, 1);
      assert.equal(delivered.load().has(decision.decisionId), false);
      assert.equal(seen.load().has(decision.payload.qitemId), false);
      assert.ok(reads <= 10, "unbounded/repeated cursors cannot loop forever");
    }
    results.push({ scenario, posts: posted.length, postRequests, reads, outcome: retry.ok, attempted: true });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
console.log(JSON.stringify(results));
