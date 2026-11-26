import { describe, it } from "vitest";
import { expectCaught, hasTmux } from "./helpers/runner-conformance.js";

// Each break in cases 1 to 9 other than 4b (runner-conformance-ask-*), the case that must catch it, and the check in that
// case that names it.
describe.skipIf(!hasTmux)("the runner conformance check", () => {
  // Each mutation launches many tmux sessions; overlap can fail startup before reaching the intended break.
  it.each([
    ["record-early", "1", "no launch record while session/new is still unanswered"],
    ["record-on-failure", "1b", "no conversation in a launch record"],
    ["split-lines", "2", "one pasted block is exactly one session/prompt"],
    ["abort-in-block", "2", "a line reading /abort inside a block isn't control"],
    ["no-queue", "2", "a block sent mid-turn waits for the next turn"],
    ["cancelled-always", "2", "cancelled is reported only on the agent's own stop reason"],
    ["ctrl-c-ignored", "2", "Ctrl-C outside a paste sends session/cancel"],
    ["no-token", "3", "every post uses the hook token"],
    ["no-sequence", "3", "every post carries the contract's fields"],
    ["refuse-on-404", "4", "404: the agent gets its allow_once option"],
    ["prefer-always", "4", "404: the agent gets its allow_once option"],
    ["refuse-on-unreachable", "4", "unreachable: the agent gets its allow_once option"],
    ["permit-on-deny", "4", "denied_by_seat: the answer is a refusal, never an allow option"],
    ["stop-while-attention", "4", "denied_by_seat: no idle Stop or beat while holding that attention"],
    ["release-refusal-on-abort", "4", "denied_by_seat, then /abort: no idle Stop or beat while holding that attention"],
    ["silent-permission", "4", "denied_by_seat: what was asked is shown in the pane"],
    ["wrong-generation", "5", "generation is OPENRIG_OCCUPANT_GENERATION on every post"],
    ["new-on-resume", "6", "other failure: no new conversation starts"],
    ["missing-on-any-error", "6", "other failure: not reported missing or resumed"],
    ["idle-on-exit", "7", "no idle report for the turn it died in"],
    // An idle Stop numbered below the turn's accepted prompt but later in time: OpenRig orders by time first, so it counts.
    ["idle-low-sequence-on-exit", "7", "no idle report for the turn it died in"],
    // An idle Stop at the accepted prompt's time with a string sequence: OpenRig reads no sequence there, so it counts.
    ["idle-string-sequence-on-exit", "7", "no idle report for the turn it died in"],
    ["no-error-post", "7b", "a failed session/prompt posts Notification/runtime_error"],
    ["ignore-unknown", "8", "the unknown request is answered -32601"],
    ["first-input-trim", "9", "the first prompt is the file's bytes, newlines and spaces included"],
  ])("catches %s in case %s", (broken, id, name) => expectCaught(broken, id, name), 90_000);
});
