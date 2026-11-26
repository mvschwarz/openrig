// Decides whether a run of the review-ready macOS workflow tests the macOS package suites, and for which head.
//
// The two macOS package suites (daemon, cli) are required checks, but they run only for a head a maintainer has
// approved, not for every push during review rounds. The approval is a pull_request_review event whose review
// names the commit it approved (`review.commit_id`); the suites run only when that commit is still the pull
// request's head. A push after the approval leaves the new head without these checks, so it can't merge until a
// maintainer approves the new head, and readiness for one commit never applies to another.
//
// The matrix is never empty and no entry is ever skipped by a job-level condition, because GitHub reports a skipped
// job as successful and that would satisfy a required check without a test. When the event isn't an approval of the
// current head, the matrix holds one placeholder entry whose check name is not a required context. A manual run tests
// the suites under names that aren't required either, so only an approval of the current head reports the required ones.
//
// Eligible reviews queue by PR and head without replacing pending runs. The live planner discards stale events,
// reuses a completed pair of real suites, and cancels only older review runs for this PR's obsolete heads.

import { appendFileSync, readFileSync } from "node:fs";

export const MACOS_ENTRIES = [
  { package: "daemon", os: "macos-latest", check: "package-tests (daemon)" },
  { package: "cli", os: "macos-latest", check: "package-tests (cli)" },
];
export const MANUAL_ENTRIES = [
  { package: "daemon", os: "macos-latest", check: "macOS manual run (daemon)" },
  { package: "cli", os: "macos-latest", check: "macOS manual run (cli)" },
];
export const PLACEHOLDER_CHECK = "review-ready macOS (not triggered)";
const COUNTING_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SHA = /^[0-9a-f]{40}$/;

const placeholder = (reason) => ({ eligible: false, reason, head: "",
  matrix: [{ package: "none", os: "ubuntu-latest", check: PLACEHOLDER_CHECK }] });

export function planMacosPackageTests(eventName, event) {
  if (eventName === "workflow_dispatch") {
    // A manual run tests the dispatched branch as it is, under names no required check uses.
    return { eligible: false, reason: "manual run under non-required names", head: "", matrix: MANUAL_ENTRIES };
  }
  if (eventName !== "pull_request_review") return placeholder(`event ${eventName || "(none)"} doesn't run the macOS suites`);
  if (event?.action !== "submitted") return placeholder(`review action ${event?.action ?? "(none)"} isn't a submitted review`);
  const review = event.review ?? {};
  const head = event.pull_request?.head?.sha;
  if (String(review.state ?? "").toLowerCase() !== "approved") return placeholder(`review state ${review.state ?? "(none)"} isn't an approval`);
  if (!COUNTING_ASSOCIATIONS.has(review.author_association)) {
    return placeholder(`an approval from ${review.author_association ?? "(unknown)"} doesn't count toward merging`);
  }
  if (!SHA.test(String(review.commit_id ?? "")) || !SHA.test(String(head ?? ""))) return placeholder("the approved commit or the head is missing");
  if (review.commit_id !== head) return placeholder(`the approval names ${review.commit_id}, but the head is now ${head}`);
  return { eligible: true, reason: `approval of the current head ${head}`, head, matrix: MACOS_ENTRIES };
}

const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];

