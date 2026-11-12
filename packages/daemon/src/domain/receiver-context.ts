// What a receiving agent needs to act on a person's answer, in one place: what an answer typed at this machine means,
// how to ask the person back, and what closing a runner's request does. Text only: who is recorded as answering, and
// every state and policy, stay as they are.

/** An answer recorded as `unattributed` (typed at this machine's terminal or TUI): what it means for acting on it. */
export function terminalAnswerMeaning(unattributed: string): string {
  return `${unattributed} is how OpenRig records any answer typed at this machine's terminal or TUI: it can't tell who typed, so it names nobody. `
    + "It's the answer of whoever is at this machine, usually the person the request went to. Act on a clear answer with the request's own decision command, and don't ask them to confirm it.";
}

/** How to ask the person back when their answer is unclear or conditional: a new ask to the person the request went to,
 *  which reaches them where they answer. `asked` is null when that person isn't registered (any more): what to do then is
 *  the one open case, so it's this one sentence. */
export function askBackRoute(asked: string | null, unattributed: string, request: string): string {
  const nowhere = `Don't write to ${unattributed}: nothing is delivered there.`;
  if (asked) {
    return `If their answer is unclear or conditional, ask them back with an ask to ${asked} that names ${request}: `
      + `rig queue create --destination ${asked} --summary "<your question>" --body-file <file>. It reaches them where they answer (the Feed, Steering, and Slack when it's connected). ${nowhere}`;
  }
  return `If their answer is unclear or conditional, OpenRig can't ask them back: the person ${request} went to isn't registered. `
    + `Say so once, in this conversation, and keep the request and their answer waiting. The ways through are registering a person (rig gateway human add) or the request's own decision command. ${nowhere}`;
}

/** What closing a runner's permission request without a decision does: a kept answer waits (runner-permissions). */
export const RUNNER_CLOSE_WAITS = "Closing this item without deciding permits nothing: the person's answer stays kept and the runner keeps waiting until it's decided. "
  + "OpenRig's default permit applies only to a request nobody answered.";
