import { formatHumanAnswers, type HumanAnswers, type HumanQuestion, type TypedHumanReply } from "./human-questions.js";

export interface RelaySubmission {
  readonly attributedTo: string;
  readonly text: string;
  readonly channel: string;
  readonly questionId?: string;
  readonly optionId?: string;
  readonly answeredAt?: string;
}

interface AnswerRecord {
  readonly by: string;
  readonly at: string;
  readonly text: string;
  readonly questionId: string | null;
  readonly optionId?: string;
}

export interface RelayedAnswer extends AnswerRecord {
  readonly kind: "relayed-answer";
  readonly recordedBy: string;
  readonly channel: string;
  readonly answeredAt?: string;
}

export interface DirectAnswer extends AnswerRecord {
  readonly kind: "direct-answer";
  readonly placement?: TypedHumanReply["placement"];
  readonly eventId?: string;
}

export interface DirectCorrection extends AnswerRecord {
  readonly kind: "direct-correction";
  readonly placement?: TypedHumanReply["placement"];
  readonly qitemId: string;
  readonly eventId?: string;
}

export interface UnplacedReply extends AnswerRecord {
  readonly kind: "unplaced-reply";
  readonly qitemId: string;
  readonly eventId?: string;
}

export interface RelayJournal {
  readonly relays: readonly RelayedAnswer[];
  readonly corrections: readonly DirectCorrection[];
  readonly directAnswers?: readonly DirectAnswer[];
  readonly unplacedReplies?: readonly UnplacedReply[];
  readonly returnId: string | null;
}

export interface RelayedAnswerReceipt {
  readonly item: import("./queue-repository.js").QueueItem;
  readonly replyQitemId: string | null;
  readonly unanswered: string[];
  readonly historyOnly?: true;
  readonly corrected?: boolean;
  readonly unplaced?: boolean;
}

export type RelayAnswerWrite = {
  readonly qitemId: string;
  readonly actorSession: string;
  readonly identityProvenance?: string;
  readonly identityPrincipal?: string;
  readonly nudge?: boolean;
} & ({ readonly relay: RelaySubmission } | {
  readonly direct: {
    readonly questionId?: string;
    readonly optionId?: string;
    readonly text?: string;
    readonly primaryUser?: boolean;
    readonly eventId?: string;
    readonly recovering?: boolean;
    readonly attachments?: { readonly body: string; readonly tag: string };
  };
});

export type ReturnedRelayAnswer = ((RelayedAnswer | DirectAnswer) & { readonly qitemId: string | null }) | DirectCorrection | UnplacedReply;

export function renderRelayedAnswers(journal: RelayJournal, questions: readonly HumanQuestion[], direct: HumanAnswers): string {
  return [...journal.relays.filter(relay => !journal.corrections.some(answer => answer.questionId === relay.questionId)).map(relay => {
    const target = relay.questionId === null ? "" : `; question ${relay.questionId}${relay.optionId ? `, option ${relay.optionId}` : ""}`;
    return `RELAYED answer attributed to ${relay.by}; recorded by ${relay.recordedBy} via ${JSON.stringify(relay.channel)} at ${relay.at}${relay.answeredAt ? `; answered at ${relay.answeredAt}` : ""}${target}:\n${relay.text}`;
  }), ...formatHumanAnswers(questions, direct).map(line => `Direct answer: ${line}`)].join("\n\n");
}