// Kept in this workflow's planner: GitHub's native per-head queue owns ordering, not another scheduler.
export async function reconcileMacosPackageTests(eventName, event, runId, api, log = console.log) {
  const plan = planMacosPackageTests(eventName, event);
  if (!plan.eligible) return plan; // Comments, non-counting approvals and manual runs make no cancellation calls.
  const number = event.pull_request.number;
  const current = await api(`/actions/runs/${runId}`);
  // Fork runs may omit pull_requests. The current event binds its own run; peers also need the workflow's immutable
  // PR-number title: one fork branch can open PRs against different bases. Unmarked legacy peers stay unknown.
  const forkRepo = event.pull_request.head?.repo?.full_name;
  const fromFork = !!forkRepo && !!event.repository?.full_name && forkRepo !== event.repository.full_name;
  const isThisPR = run => run.workflow_id === current.workflow_id && run.event === "pull_request_review"
    && (run.pull_requests?.some(pr => pr.number === number) || (fromFork && !run.pull_requests?.length
      && run.head_repository?.full_name === forkRepo && run.head_branch === event.pull_request.head.ref
      && (run.id === current.id || run.display_title === `macOS package tests PR #${number}`)));
  if (!isThisPR(current) || current.head_sha !== plan.head) throw new Error("Run identity does not match the approved PR head");
  const live = () => api(`/pulls/${number}`);
  const isCurrent = pr => pr.state === "open" && pr.head?.sha === plan.head;
  if (!isCurrent(await live())) return placeholder("the approved event is no longer the open PR's current head");
  const review = await api(`/pulls/${number}/reviews/${event.review.id}`);
  if (!planMacosPackageTests(eventName, { ...event, review }).eligible) return placeholder("the triggering approval no longer counts");
  async function list(path, field) {
    const values = [];
    for (let page = 1; ; page++) {
      const result = await api(`${path}&per_page=100&page=${page}`);
      values.push(...result[field]);
      if (result[field].length < 100) return values;
    }
  }
  const runsPath = `/actions/workflows/${current.workflow_id}/runs?event=pull_request_review`;
  // Never cancel a later run, even if this planner was delayed or its old attempt was rerun after a newer approval.
  const obsolete = run => isThisPR(run) && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_number)
    && SHA.test(run.head_sha) && run.run_number < current.run_number && run.head_sha !== plan.head
    && ACTIVE.includes(run.status);
  const visited = new Set();
  for (const status of ACTIVE) {
    for (const run of await list(`${runsPath}&status=${status}`, "workflow_runs")) {
      if (!obsolete(run) || visited.has(run.id)) continue;
      visited.add(run.id);
      const target = await api(`/actions/runs/${run.id}`); // latest attempt, not an earlier attempt's status
      if (!obsolete(target)) continue;
      if (!isCurrent(await live())) return placeholder("the PR head moved while obsolete runs were being reconciled");
      try {
        const result = await api(`/actions/runs/${target.id}/cancel`, "POST");
        log(`Cancellation accepted: run ${target.id}, attempt ${target.run_attempt}, obsolete head ${target.head_sha}: HTTP ${result.status}`);
      } catch (error) {
        // A refusal is evidence, never permission to force-cancel or suppress the new head's suites.
        log(`::warning::Could not cancel obsolete run ${target.id}: ${error.message}`);
      }
    }
  }
  // Native queue:max keeps repeat approvals waiting behind the useful run. Only its actual two passing jobs permit
  // a repeat to use a non-required placeholder. Explicit retries still execute both suites on the current head.
  if (Number(current.run_attempt) === 1) {
    const completed = (await list(`${runsPath}&status=completed&head_sha=${plan.head}`, "workflow_runs"))
      .filter(run => isThisPR(run) && run.head_sha === plan.head && run.id !== current.id);
    // A later failed attempt must not be hidden by an earlier pass. Unknown ordering means run the suites again.
    if (completed.every(run => Number.isFinite(Date.parse(run.updated_at)))) {
      completed.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id);
      for (const run of completed) {
        const jobs = await list(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?filter=latest`, "jobs");
        if (!jobs.some(job => MACOS_ENTRIES.some(entry => entry.check === job.name))) continue;
        if (run.conclusion === "success" && MACOS_ENTRIES.every(entry => jobs.some(job => job.name === entry.check && job.status === "completed" && job.conclusion === "success"))) {
          return placeholder(`both required macOS suites already passed on this head in run ${run.id}, attempt ${run.run_attempt}`);
        }
        break; // The latest real suite run failed, was canceled, or was incomplete: this approval must cover it.
      }
    }
  }
  if (!isCurrent(await live())) return placeholder("the PR head moved before its suites were admitted");
  return plan;
}

export function githubApi(repository, token, apiUrl = "https://api.github.com", request = fetch) {
  if (!token) throw new Error("GITHUB_TOKEN is required for live macOS planning");
  return async (path, method = "GET") => {
    const response = await request(`${apiUrl}/repos/${repository}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
      signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${await response.text()}`);
    return method === "POST" ? { status: response.status } : response.json();
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const initial = planMacosPackageTests(eventName, event);
  const plan = initial.eligible ? await reconcileMacosPackageTests(eventName, event, process.env.GITHUB_RUN_ID,
    githubApi(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN, process.env.GITHUB_API_URL)) : initial;
  const lines = [`eligible=${plan.eligible}`, `head=${plan.head}`, `matrix=${JSON.stringify(plan.matrix)}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  const summary = plan.eligible ? `Required macOS package suites run: ${plan.reason}.` : `Required macOS package suites not run: ${plan.reason}.`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}
