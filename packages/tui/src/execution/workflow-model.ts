import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { fieldLine, listItem, sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { Action } from "../types.js";
import type { ExecutionViewSnap } from "./execution-model.js";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const text = (v: unknown, missing = "not recorded"): string => typeof v === "string" && v.length ? v : v == null ? missing : JSON.stringify(v);
const open = (key: string): Action => ({ type: "execution-open", key });
const words = (v: unknown) => text(v, "unknown step").replaceAll("-", " ");
const packets = (instance: Row) => rows(instance.frontier_packets);
const title = (instance: Row) => text(instance.description, "Mission lifecycle");
const field = (label: string, value: unknown, link?: Action) => fieldLine({ label, value: text(value), ...(link ? { link } : {}) });
// The daemon writes the epoch as a wake-now marker when a blocker changes (#860); it is not a check time.
const lastCheck = (value: unknown, timeZone: string) => typeof value === "string" && Date.parse(value) === 0 ? "wake pending" : displayTime(value, timeZone);

export function workflowOverview(execution: ExecutionViewSnap, width: number): ContentLine[] {
  const instances = execution.lifecycle_instances;
  if (!instances?.length) return [{ text: "" }, { text: instances ? "  Workflows: none bound to this mission" : "  Workflows: projection unavailable" }];
  const lines: ContentLine[] = [{ text: "" }, sectionRule("WORKFLOWS", width)];
  for (const instance of [...instances].sort((a, b) => Number(["completed", "aborted"].includes(text(a.status))) - Number(["completed", "aborted"].includes(text(b.status))))) {
    lines.push(listItem(`${title(instance)} · ${text(instance.status, "unknown")}`, open(`workflow:${instance.instance_id}`)));
    for (const packet of packets(instance)) {
      lines.push(listItem(`${words(packet.step_id)} · ${text(packet.queue_state)} · ${text(packet.owner)}`, open(`packet:${packet.packet_id}`), 4));
      const transition = row(packet.latest_transition);
      if (packet.queue_state === "blocked") lines.push({ text: `      Wait: ${text(row(packet.blocker).summary ?? transition.transition_note, "reason not recorded; open work for blocker and wake")}` });
    }
  }
  return wrapDetailLines(lines, width);
}

/** All claims are served state or attributed records. No receipt is adjudicated here. */
export function workflowDetail(execution: ExecutionViewSnap, key: string, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] | null {
  const instances = execution.lifecycle_instances ?? [];
  const packetId = key.startsWith("packet:") ? key.slice(7) : null;
  const instance = packetId ? instances.find((i) => packets(i).some((p) => p.packet_id === packetId)) : instances.find((i) => `workflow:${i.instance_id}` === key);
  if (!instance) return null;
  const identity = row(instance.identity);
  const packet = packetId ? packets(instance).find((p) => p.packet_id === packetId)! : null;
  const lines: ContentLine[] = [
    { text: packet ? `Work · ${words(packet.step_id)}` : `${title(instance)} · ${text(instance.status)}` },
    field("mission", execution.mission, { type: "scopes-mission-open", mission: execution.mission }),
    field("project", identity.project),
    field("as of", displayTime(execution.derived_at, timeZone)),
  ];
  if (packet) {
    const transition = row(packet.latest_transition);
    const wake = row(packet.wake);
    const schedule = row(packet.wake_schedule);
    lines.push(field("purpose", packet.objective), field("summary", packet.summary), field("state", packet.queue_state));
    // The rendered owner remains the canonical address; navigation uses the existing
    // resolver, which names unavailable/ambiguous seats rather than choosing a twin.
    lines.push(field("owner", packet.owner, { type: "drill", resource: "agent", name: text(packet.owner) }));
    lines.push(sectionRule("Waiting and continuation", width), field("last change", transition.transition_note), field("recorded by", transition.actor_session), field("at", displayTime(transition.ts, timeZone)));
    if (packet.blocked_on) lines.push(field("blocker", packet.blocked_on));
    if (packet.blocker) {
      const blocker = row(packet.blocker);
      lines.push(field("waiting for", blocker.summary), field("blocker state", blocker.state), field("blocker owner", blocker.destination_session), field("evidence", blocker.evidence_ref));
    }
    lines.push(field("wake", packet.wake ? `${text(wake.kind)} · ${text(wake.phase)} · ${wake.live ? "live" : "not live"}${wake.unconsumed ? " · fired without pickup" : ""}` : "none recorded"));
    if (packet.wake) lines.push(field("wake ref", wake.ref), field("delivery", wake.deliveryStatus));
    if (wake.expiresAt) lines.push(field("due", displayTime(wake.expiresAt, timeZone)));
    if (packet.wake_schedule) lines.push(field("policy", schedule.policy), field("cadence", `${text(schedule.interval_seconds)} seconds (a check, not guaranteed delivery)`), field("last check", lastCheck(schedule.last_evaluation_at, timeZone)));
    lines.push(sectionRule("Next action", width), ...actionLines(text(packet.targeted_action), width));
    if (packet.gate) lines.push(field("gate", packet.gate));
    if (packet.acceptance) lines.push(field("decision", packet.acceptance));
    lines.push(field("evidence", packet.evidence_ref), field("packet", packet.packet_id), listItem("Workflow, obligations and bound sources", open(`workflow:${instance.instance_id}`)));
  } else {
    lines.push(sectionRule("Current work", width));
    for (const current of packets(instance)) lines.push(listItem(`${words(current.step_id)} · ${text(current.queue_state)} · ${text(current.owner)}`, open(`packet:${current.packet_id}`)));
    if (!packets(instance).length) lines.push({ text: `  No current work packet · workflow ${text(instance.status)}. This is lifecycle state, not product acceptance.` });
    const steps = rows(instance.steps);
    const obligations = rows(instance.boundary_obligations);
    const hasBoundary = obligations.some((o) => o.stepId === "release-boundary");
    lines.push(sectionRule(hasBoundary ? "Release ceremony and post-release housekeeping" : "Obligations", width), { text: "  Receipt recorded means an attributed evidence reference was recorded; it does not establish acceptance." });
    for (const obligation of obligations) {
      const label = obligation.stepId === "release-boundary" ? "Post-release housekeeping · release boundary" : obligation.stepId === "activate-successor" ? "Optional successor · activate successor" : words(obligation.stepId);
      lines.push({ text: `  ${label} · ${obligation.required ? "required" : "extension"} · ${text(obligation.state)} · receipt ${text(obligation.receiptState)}` });
      const step = steps.find((s) => s.id === obligation.stepId);
      if (step?.objective) lines.push({ text: `    ${text(step.objective)}` });
      const receipt = row(obligation.receipt);
      if (obligation.receipt) lines.push(field("evidence", receipt.evidenceRef), field("recorded by", receipt.actorSession), field("at", displayTime(receipt.closedAt, timeZone)));
    }
    const dependencies = rows(instance.dependencies);
    // Do not infer successor semantics from an arbitrary step name. Show the
    // compiler's declared dependency graph and the end of the current workflow.
    lines.push(sectionRule("Continuation", width));
    if (hasBoundary) lines.push({ text: obligations.some((o) => o.stepId === "activate-successor") ? "  Successor activation is authored after the release boundary." : "  No successor activation step is bound. This workflow ends after its own release boundary." });
    for (const dependency of dependencies) lines.push(field(words(dependency.stepId), dependency.dependsOn));
    lines.push({ text: "  An optional successor is separate from completing this workflow; only authored steps above are obligations." });
    lines.push(sectionRule("Bound graph and sources", width), field("workflow", instance.workflow_name), field("version", instance.workflow_version), field("graph", instance.graph_source), { text: instance.reconciliation ? "  Bound source receipts are retained; the authored/running comparison below explains current changes." : "  Sources are bound at compilation. Current source bytes have not been compared." });
    for (const source of rows(instance.sources)) {
      if (source.kind === "slice" && typeof source.path === "string") {
        const parts = source.path.split("/");
        const slice = parts.at(-2);
        if (slice) lines.push(listItem(`Slice ${slice}`, { type: "scopes-open", mission: execution.mission, slice }));
      }
      for (const [label, value] of Object.entries(source)) lines.push(field(label, value));
    }
    const comparison = row(instance.reconciliation);
    if (instance.reconciliation) {
      lines.push(sectionRule("Authored and running plan", width), field("comparison", comparison.status),
        field("bound input", comparison.boundDigest), field("authored input", comparison.proposedDigest),
        field("composition", row(comparison.composition).explanation));
      if (comparison.status === "source-only") lines.push({ text: "  Source bytes changed; executable steps/policy are unchanged. No completed work needs replay." });
      for (const reason of Array.isArray(comparison.reasons) ? comparison.reasons : []) lines.push(field("reason", reason));
      lines.push(...actionLines(text(comparison.nextAction), width));
      if (comparison.applyCommand) lines.push(...actionLines(text(comparison.applyCommand), width));
      lines.push({ text: "  Inspect first; the plan can change. A lost response is recoverable with rig workflow operation <key>." });
    }
    lines.push(field("input digest", instance.compiled_input_digest));
    for (const failure of rows(instance.failure_occurrences)) if (failure.status === "unresolved") lines.push(sectionRule("Unresolved failure", width), field("step", failure.step_id), field("reason", failure.failure_reason), field("occurrence", failure.occurrence_id), ...actionLines(text(failure.targeted_action), width));
    for (const unknown of Array.isArray(instance.unknowns) ? instance.unknowns : []) lines.push(field("unknown", unknown));
    lines.push(field("instance", instance.instance_id), field("operation", instance.operation_key));
  }
  lines.push({ text: "" }, listItem("Back · Esc", { type: "back" }));
  return wrapDetailLines(lines, width);
}

/** Keep lifecycle commands complete in the scrollable pane. Shell continuations make the
 * visual wrap usable as one command instead of turning the hidden suffix into guesswork. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      word += char;
      escaped = true;
    } else if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      word += char;
      quote = quote === char ? null : char;
    } else if (/\s/.test(char) && quote === null) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Split only words emitted by the daemon's shellQuote helper. A continuation directly
 * between adjacent quoted chunks is one shell argument; option-to-option continuations
 * retain a separating space. */
function splitQuotedWord(word: string, maxWidth: number): string[] | null {
  if (!word.startsWith("'") || !word.endsWith("'")) return null;
  const value = word.slice(1, -1).replaceAll(`'"'"'`, "'");
  if (quoteShell(value) !== word) return null;
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (chunk && quoteShell(chunk + char).length > maxWidth) {
      chunks.push(quoteShell(chunk));
      chunk = char;
    } else {
      chunk += char;
    }
  }
  chunks.push(quoteShell(chunk));
  return chunks;
}

function actionLines(action: string, width: number): ContentLine[] {
  const firstIndent = "      action ";
  const nextIndent = "        ";
  const room = Math.max(width, 24);
  const parts = shellWords(action);
  const lines: ContentLine[] = [];
  let current = `${firstIndent}${parts.shift() ?? ""}`;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const more = index < parts.length - 1;
    if (current && `${current} ${part}${more ? " \\" : ""}`.length <= room) {
      current += ` ${part}`;
      continue;
    }
    if (current) lines.push({ text: `${current} \\` });
    const chunks = splitQuotedWord(part, room - 2);
    if (chunks && `${nextIndent}${part}${more ? " \\" : ""}`.length > room) {
      for (let chunkIndex = 0; chunkIndex < chunks.length - 1; chunkIndex++) {
        lines.push({ text: `${chunks[chunkIndex]!}\\` });
      }
      const last = chunks[chunks.length - 1]!;
      if (more) {
        lines.push({ text: `${last} \\` });
        current = "";
      } else {
        current = last;
      }
    } else {
      current = `${nextIndent}${part}`;
    }
  }
  if (current) lines.push({ text: current });
  return lines;
}
