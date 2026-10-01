import { expect, it } from "vitest";
import { parseCodexJsonl } from "../src/restore-packet/codex-jsonl-parser.js";
import { parseClaudeTranscript } from "../src/restore-packet/claude-transcript-parser.js";

const invalid = ["null", "[]", '"unexpected string"', "23", "true", "{broken"];

it("keeps Codex messages around malformed JSONL records", () => {
  const message = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: text } });
  const parsed = parseCodexJsonl([message("before"), ...invalid, message("after")].join("\n"));
  expect(parsed.messages.map(message => message.text)).toEqual(["before", "after"]);
  expect(parsed.lineCount).toBe(8);
  expect(parsed.messageCount).toBe(2);
  expect(parsed.typeCounts).toEqual({ response_item: 2 });
});

it("keeps Claude messages around malformed JSONL records", () => {
  const message = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const parsed = parseClaudeTranscript([message("before"), ...invalid, message("after")].join("\n"));
  expect(parsed.messages.map(message => message.text)).toEqual(["before", "after"]);
  expect(parsed.lineCount).toBe(8);
  expect(parsed.messageCount).toBe(2);
  expect(parsed.typeCounts).toEqual({ user: 2 });
});
