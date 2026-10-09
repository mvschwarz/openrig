// #193 — structured questions a decision may carry: 1–4 questions, each with 2–4 options the
// human can click in Slack. The validated shape is stored on the item; each click records one
// answer, and the decision resolves once every question has one. Limits follow Slack Block Kit:
// a button's plain_text is at most 75 characters.

export interface HumanQuestionOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface HumanQuestion {
  id: string;
  question: string;
  options: HumanQuestionOption[];
}

/** A whole thread reply, not a button choice or a human-selected question. */
export interface TypedHumanReply {
  kind: "typed-reply";
  text: string;
  placement: "first-unanswered";
  /** Other question slots still empty immediately after this reply's placement. */
  unansweredCount: number;
}

/** questionId → chosen optionId (string) or explicitly tagged whole typed reply. */
export type HumanAnswers = Record<string, string | TypedHumanReply>;

/** The outcome of recording one clicked answer (QueueRepository.recordHumanAnswer). */
export type RecordHumanAnswerResult =
  | { status: "recorded"; answers: HumanAnswers; complete: boolean; questions: HumanQuestion[] }
  /** answerOnRecord: the decision is no longer pending, and this asked human's clicked answer is the one it holds. */
  | { status: "not-applicable"; reason: string; answerOnRecord?: true };

export const MAX_HUMAN_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_OPTION_LABEL = 75; // Slack button text limit
export const MAX_QUESTION_TEXT = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RULE = 'id must be 1–40 letters, digits, "-" or "_".';

export type HumanQuestionsParse = { ok: true; questions: HumanQuestion[] } | { ok: false; error: string };

/** Validate an authored questions value. Returns a normalized copy (only known fields kept). */
export function parseHumanQuestions(value: unknown): HumanQuestionsParse {
  const fail = (error: string): HumanQuestionsParse => ({ ok: false, error });
  if (!Array.isArray(value)) return fail("humanQuestions must be an array of questions.");
  if (value.length < 1 || value.length > MAX_HUMAN_QUESTIONS) return fail(`Ask 1 to ${MAX_HUMAN_QUESTIONS} questions (got ${value.length}).`);
  const questionIds = new Set<string>();
  const questions: HumanQuestion[] = [];
  for (const [questionIndex, raw] of value.entries()) {
    const q = (raw ?? {}) as Record<string, unknown>;
    const where = `question ${questionIndex + 1}`;
    if (typeof q.id !== "string" || !ID_PATTERN.test(q.id)) return fail(`${where}: ${ID_RULE}`);
    if (questionIds.has(q.id)) return fail(`${where}: duplicate question id "${q.id}".`);
    questionIds.add(q.id);
    if (typeof q.question !== "string" || !q.question.trim()) return fail(`${where}: question text is required.`);
    if (q.question.length > MAX_QUESTION_TEXT) return fail(`${where}: question text is over ${MAX_QUESTION_TEXT} characters.`);
    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      return fail(`${where}: give ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`);
    }
    const optionIds = new Set<string>();
    const options: HumanQuestionOption[] = [];
    let recommended = 0;
    for (const [optionIndex, rawOption] of q.options.entries()) {
      const o = (rawOption ?? {}) as Record<string, unknown>;
      const optionWhere = `${where} option ${optionIndex + 1}`;
      if (typeof o.id !== "string" || !ID_PATTERN.test(o.id)) return fail(`${optionWhere}: ${ID_RULE}`);
      if (optionIds.has(o.id)) return fail(`${optionWhere}: duplicate option id "${o.id}".`);
      optionIds.add(o.id);
      if (typeof o.label !== "string" || !o.label.trim()) return fail(`${optionWhere}: label is required.`);
      if (o.label.length > MAX_OPTION_LABEL) return fail(`${optionWhere}: label is over Slack's ${MAX_OPTION_LABEL}-character button limit.`);
      if (o.recommended != null && typeof o.recommended !== "boolean") return fail(`${optionWhere}: recommended must be true or false.`);
      if (o.recommended) recommended++;
      options.push(o.recommended ? { id: o.id, label: o.label, recommended: true } : { id: o.id, label: o.label });
    }
    if (recommended > 1) return fail(`${where}: mark at most one option as recommended.`);
    questions.push({ id: q.id, question: q.question, options });
  }
  return { ok: true, questions };
}

/** The recorded answer for a question. Own keys only: a question id like "constructor" must
 *  not read the inherited Object.prototype member as an answer. */
function ownAnswer(answers: HumanAnswers, questionId: string): string | TypedHumanReply | undefined {
  return Object.prototype.hasOwnProperty.call(answers, questionId) ? answers[questionId] : undefined;
}

export function describeTypedReplyPlacement(question: HumanQuestion, reply: TypedHumanReply): string {
  return `Whole typed reply, automatically placed under first unanswered question ${JSON.stringify(question.question)}; ${reply.unansweredCount} question${reply.unansweredCount === 1 ? "" : "s"} left unanswered`;
}

/** Button choices use option labels; typed replies keep their words and placement provenance. */
export function formatHumanAnswers(questions: readonly HumanQuestion[], answers: HumanAnswers): string[] {
  return questions.flatMap((q) => {
    const answer = ownAnswer(answers, q.id);
    if (answer == null) return [];
    if (typeof answer !== "string") return [`${describeTypedReplyPlacement(q, answer)}: ${answer.text}`];
    return [`${q.question}: ${q.options.find((o) => o.id === answer)?.label ?? answer}`];
  });
}

/** The questions still waiting for an answer. */
export function unansweredQuestions(questions: readonly HumanQuestion[], answers: HumanAnswers): HumanQuestion[] {
  return questions.filter((q) => ownAnswer(answers, q.id) == null);
}
