import { expect, it } from "vitest";
import { resolveServerFileReference, serverPathIsWithin } from "../src/lib/server-path.js";

it.each([
  ["/specs/agent/agent.yaml", "../guide.md", "/specs/guide.md"],
  ["/specs/agent/agent.yaml", "literal\\name.md", "/specs/agent/literal\\name.md"],
  ["C:\\specs\\agent\\agent.yaml", "../guide.md", "C:\\specs\\guide.md"],
  ["C:/specs/agent/agent.yaml", "..\\guide.md", "C:\\specs\\guide.md"],
  ["C:/specs/agent.yaml", "D:/other/guide.md", "D:\\other\\guide.md"],
  ["C:/specs/agent.yaml", "/guide.md", "C:\\guide.md"],
  ["\\\\host\\share\\agent\\agent.yaml", "../../guide.md", "\\\\host\\share\\guide.md"],
  ["\\\\?\\C:\\specs\\agent.yaml", "guide.md", "\\\\?\\C:\\specs\\guide.md"],
  ["\\\\?\\UNC\\host\\share\\agent.yaml", "guide.md", "\\\\?\\UNC\\host\\share\\guide.md"],
  ["C:/specs/agent.yaml", "C:guide.md", null],
  ["relative/agent.yaml", "guide.md", null],
  ["/specs/agent.yaml", "bad\0.md", null],
])("resolves host path %s + %s", (source, ref, expected) => {
  expect(resolveServerFileReference(source, ref)).toBe(expected);
});

it("matches whole normalized path segments without merging case-distinct entries", () => {
  expect(serverPathIsWithin("C:/specs/agent/agent.yaml", "C:\\specs\\agent")).toBe(true);
  expect(serverPathIsWithin("C:/specs/agent-other/agent.yaml", "C:/specs/agent")).toBe(false);
  expect(serverPathIsWithin("/specs/Agent/agent.yaml", "/specs/agent")).toBe(false);
  expect(serverPathIsWithin("D:/specs/agent/agent.yaml", "C:/specs/agent")).toBe(false);
});
