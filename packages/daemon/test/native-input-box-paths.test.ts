import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readInputBox, readSeatBeforePaste } from "../src/domain/session-transport.js";

const root = new URL("./fixtures/input-box/codex-0.160.0/", import.meta.url);
const original = "~/workspace1/capture/composer-demo/work";
const frame = (name: string, location: string) => readFileSync(new URL(name + ".txt", root), "utf8").replaceAll(original, location);
it.each([String.raw`C:\Users\fixture\workspace`, "D:/work/用户 project", String.raw`\\server\share\project`])("reads an edited native Codex frame at %s without discarding draft evidence", location => {
  expect(readSeatBeforePaste(frame("product-path-idle.J", location), "codex")).toBe("idle");
  const text = "Queue handoff: qitem-capture-0001 - check your queue.";
  expect(readInputBox(frame("product-path-staged-short.J", location), "codex", text)).toBe("exact");
  // A populated box remains unknown, as in the original recorded frame; it
  // must never be promoted to an idle seat merely by recognizing its path.
  expect(readSeatBeforePaste(frame("product-path-staged-short.J", location), "codex")).toBe("unknown");
  const claude = readFileSync(new URL("./fixtures/input-box/claude-code-2.1.296/idle-fresh-suggestion.txt", import.meta.url), "utf8");
  expect(readSeatBeforePaste(claude.replaceAll(original, location), "claude-code")).toBe("idle");
});

it.each(["C:relative", "\\rooted", "\\\\server"])("does not recognize incomplete native location %s", location => {
  expect(readSeatBeforePaste(frame("product-path-idle.J", location), "codex")).toBe("unknown");
  expect(readInputBox(frame("product-path-staged-short.J", location), "codex", "anything")).toBe("unrecognized");
});
