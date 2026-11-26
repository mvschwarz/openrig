import { describe, it } from "vitest";
import { expectCaught, hasTmux } from "./helpers/runner-conformance.js";

// Case 4b, the ask a person answers: breaks in submitting the ask and in what is delivered to the agent as its answer.
describe.skipIf(!hasTmux)("the runner conformance check", () => {
  // Each mutation launches many tmux sessions; overlap can fail startup before reaching the intended break.
  it.each([
    ["no-submit", "4b", "allow: the request is submitted to /api/activity/permission-requests"],
    ["wrong-request-id", "4b", "requestId is the agent's JSON-RPC id"],
    ["self-prompt", "4b", "OpenRig records the prompt; the runner doesn't post permission_prompt itself"],
    ["deliver-twice", "4b", "allow: it's delivered once"],
    ["refuse-on-refusal", "4b", "duplicate_request: the agent gets its allow_once option"],
    ["late-deliver", "4b", "pending: an answer after the withdraw isn't delivered"],
    ["paste-answers", "4b", "pending: a pasted message isn't an answer"],
    ["said-as-answer", "4b", "permitted at read, with the person's words: the agent gets its allow_once option"],
  ])("catches %s in case %s", (broken, id, name) => expectCaught(broken, id, name), 90_000);
});
