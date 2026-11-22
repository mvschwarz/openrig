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
// current head, the matrix holds one placeholder entry whose check name is not a required context.

import { appendFileSync, readFileSync } from "node:fs";

export const MACOS_ENTRIES = [
  { package: "daemon", os: "macos-latest", check: "package-tests (daemon)" },
  { package: "cli", os: "macos-latest", check: "package-tests (cli)" },
];
export const PLACEHOLDER_CHECK = "review-ready macOS (not triggered)";
const COUNTING_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SHA = /^[0-9a-f]{40}$/;

function placeholder(reason) {
  return { eligible: false, reason, head: "", matrix: [{ package: "none", os: "ubuntu-latest", check: PLACEHOLDER_CHECK }] };
}

export function planMacosPackageTests(eventName, event) {
  if (eventName === "workflow_dispatch") {
    // A manual run on a branch. Its check runs don't satisfy a required check in a ruleset; it's for trying the suites.
    return { eligible: true, reason: "manual run", head: "", matrix: MACOS_ENTRIES };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const plan = planMacosPackageTests(eventName, event);
  const lines = [`eligible=${plan.eligible}`, `head=${plan.head}`, `matrix=${JSON.stringify(plan.matrix)}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  const summary = plan.eligible ? `macOS package suites run: ${plan.reason}.` : `macOS package suites not run: ${plan.reason}.`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}
